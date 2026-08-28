// @vitest-environment node
//
// Por qué "node" y no el jsdom por defecto del proyecto (vitest.config.ts):
// este archivo ubica el fixture con `new URL("./__fixtures__/...", import.meta.url)`
// y lo lee con `fileURLToPath` + `readFileSync`. Bajo jsdom, el global `URL`
// que trae ese entorno no es compatible con `fileURLToPath`, y revienta con
// "The URL must be of scheme file". En entorno node no pasa; aun así se
// importa `URL` y `fileURLToPath` desde `node:url` explícitamente, en vez de
// confiar en cuál gana como global en cada entorno.

import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// PROCEDENCIA del fixture — src/lib/ai/__fixtures__/bcv-home-2026-08-28.html
//
//   Capturado: 2026-08-28, ~21:11 hora de Caracas.
//   HTTP: 200.
//   User-Agent enviado: "Mozilla/5.0 (compatible; SbkMotorcyclesCRM/1.0)"
//     (el mismo que manda bcv-fetch.ts en producción).
//   USD observado en la página: "791,66670000" -> 791.6667
//   EUR observado en la página: "921,88003881" -> 921.88003881
//   Fecha Valor publicada: 2026-08-28
// ---------------------------------------------------------------------------

const FIXTURE_HTML = readFileSync(
  fileURLToPath(new URL("./__fixtures__/bcv-home-2026-08-28.html", import.meta.url)),
  "utf8"
).replace(/\r\n/g, "\n"); // cinturón sobre el .gitattributes

/** USD observado en el fixture real (ver PROCEDENCIA arriba). */
const USD_OBSERVADO = 791.6667;
/** EUR observado en el fixture real — getBcvRate NUNCA debe devolver esto. */
const EUR_OBSERVADO = 921.88003881;

/**
 * Deriva una variante del HTML real reemplazando `ancla` por `reemplazo`.
 * Lanza si el reemplazo no cambió nada: sin esto, un ancla que dejó de
 * existir (porque el fixture cambió) convertiría un test de fallo en un
 * falso verde del camino feliz — terminaría probando el HTML original sin
 * querer.
 */
