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

import { getBcvRate } from "@/lib/ai/bcv";

interface FakeExchangeRateRow {
  rate_date: string;
  usd_to_ves: number;
  fetched_on: string | null;
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

function createFakeSupabase(cached: FakeExchangeRateRow | null) {
  const upserts: Record<string, unknown>[] = [];

  const client = {
    from(table: string) {
      if (table !== "exchange_rates") {
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      }
      return {
        select: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: cached, error: null }),
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

describe("getBcvRate — caché de la tasa BCV", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchBcvHtmlMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("si ya se leyó hoy, no sale a la red y devuelve la fila cacheada", async () => {
    // 22/8/2026 a las 15:00 UTC son las 11:00 en Caracas: mismo día.
    vi.setSystemTime(new Date("2026-08-22T15:00:00Z"));
    const { client } = createFakeSupabase({
      rate_date: "2026-08-22",
      usd_to_ves: 800,
      fetched_on: "2026-08-22",
    });

    // @ts-expect-error -- fake mínimo suficiente para este test
    const result = await getBcvRate(client);

    expect(fetchBcvHtmlMock).not.toHaveBeenCalled();
    expect(result).toEqual({ rate: 800, rateDate: "2026-08-22", isStale: false });
  });

  it("con fetched_on null (la fila del seed) sale a la red aunque haya una fila guardada", async () => {
    vi.setSystemTime(new Date("2026-08-22T15:00:00Z"));
    fetchBcvHtmlMock.mockResolvedValue(HTML_BCV_SIMULADO);
    const { client } = createFakeSupabase({
      rate_date: "2026-08-22",
      usd_to_ves: 775.3356,
      fetched_on: null,
    });

    // @ts-expect-error -- fake mínimo suficiente para este test
    await getBcvRate(client);

    expect(fetchBcvHtmlMock).toHaveBeenCalledTimes(1);
  });

  it("en una lectura exitosa, hace upsert con la fecha de Venezuela (no UTC) y devuelve la tasa leída", async () => {
    // 2026-08-23T01:00:00Z: en Caracas (UTC-4) todavía son las 21:00 del 22 —
    // si `fetched_on` se tomara de UTC saldría "2026-08-23", un día adelantado.
    vi.setSystemTime(new Date("2026-08-23T01:00:00Z"));
    fetchBcvHtmlMock.mockResolvedValue(HTML_BCV_SIMULADO);
    const { client, upserts } = createFakeSupabase(null);

    // @ts-expect-error -- fake mínimo suficiente para este test
    const result = await getBcvRate(client);

    expect(upserts).toEqual([
      {
        rate_date: "2026-08-22", // Fecha Valor del HTML simulado
        usd_to_ves: 775.3356,
        source: "bcv.org.ve",
        fetched_on: "2026-08-22", // hoy en Venezuela, no en UTC
      },
    ]);
    expect(result).toEqual({ rate: 775.3356, rateDate: "2026-08-22", isStale: false });
  });

  it("si la lectura en vivo falla y hay una fila guardada, devuelve esa fila marcada como vieja sin tocar el upsert", async () => {
    vi.setSystemTime(new Date("2026-08-24T15:00:00Z"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchBcvHtmlMock.mockRejectedValue(new Error("boom"));
    const { client, upserts } = createFakeSupabase({
      rate_date: "2026-08-20",
      usd_to_ves: 770,
      fetched_on: "2026-08-20",
    });

    // @ts-expect-error -- fake mínimo suficiente para este test
    const result = await getBcvRate(client);

    expect(result).toEqual({ rate: 770, rateDate: "2026-08-20", isStale: true });
    expect(upserts).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("si la lectura en vivo falla y no hay nada guardado, rechaza sin tocar el upsert", async () => {
    vi.setSystemTime(new Date("2026-08-24T15:00:00Z"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchBcvHtmlMock.mockRejectedValue(new Error("boom"));
    const { client, upserts } = createFakeSupabase(null);

    // @ts-expect-error -- fake mínimo suficiente para este test
    await expect(getBcvRate(client)).rejects.toThrow("No hay ninguna tasa BCV guardada");
    expect(upserts).toEqual([]);

    consoleErrorSpy.mockRestore();
  });

  it("si el BCV responde 500 (o no responde) y no hay nada guardado, rechaza igual que cualquier otra falla de red", async () => {
    vi.setSystemTime(new Date("2026-08-24T15:00:00Z"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Forma real del error que produce bcv-fetch.ts ante un status fuera de 2xx.
    fetchBcvHtmlMock.mockRejectedValue(new Error("bcv.org.ve respondió 500 al pedir la tasa."));
    const { client, upserts } = createFakeSupabase(null);

    // @ts-expect-error -- fake mínimo suficiente para este test
    await expect(getBcvRate(client)).rejects.toThrow("No hay ninguna tasa BCV guardada");
    expect(upserts).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
