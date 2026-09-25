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

import { log } from "@/lib/log";
import { BCV_FAILURE_BACKOFF_MS, getBcvRate, resetBcvFailureBackoffForTests } from "@/lib/ai/bcv";

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
    resetBcvFailureBackoffForTests();
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
    expect(result).toEqual({ rate: 800, rateDate: "2026-09-24", isStale: false, refreshed: false });
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
    expect(result).toEqual({ rate: 775.3356, rateDate: "2026-08-22", isStale: false, refreshed: true });
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
    expect(result).toEqual({ rate: 855.6625, rateDate: "2026-09-25", isStale: false, refreshed: true });
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
    expect(result).toEqual({ rate: 854.46, rateDate: "2026-09-24", isStale: true, refreshed: false });
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
    expect(result).toEqual({ rate: 830, rateDate: "2026-09-20", isStale: false, refreshed: false });
  });

  it("si la lectura en vivo falla y hay una fila guardada, devuelve esa fila marcada como vieja sin tocar el upsert", async () => {
    vi.setSystemTime(new Date("2026-08-24T15:00:00Z"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchBcvHtmlMock.mockRejectedValue(new Error("boom"));
    const { client, upserts } = createFakeSupabase({
      cached: { rate_date: "2026-08-20", usd_to_ves: 770 },
      lastFetchedAt: "2026-08-01T00:00:00Z",
    });

    const result = await llamar(client);

    expect(result).toEqual({ rate: 770, rateDate: "2026-08-20", isStale: true, refreshed: false });
    expect(upserts).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("si la lectura en vivo falla y no hay nada guardado, rechaza sin tocar el upsert", async () => {
    vi.setSystemTime(new Date("2026-08-24T15:00:00Z"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchBcvHtmlMock.mockRejectedValue(new Error("boom"));
    const { client, upserts } = createFakeSupabase({ cached: null, lastFetchedAt: null });

    await expect(llamar(client)).rejects.toThrow("No hay ninguna tasa BCV guardada");
    expect(upserts).toEqual([]);
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