function variante(html: string, ancla: string, reemplazo: string): string {
  const resultado = html.replace(ancla, reemplazo);
  if (resultado === html) {
    throw new Error(`variante(): el ancla no se encontró en el fixture: ${JSON.stringify(ancla)}`);
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Fábrica perezosa del mock de bcv-fetch: el `vi.fn()` se referencia dentro
// del cuerpo de la flecha anidada, no se pasa directo, porque `vi.mock` se
// hoistea arriba de los imports y en ese punto el `const` de abajo todavía
// no corrió (TDZ). La flecha anidada no se ejecuta en el momento del hoist,
// sino más tarde (cuando bcv.ts llama a fetchBcvHtml dentro de un test), para
// entonces el const ya está inicializado. Patrón calcado de escalate.test.ts:4-6.
// ---------------------------------------------------------------------------
const fetchBcvHtmlMock = vi.fn();
vi.mock("@/lib/ai/bcv-fetch", () => ({
  fetchBcvHtml: (url: string) => fetchBcvHtmlMock(url),
}));

import { getBcvRate } from "@/lib/ai/bcv";

interface EstadoSupabase {
  upsertCalls: Record<string, unknown>[];
}

/**
 * Supabase falso con la base SIEMPRE vacía (maybeSingle -> null): así cada
 * caso ejercita de verdad la lectura en vivo de bcv.org.ve, nunca la rama de
 * "ya había una tasa guardada y no hacía falta releer".
 */
function crearFakeSupabase(): { client: unknown; estado: EstadoSupabase } {
  const estado: EstadoSupabase = { upsertCalls: [] };

  const client = {
    from(table: string) {
      if (table !== "exchange_rates") {
        throw new Error(`Fake Supabase: tabla no soportada: ${table}`);
      }
      return {
        select: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
        upsert: (row: Record<string, unknown>) => {
          estado.upsertCalls.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return { client, estado };
}

async function llamarGetBcvRate(client: unknown) {
  // @ts-expect-error -- fake mínimo suficiente para este test: no implementa
  // SupabaseClient<Database> completo, solo lo que getBcvRate usa.
  return getBcvRate(client);
}

beforeEach(() => {
  fetchBcvHtmlMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  // Reloj por defecto: el mismo momento en que se capturó el fixture.
  vi.setSystemTime(new Date("2026-08-28T21:11:00-04:00"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getBcvRate — parseo del HTML real de bcv.org.ve", () => {
  it("1. camino feliz: lee la tasa y la fecha exactas del fixture real", async () => {
    fetchBcvHtmlMock.mockResolvedValue(FIXTURE_HTML);
    const { client, estado } = crearFakeSupabase();

    const resultado = await llamarGetBcvRate(client);

    expect(resultado.rate).toBe(791.6667);
    expect(resultado.rateDate).toBe("2026-08-28");
    expect(resultado.isStale).toBe(false);
    expect(estado.upsertCalls).toEqual([
      {
        rate_date: "2026-08-28",
        usd_to_ves: 791.6667,
        source: "bcv.org.ve",
        fetched_on: "2026-08-28",
      },
    ]);
  });

  it("2. lee el dólar, no el euro", async () => {
    fetchBcvHtmlMock.mockResolvedValue(FIXTURE_HTML);
    const { client } = crearFakeSupabase();

    const resultado = await llamarGetBcvRate(client);

    expect(resultado.rate).toBe(USD_OBSERVADO);
    expect(resultado.rate).not.toBe(EUR_OBSERVADO);
  });

  describe("3. coma decimal venezolana", () => {
    it("con miles y decimales (1.234,56) parsea 1234.56", async () => {
      const html = variante(FIXTURE_HTML, "791,66670000", "1.234,56");
      fetchBcvHtmlMock.mockResolvedValue(html);
      const { client } = crearFakeSupabase();

      const resultado = await llamarGetBcvRate(client);

      expect(resultado.rate).toBe(1234.56);
    });

    it("sin perder precisión (775,33560000 -> 775.3356)", async () => {
      const html = variante(FIXTURE_HTML, "791,66670000", "775,33560000");
      fetchBcvHtmlMock.mockResolvedValue(html);
      const { client } = crearFakeSupabase();

      const resultado = await llamarGetBcvRate(client);

      expect(resultado.rate).toBe(775.3356);
    });
  });

  it("4. la Fecha Valor manda sobre 'hoy': lunes publicado el sábado anterior", async () => {
    // El BCV publica el sábado la tasa que rige el lunes. El content= de la
    // Fecha Valor queda en lunes 2026-08-31; el reloj falso está el sábado
    // 2026-08-29 (el día anterior).
    const html = variante(FIXTURE_HTML, "2026-08-28T00:00:00-04:00", "2026-08-31T00:00:00-04:00");
    fetchBcvHtmlMock.mockResolvedValue(html);
    vi.setSystemTime(new Date("2026-08-29T15:00:00-04:00"));
    const { client } = crearFakeSupabase();

    const resultado = await llamarGetBcvRate(client);

    expect(resultado.rateDate).toBe("2026-08-31");
  });

  it("5. sin Fecha Valor, rateDate cae a la fecha de Venezuela del reloj falso", async () => {
    // Se borra la frase "Fecha Valor:" (parseValueDate la busca literal):
    // sin ella no hay content= que leer, y bcv.ts cae deliberadamente a
    // venezuelaDate().
    const html = variante(FIXTURE_HTML, "Fecha Valor:", "Fecha:");
    fetchBcvHtmlMock.mockResolvedValue(html);
    vi.setSystemTime(new Date("2026-08-29T15:00:00-04:00"));
    const { client } = crearFakeSupabase();

    const resultado = await llamarGetBcvRate(client);

    expect(resultado.rateDate).toBe("2026-08-29");
  });

  it('6. sin bloque id="dolar" (renombrado), rechaza y no escribe', async () => {
    const html = variante(FIXTURE_HTML, 'id="dolar"', 'id="dolar-viejo"');
    fetchBcvHtmlMock.mockResolvedValue(html);
    const { client, estado } = crearFakeSupabase();

    await expect(llamarGetBcvRate(client)).rejects.toThrow(/No hay ninguna tasa BCV guardada/);
    expect(estado.upsertCalls).toHaveLength(0);
  });

  it("7. el número ya no está en <strong> (pasó a <span>), rechaza y no escribe", async () => {
    const html = variante(
      FIXTURE_HTML,
      '<strong class="strong-tb">791,66670000</strong>',
      '<span class="strong-tb">791,66670000</span>'
    );
    fetchBcvHtmlMock.mockResolvedValue(html);
    const { client, estado } = crearFakeSupabase();

    await expect(llamarGetBcvRate(client)).rejects.toThrow(/No hay ninguna tasa BCV guardada/);
    expect(estado.upsertCalls).toHaveLength(0);
  });

  it("8. el cierre del bloque queda a más de 600 caracteres (fija bcv.ts:47), rechaza", async () => {
    // Relleno de sobra para empujar el cierre del bloque más allá de los 600
    // caracteres que permite el `{0,600}?` de fetchLiveBcvRate en bcv.ts:47,
    // sin depender de cuánto mida el bloque real hoy.
    const relleno = "X".repeat(700);
    const html = variante(FIXTURE_HTML, 'id="dolar"', `id="dolar" data-relleno="${relleno}"`);
    fetchBcvHtmlMock.mockResolvedValue(html);
    const { client, estado } = crearFakeSupabase();

    await expect(llamarGetBcvRate(client)).rejects.toThrow(/No hay ninguna tasa BCV guardada/);
    expect(estado.upsertCalls).toHaveLength(0);
  });

  describe("9. número irrecuperable", () => {
    it("<strong>,,</strong> parsea a NaN y rechaza en vez de escribir NaN", async () => {
      const html = variante(
        FIXTURE_HTML,
        '<strong class="strong-tb">791,66670000</strong>',
        '<strong class="strong-tb">,,</strong>'
      );
      fetchBcvHtmlMock.mockResolvedValue(html);
      const { client, estado } = crearFakeSupabase();

      await expect(llamarGetBcvRate(client)).rejects.toThrow(/No hay ninguna tasa BCV guardada/);
      expect(estado.upsertCalls).toHaveLength(0);
    });

    it("<strong></strong> (vacío) también rechaza, aunque falle por otro camino", async () => {
      // No casa con [\d.,]+ (exige al menos un carácter): el match del
      // <strong> entero da null, así que ni siquiera llega a parsear un
      // número (ni bueno ni NaN). Lo que se afirma acá es el rechazo, no el
      // mensaje exacto — es un camino de error distinto al del caso ",,".
      const html = variante(
        FIXTURE_HTML,
        '<strong class="strong-tb">791,66670000</strong>',
        '<strong class="strong-tb"></strong>'
      );
      fetchBcvHtmlMock.mockResolvedValue(html);
      const { client, estado } = crearFakeSupabase();

      await expect(llamarGetBcvRate(client)).rejects.toThrow(/No hay ninguna tasa BCV guardada/);
      expect(estado.upsertCalls).toHaveLength(0);
    });
  });

  it("10. separador raro (1&nbsp;234,56): la regex no matchea del todo y rechaza", async () => {
    // HALLAZGO: el código real NO lee "1" en silencio. [\d.,]+ es goloso pero
    // solo puede capturar "1" antes del "&"; lo que sigue es "&nbsp;234,56</strong>"
    // en vez de "\s*</strong>", así que el intento completo de casar
    // <strong>...</strong> falla y block[0].match(...) da null para todo el
    // bloque -> "no se pudo leer el número" -> getBcvRate rechaza. Verificado
    // aparte con un script Node contra el regex real de bcv.ts antes de
    // escribir este test: la propiedad "nunca un número absurdo silencioso"
    // SÍ se cumple para este caso.
    const html = variante(FIXTURE_HTML, "791,66670000", "1&nbsp;234,56");
    fetchBcvHtmlMock.mockResolvedValue(html);
    const { client, estado } = crearFakeSupabase();

    await expect(llamarGetBcvRate(client)).rejects.toThrow(/No hay ninguna tasa BCV guardada/);
    expect(estado.upsertCalls).toHaveLength(0);
  });

  describe("11. página sin tasas", () => {
    it("página vacía rechaza", async () => {
      fetchBcvHtmlMock.mockResolvedValue("");
      const { client, estado } = crearFakeSupabase();

      await expect(llamarGetBcvRate(client)).rejects.toThrow(/No hay ninguna tasa BCV guardada/);
      expect(estado.upsertCalls).toHaveLength(0);
    });

    it("HTML sin tasas (página de mantenimiento) rechaza", async () => {
      fetchBcvHtmlMock.mockResolvedValue("<html><body>mantenimiento</body></html>");
      const { client, estado } = crearFakeSupabase();

      await expect(llamarGetBcvRate(client)).rejects.toThrow(/No hay ninguna tasa BCV guardada/);
      expect(estado.upsertCalls).toHaveLength(0);
    });
  });

  it.todo(
    "12. DEFECTO CONOCIDO (D1): si el BCV publicara con punto decimal (775.34), parseVenezuelanNumber lee 77534 — finito y positivo, pasa la guarda, se escribe y se cotiza. Remedio propuesto: validar el formato crudo o banda de cordura contra la última tasa guardada."
  );
});
