// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fábrica perezosa: el vi.fn() se declara antes del vi.mock (para que el test
// pueda configurarlo), pero la fábrica solo lo referencia DENTRO del cuerpo de
// la flecha que expone `fetchBcvHtml`, nunca en su propio cuerpo — si lo
// hiciera directamente, el hoisting de `vi.mock` lo ejecutaría antes de que
// `fetchBcvHtmlMock` exista (TDZ).
const fetchBcvHtmlMock = vi.fn();
vi.mock("@/lib/ai/bcv-fetch", () => ({
  fetchBcvHtml: (...args: unknown[]) => fetchBcvHtmlMock(...args),
}));

// Estado persistente de la lectura (T3, 21/11/2026): se mockea entero. Por
// defecto "no hay tabla" (lectura y registro devuelven null), que es el
// comportamiento de antes de la migración; cada test que prueba el registro
// fija lo que devuelve.
const registrarMock = vi.fn();
const leerEstadoMock = vi.fn();
vi.mock("@/lib/ai/bcv-status", () => ({
  registrarIntentoBcv: (...args: unknown[]) => registrarMock(...args),
  leerEstadoBcv: (...args: unknown[]) => leerEstadoMock(...args),
}));

import { log } from "@/lib/log";
import {
  BCV_FALLOS_PARA_ALERTA,
  BCV_FAILURE_BACKOFF_MS,
  getBcvRate,
  resetBcvFailureBackoffForTests,
} from "@/lib/ai/bcv";

interface FakeCachedRow {
  rate_date: string;
  usd_to_ves: number;
}

/**
 * HTML mínimo que las regex de bcv.ts aceptan: bloque `id="dolar"` con un
 * `<strong>` (la tasa) y, en cualquier parte de la página, "Fecha Valor:"
 * seguido de un atributo `content="YYYY-MM-DD"` (la fecha de vigencia). No es
 * una réplica de la página real — eso lo prueba el parseo en otra tarea; acá
 * solo hace falta que el caché reciba algo con lo que trabajar.
 */
const HTML_BCV_SIMULADO = `
  <div id="dolar">
    <div>
      <strong>775,33560000</strong>
    </div>
  </div>
  <span>Fecha Valor: <span content="2026-08-22T00:00:00-04:00">Sábado</span></span>
`;

/** Igual que arriba, pero sin la frase "Fecha Valor:" — la página respondió sin decir desde cuándo rige. */
const HTML_BCV_SIN_FECHA_VALOR = `
  <div id="dolar">
    <div>
      <strong>775,33560000</strong>
    </div>
  </div>
`;

/**
 * Fake de Supabase que distingue las DOS consultas de `getBcvRate` por la
 * columna de `order(...)`: `rate_date` (qué tasa se usa) y `fetched_at`
 * (cuándo se leyó por última vez) — nunca por el orden en que se llaman,
 * porque `Promise.all` no lo garantiza. Cada test controla las dos por
 * separado en vez de simular una tabla real: ninguna de ellas se actualiza
 * sola cuando el código bajo prueba hace un `upsert` (eso lo cubre el test
 * del upsert en sí, que mira `upserts`, no una relectura).
 */
function createFakeSupabase(state: { cached: FakeCachedRow | null; lastFetchedAt: string | null }) {
  const upserts: Record<string, unknown>[] = [];

  const client = {
    from(table: string) {
      if (table !== "exchange_rates") {
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      }
      return {
        select: () => ({
          order: (column: string) => ({
            limit: () => ({
              maybeSingle: async () => {
                if (column === "fetched_at") {
                  return {
                    data: state.lastFetchedAt ? { fetched_at: state.lastFetchedAt } : null,
                    error: null,
                  };
                }
                if (column === "rate_date") {
                  return { data: state.cached, error: null };
                }
                throw new Error(`Fake Supabase: order(...) desconocido en este test: ${column}`);
              },
            }),
          }),
        }),
        upsert: (row: Record<string, unknown>) => {
          upserts.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return { client, upserts };
}

async function llamar(client: unknown, opts?: { ignoreFailureBackoff?: boolean }) {
  // @ts-expect-error -- fake mínimo suficiente para este test
  return getBcvRate(client, opts);
}

describe("getBcvRate — caché de la tasa BCV", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchBcvHtmlMock.mockReset();
    registrarMock.mockReset();
    registrarMock.mockResolvedValue(null);
    leerEstadoMock.mockReset();
    leerEstadoMock.mockResolvedValue(null);
    resetBcvFailureBackoffForTests();
    // Los logs de fallo salen por stderr: se silencian y se espían por evento.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("leída antes del último horario no cumplido: no sale a la red y devuelve la fila cacheada", async () => {
    // 07:08 VE del 24/9, consultada a las 11:59 VE del mismo día: el horario
    // vigente sigue siendo el de las 07h VE (bcv-schedule.test.ts lo prueba
    // igual para shouldRefetchBcv).
    vi.setSystemTime(new Date("2026-09-24T15:59:00Z"));
    const { client } = createFakeSupabase({
      cached: { rate_date: "2026-09-24", usd_to_ves: 800 },
      lastFetchedAt: "2026-09-24T11:08:00Z",
    });

    const result = await llamar(client);

    expect(fetchBcvHtmlMock).not.toHaveBeenCalled();
    expect(result).toEqual({ rate: 800, rateDate: "2026-09-24", isStale: false, refreshed: false, alerta: null });
  });

  it("con fetched_at null (fila del seed, o sin ninguna fila) sale a la red aunque haya una tasa cacheada", async () => {
    vi.setSystemTime(new Date("2026-08-22T15:00:00Z"));
    fetchBcvHtmlMock.mockResolvedValue(HTML_BCV_SIMULADO);
    const { client } = createFakeSupabase({
      cached: { rate_date: "2026-08-22", usd_to_ves: 775.3356 },
      lastFetchedAt: null,
    });

    await llamar(client);

    expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(1);
  });

  it("en una lectura exitosa, el upsert lleva rate_date, usd_to_ves, source, fetched_on (Venezuela, no UTC) y fetched_at (instante exacto)", async () => {
    // 2026-08-23T01:00:00Z: en Caracas (UTC-4) todavía son las 21:00 del 22 —
    // si `fetched_on` se tomara de UTC saldría "2026-08-23", un día adelantado.
    const ahora = new Date("2026-08-23T01:00:00Z");
    vi.setSystemTime(ahora);
    fetchBcvHtmlMock.mockResolvedValue(HTML_BCV_SIMULADO);
    const { client, upserts } = createFakeSupabase({ cached: null, lastFetchedAt: null });

    const result = await llamar(client);

    expect(upserts).toEqual([
      {
        rate_date: "2026-08-22", // Fecha Valor del HTML simulado
        usd_to_ves: 775.3356,
        source: "bcv.org.ve",
        fetched_on: "2026-08-22", // hoy en Venezuela, no en UTC
        fetched_at: ahora.toISOString(),
      },
    ]);
    expect(result).toEqual({ rate: 775.3356, rateDate: "2026-08-22", isStale: false, refreshed: true, alerta: null });
  });

  it("caso del operador: leída a las 18:05 VE con la tasa de mañana ya publicada, usa el fetched_at más reciente y guarda la tasa nueva", async () => {
    // El BCV ya muestra 855,66250000 con Fecha Valor 2026-09-25; el reloj
    // marca las 18:05 VE del 24 (2026-09-24T22:05:00Z) y la última lectura
    // fue a las 07:08 del mismo día: el horario de las 18:00 ya se cumplió,
    // así que toca releer aunque `rate_date` de la fila guardada sea de hoy.
    vi.setSystemTime(new Date("2026-09-24T22:05:00Z"));
    const html = `
      <div id="dolar">
        <div>
          <strong>855,66250000</strong>
        </div>
      </div>
      <span>Fecha Valor: <span content="2026-09-25T00:00:00-04:00">Viernes</span></span>
    `;
    fetchBcvHtmlMock.mockResolvedValue(html);
    const { client, upserts } = createFakeSupabase({
      cached: { rate_date: "2026-09-24", usd_to_ves: 854.46 },
      lastFetchedAt: "2026-09-24T11:08:00Z", // 07:08 VE del 24
    });

    const result = await llamar(client);

    expect(upserts).toEqual([
      {
        rate_date: "2026-09-25",
        usd_to_ves: 855.6625,
        source: "bcv.org.ve",
        fetched_on: "2026-09-24",
        fetched_at: "2026-09-24T22:05:00.000Z",
      },
    ]);
    expect(result).toEqual({ rate: 855.6625, rateDate: "2026-09-25", isStale: false, refreshed: true, alerta: null });
  });

  it("página sin Fecha Valor y con fila guardada: cero upserts, devuelve la guardada como vieja y avisa con log.warn", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    vi.setSystemTime(new Date("2026-09-24T22:05:00Z"));
    fetchBcvHtmlMock.mockResolvedValue(HTML_BCV_SIN_FECHA_VALOR);
    const { client, upserts } = createFakeSupabase({
      cached: { rate_date: "2026-09-24", usd_to_ves: 854.46 },
      lastFetchedAt: "2026-09-24T11:08:00Z",
    });

    const result = await llamar(client);

    expect(upserts).toEqual([]);
    expect(result).toEqual({ rate: 854.46, rateDate: "2026-09-24", isStale: true, refreshed: false, alerta: null });
    expect(warn).toHaveBeenCalledWith("bcv_sin_fecha_valor", expect.objectContaining({ rate: 775.3356 }));
  });

  it("la decisión usa el fetched_at más reciente aunque no sea el de la fila de mayor rate_date", async () => {
    // 12:05 VE del 24/9 (16:05Z): el horario vigente es el de las 12:00 VE.
    // La fila de mayor rate_date es vieja (nada que ver con cuándo se leyó),
    // pero el fetched_at más reciente es de 1 minuto antes, YA DESPUÉS del
    // horario de las 12:00 — no hace falta salir a la red.
    vi.setSystemTime(new Date("2026-09-24T16:05:00Z"));
    const { client } = createFakeSupabase({
      cached: { rate_date: "2026-09-20", usd_to_ves: 830 },
      lastFetchedAt: "2026-09-24T16:04:00Z",
    });

    const result = await llamar(client);

    expect(fetchBcvHtmlMock).not.toHaveBeenCalled();
    expect(result).toEqual({ rate: 830, rateDate: "2026-09-20", isStale: false, refreshed: false, alerta: null });
  });

  it("si la lectura en vivo falla y hay una fila guardada, devuelve esa fila marcada como vieja sin tocar el upsert", async () => {
    vi.setSystemTime(new Date("2026-08-24T15:00:00Z"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    fetchBcvHtmlMock.mockRejectedValue(new Error("boom"));
    const { client, upserts } = createFakeSupabase({
      cached: { rate_date: "2026-08-20", usd_to_ves: 770 },
      lastFetchedAt: "2026-08-01T00:00:00Z",
    });

    const result = await llamar(client);

    expect(result).toEqual({ rate: 770, rateDate: "2026-08-20", isStale: true, refreshed: false, alerta: null });
    expect(upserts).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "bcv_lectura_fallida",
      expect.objectContaining({ fallosSeguidos: 1, motivo: "boom", tasaDe: "2026-08-20" })
    );
  });

  it("si la lectura en vivo falla y no hay nada guardado, rechaza sin tocar el upsert, registra el fallo y avisa con log.error", async () => {
    vi.setSystemTime(new Date("2026-08-24T15:00:00Z"));
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    fetchBcvHtmlMock.mockRejectedValue(new Error("boom"));
    const { client, upserts } = createFakeSupabase({ cached: null, lastFetchedAt: null });

    await expect(llamar(client)).rejects.toThrow("No hay ninguna tasa BCV guardada");
    expect(upserts).toEqual([]);
    expect(registrarMock).toHaveBeenCalledWith(false, "boom");
    expect(error).toHaveBeenCalledWith("bcv_sin_tasa_guardada", { motivo: "boom" });
  });

  describe("ventana de fallo (BCV_FAILURE_BACKOFF_MS)", () => {
    // Fixture fijo de "toca releer siempre": una fila guardada vieja y un
    // fetched_at ancestral, iguales en todas las llamadas de este describe —
    // el fake no simula una tabla que se actualiza sola con cada upsert, así
    // que `shouldRefetchBcv` da `true` en cada llamada sin que el paso del
    // tiempo del test (minutos, no meses) lo cambie. Lo único que decide si
    // sale a la red o no, acá, es la ventana de fallo.
    function fixtureSiempreToca() {
      return createFakeSupabase({
        cached: { rate_date: "2020-01-01", usd_to_ves: 100 },
        lastFetchedAt: "2020-01-01T00:00:00Z",
      });
    }

    it("tras un fallo, una segunda llamada a los 2 min no sale a la red; a los 6 min sí", async () => {
      vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
      const { client } = fixtureSiempreToca();
      vi.spyOn(console, "error").mockImplementation(() => {});

      fetchBcvHtmlMock.mockRejectedValueOnce(new Error("boom"));
      await llamar(client);
      expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-09-24T12:02:00Z")); // +2 min, dentro de BCV_FAILURE_BACKOFF_MS
      await llamar(client);
      expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(1); // no reintentó

      vi.setSystemTime(new Date(new Date("2026-09-24T12:00:00Z").getTime() + BCV_FAILURE_BACKOFF_MS + 60_000)); // +6 min
      fetchBcvHtmlMock.mockResolvedValueOnce(HTML_BCV_SIMULADO);
      const result = await llamar(client);
      expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(2); // ya reintentó
      expect(result.refreshed).toBe(true);
    });

    it("con ignoreFailureBackoff:true sale a la red aunque esté dentro de la ventana de 5 min (así la usa el cron)", async () => {
      vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
      const { client } = fixtureSiempreToca();
      vi.spyOn(console, "error").mockImplementation(() => {});

      fetchBcvHtmlMock.mockRejectedValueOnce(new Error("boom"));
      await llamar(client);
      expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-09-24T12:02:00Z")); // +2 min
      fetchBcvHtmlMock.mockResolvedValueOnce(HTML_BCV_SIMULADO);
      const result = await llamar(client, { ignoreFailureBackoff: true });
      expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(2);
      expect(result.refreshed).toBe(true);
    });

    it("un éxito limpia la ventana: una llamada normal posterior ya no queda frenada por el fallo viejo", async () => {
      vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
      const { client } = fixtureSiempreToca();
      vi.spyOn(console, "error").mockImplementation(() => {});

      fetchBcvHtmlMock.mockRejectedValueOnce(new Error("boom"));
      await llamar(client);
      expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(1);

      // Éxito forzado adentro de la ventana (como haría el cron).
      fetchBcvHtmlMock.mockResolvedValueOnce(HTML_BCV_SIMULADO);
      await llamar(client, { ignoreFailureBackoff: true });
      expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(2);

      // Sin avanzar el reloj (seguimos "dentro" de los 5 min del fallo
      // original), una llamada NORMAL ya no queda frenada.
      fetchBcvHtmlMock.mockResolvedValueOnce(HTML_BCV_SIMULADO);
      const result = await llamar(client);
      expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(3);
      expect(result.refreshed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// T3 (21/11/2026) — el estado de la lectura persiste, se ve y el log no grita
// cada minuto. Contexto: desde el 19/11/2026 cada lectura falló dos días sin
// que nadie se enterara (un console.error por minuto y la tasa cargada a mano
// tapaba hasta `isStale`).
// ---------------------------------------------------------------------------
describe("getBcvRate — estado persistente de la lectura (bcv_fetch_status)", () => {
  /** Fixture "siempre toca releer": la ventana de fallo es lo único que decide. */
  function fixtureSiempreToca() {
    return createFakeSupabase({
      cached: { rate_date: "2026-11-18", usd_to_ves: 100 },
      lastFetchedAt: "2020-01-01T00:00:00Z",
    });
  }

  const registroOk = { fallosSeguidos: 0, fallosPrevios: 0, errorPrevio: null };
  function registroFallo(fallosSeguidos: number, errorPrevio: string | null = "boom") {
    return { fallosSeguidos, fallosPrevios: fallosSeguidos - 1, errorPrevio };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-21T15:00:00Z"));
    fetchBcvHtmlMock.mockReset();
    registrarMock.mockReset();
    registrarMock.mockResolvedValue(null);
    leerEstadoMock.mockReset();
    leerEstadoMock.mockResolvedValue(null);
    resetBcvFailureBackoffForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("qué intentos se registran", () => {
    it("un éxito registra ok=true sin error, y si venía de fallos avisa la recuperación", async () => {
      const info = vi.spyOn(log, "info").mockImplementation(() => {});
      registrarMock.mockResolvedValue({ fallosSeguidos: 0, fallosPrevios: 12, errorPrevio: "boom" });
      fetchBcvHtmlMock.mockResolvedValue(HTML_BCV_SIMULADO);
      const { client } = fixtureSiempreToca();

      const result = await llamar(client);

      expect(registrarMock).toHaveBeenCalledTimes(1);
      expect(registrarMock).toHaveBeenCalledWith(true, null);
      expect(result.refreshed).toBe(true);
      expect(info).toHaveBeenCalledWith("bcv_lectura_recuperada", { fallosPrevios: 12 });
    });

    it("un éxito sin fallos previos no avisa recuperación", async () => {
      const info = vi.spyOn(log, "info").mockImplementation(() => {});
      registrarMock.mockResolvedValue(registroOk);
      fetchBcvHtmlMock.mockResolvedValue(HTML_BCV_SIMULADO);
      const { client } = fixtureSiempreToca();

      await llamar(client);

      expect(info).not.toHaveBeenCalledWith("bcv_lectura_recuperada", expect.anything());
    });

    it("una excepción de la lectura registra ok=false con su texto", async () => {
      vi.spyOn(log, "warn").mockImplementation(() => {});
      fetchBcvHtmlMock.mockRejectedValue(new Error("certificado vencido"));
      const { client } = fixtureSiempreToca();

      await llamar(client);

      expect(registrarMock).toHaveBeenCalledWith(false, "certificado vencido");
    });

    it("sin Fecha Valor registra fallo con su motivo y conserva lo guardado", async () => {
      vi.spyOn(log, "warn").mockImplementation(() => {});
      fetchBcvHtmlMock.mockResolvedValue(HTML_BCV_SIN_FECHA_VALOR);
      const { client, upserts } = fixtureSiempreToca();

      const result = await llamar(client);

      expect(registrarMock).toHaveBeenCalledWith(false, "La página del BCV no trajo «Fecha Valor».");
      expect(upserts).toEqual([]);
      expect(result).toMatchObject({ rate: 100, isStale: true, refreshed: false });
    });

    it("si el upsert falla cuenta como fallo (antes ni se miraba el error) y no se declara refrescada", async () => {
      vi.spyOn(log, "warn").mockImplementation(() => {});
      fetchBcvHtmlMock.mockResolvedValue(HTML_BCV_SIMULADO);
      const base = fixtureSiempreToca();
      const clientConUpsertRoto = {
        from: (table: string) => ({
          ...base.client.from(table),
          upsert: () => Promise.resolve({ data: null, error: { code: "42501", message: "permiso denegado" } }),
        }),
      };

      const result = await llamar(clientConUpsertRoto);

      expect(registrarMock).toHaveBeenCalledTimes(1);
      expect(registrarMock).toHaveBeenCalledWith(
        false,
        "No se pudo guardar la tasa leída: 42501: permiso denegado"
      );
      expect(result).toMatchObject({ rate: 100, isStale: true, refreshed: false });
    });

    it("cuando no tocaba leer NO registra nada", async () => {
      vi.setSystemTime(new Date("2026-09-24T15:59:00Z"));
      const { client } = createFakeSupabase({
        cached: { rate_date: "2026-09-24", usd_to_ves: 800 },
        lastFetchedAt: "2026-09-24T11:08:00Z",
      });

      await llamar(client);

      expect(fetchBcvHtmlMock).not.toHaveBeenCalled();
      expect(registrarMock).not.toHaveBeenCalled();
    });

    it("cuando la ventana de fallo frena el intento NO registra nada", async () => {
      vi.spyOn(log, "warn").mockImplementation(() => {});
      const { client } = fixtureSiempreToca();
      fetchBcvHtmlMock.mockRejectedValueOnce(new Error("boom"));
      await llamar(client);
      expect(registrarMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-11-21T15:02:00Z")); // dentro de los 5 min
      await llamar(client);

      expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(1);
      expect(registrarMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("el log deja de gritar cada minuto", () => {
    async function fallarConRegistro(registro: ReturnType<typeof registroFallo>, motivoDelError = "boom") {
      fetchBcvHtmlMock.mockRejectedValue(new Error(motivoDelError));
      registrarMock.mockResolvedValue(registro);
      resetBcvFailureBackoffForTests();
      await llamar(fixtureSiempreToca().client, { ignoreFailureBackoff: true });
    }

    it("el primer fallo seguido avisa con log.warn y la antigüedad de la tasa", async () => {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

      await fallarConRegistro(registroFallo(1, null));

      expect(warn).toHaveBeenCalledWith("bcv_lectura_fallida", {
        fallosSeguidos: 1,
        motivo: "boom",
        tasaDe: "2026-11-18",
        diasDeAntiguedad: 3,
      });
    });

    it("el segundo fallo con el MISMO motivo no avisa", async () => {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

      await fallarConRegistro(registroFallo(2, "boom"));

      expect(warn).not.toHaveBeenCalledWith("bcv_lectura_fallida", expect.anything());
    });

    it("el segundo fallo con motivo DISTINTO sí avisa", async () => {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

      await fallarConRegistro(registroFallo(2, "otro motivo"));

      expect(warn).toHaveBeenCalledWith("bcv_lectura_fallida", expect.objectContaining({ fallosSeguidos: 2 }));
    });

    it("cada 60 fallos seguidos repite el aviso (y el 59 o el 61 no)", async () => {
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

      await fallarConRegistro(registroFallo(59));
      await fallarConRegistro(registroFallo(61));
      expect(warn).not.toHaveBeenCalledWith("bcv_lectura_fallida", expect.anything());

      await fallarConRegistro(registroFallo(60));
      expect(warn).toHaveBeenCalledWith("bcv_lectura_fallida", expect.objectContaining({ fallosSeguidos: 60 }));
    });

    it("log.error('bcv_sin_actualizar') sale exactamente en el fallo 240, no en el 239 ni en el 241", async () => {
      expect(BCV_FALLOS_PARA_ALERTA).toBe(240);
      const error = vi.spyOn(log, "error").mockImplementation(() => {});
      vi.spyOn(log, "warn").mockImplementation(() => {});
      leerEstadoMock.mockResolvedValue({
        lastAttemptAt: null,
        lastSuccessAt: "2026-11-18T22:00:00Z",
        lastFailureAt: null,
        lastError: "boom",
        consecutiveFailures: 239,
      });

      await fallarConRegistro(registroFallo(239));
      await fallarConRegistro(registroFallo(241));
      expect(error).not.toHaveBeenCalledWith("bcv_sin_actualizar", expect.anything());

      await fallarConRegistro(registroFallo(240));
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("bcv_sin_actualizar", {
        fallosSeguidos: 240,
        ultimoExito: "2026-11-18T22:00:00Z",
        motivo: "boom",
        tasaDe: "2026-11-18",
      });
    });

    it("sin tabla (el registro devuelve null) el contador en memoria da UN solo log.error en 240 fallos", async () => {
      const error = vi.spyOn(log, "error").mockImplementation(() => {});
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      registrarMock.mockResolvedValue(null);
      fetchBcvHtmlMock.mockRejectedValue(new Error("boom"));
      const { client } = fixtureSiempreToca();

      for (let i = 0; i < BCV_FALLOS_PARA_ALERTA; i++) {
        await llamar(client, { ignoreFailureBackoff: true });
      }

      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        "bcv_sin_actualizar",
        expect.objectContaining({ fallosSeguidos: 240, ultimoExito: null })
      );
      // 1 (primero) + 4 múltiplos de 60 (60, 120, 180, 240); el resto, silencio.
      expect(warn).toHaveBeenCalledTimes(5);
    });

    it("sin tabla, un éxito vuelve el contador en memoria a 0", async () => {
      const error = vi.spyOn(log, "error").mockImplementation(() => {});
      vi.spyOn(log, "warn").mockImplementation(() => {});
      vi.spyOn(log, "info").mockImplementation(() => {});
      registrarMock.mockResolvedValue(null);
      const { client } = fixtureSiempreToca();

      fetchBcvHtmlMock.mockRejectedValue(new Error("boom"));
      for (let i = 0; i < 100; i++) await llamar(client, { ignoreFailureBackoff: true });
      fetchBcvHtmlMock.mockResolvedValueOnce(HTML_BCV_SIMULADO);
      await llamar(client, { ignoreFailureBackoff: true }); // éxito
      for (let i = 0; i < 139; i++) await llamar(client, { ignoreFailureBackoff: true });

      // 100 + 139 sin el éxito en medio habrían cruzado 240; con el reinicio no.
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe("alerta", () => {
    const hace9h = "2026-11-21T06:00:00Z"; // el reloj de este describe es 15:00Z
    const estadoViejo = {
      lastAttemptAt: null,
      lastSuccessAt: hace9h,
      lastFailureAt: null,
      lastError: "error del estado",
      consecutiveFailures: 400,
    };

    it("tras un refresco exitoso la alerta es null aunque el estado leído al principio fuera viejo", async () => {
      leerEstadoMock.mockResolvedValue(estadoViejo);
      fetchBcvHtmlMock.mockResolvedValue(HTML_BCV_SIMULADO);
      const { client } = fixtureSiempreToca();

      const result = await llamar(client);

      expect(result.refreshed).toBe(true);
      expect(result.alerta).toBeNull();
    });

    it("sin refrescar y con el último éxito de hace 9 h, la alerta trae esa fecha y el último error", async () => {
      leerEstadoMock.mockResolvedValue(estadoViejo);
      // No toca leer: la última lectura (fetched_at) es de hace 1 min.
      const { client } = createFakeSupabase({
        cached: { rate_date: "2026-11-18", usd_to_ves: 100 },
        lastFetchedAt: "2026-11-21T14:59:00Z",
      });

      const result = await llamar(client);

      expect(fetchBcvHtmlMock).not.toHaveBeenCalled();
      expect(result.alerta).toEqual({ desde: hace9h, ultimoError: "error del estado" });
    });

    it("si esta llamada intentó y falló, el último error de la alerta es el de ESTE intento", async () => {
      vi.spyOn(log, "warn").mockImplementation(() => {});
      leerEstadoMock.mockResolvedValue(estadoViejo);
      registrarMock.mockResolvedValue(registroFallo(401));
      fetchBcvHtmlMock.mockRejectedValue(new Error("certificado vencido"));
      const { client } = fixtureSiempreToca();

      const result = await llamar(client);

      expect(result.isStale).toBe(true);
      expect(result.alerta).toEqual({ desde: hace9h, ultimoError: "certificado vencido" });
    });

    it("con la ventana de fallo activa también devuelve la alerta del estado", async () => {
      vi.spyOn(log, "warn").mockImplementation(() => {});
      leerEstadoMock.mockResolvedValue(estadoViejo);
      const { client } = fixtureSiempreToca();
      fetchBcvHtmlMock.mockRejectedValueOnce(new Error("boom"));
      await llamar(client);

      const result = await llamar(client); // dentro de los 5 min: no sale a la red

      expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(1);
      expect(result.alerta).toEqual({ desde: hace9h, ultimoError: "error del estado" });
    });

    it("tabla inexistente (estado null y registro null): la tasa se devuelve igual que antes y sin alerta", async () => {
      vi.spyOn(log, "warn").mockImplementation(() => {});
      leerEstadoMock.mockResolvedValue(null);
      registrarMock.mockResolvedValue(null);
      const { client } = fixtureSiempreToca();

      fetchBcvHtmlMock.mockRejectedValueOnce(new Error("boom"));
      const fallida = await llamar(client);
      expect(fallida).toEqual({ rate: 100, rateDate: "2026-11-18", isStale: true, refreshed: false, alerta: null });

      fetchBcvHtmlMock.mockResolvedValueOnce(HTML_BCV_SIMULADO);
      const buena = await llamar(client, { ignoreFailureBackoff: true });
      expect(buena).toEqual({ rate: 775.3356, rateDate: "2026-08-22", isStale: false, refreshed: true, alerta: null });
    });
  });
});
