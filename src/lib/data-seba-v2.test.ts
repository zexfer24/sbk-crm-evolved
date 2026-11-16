import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAgentAreas, fetchPaymentMethods, fetchSebaV2Config } from "@/lib/data";

// Entrega 2 de Seba v2 (16/11/2026): las tres lecturas del panel de configuración.
// El fake REGISTRA la tabla, las columnas del `select` y cada filtro/orden como
// `{ op, column, value }`: un fake que se traga el operador o el argumento de un
// filtro deja pasar un `.eq` cambiado por otro (CLAUDE.md, revisión del 20/9/2026).

interface Op {
  op: string;
  column: string;
  value?: unknown;
}

function fakeSupabase(result: { data?: unknown; error?: unknown }) {
  const calls: { table: string | null; columns: string | null; ops: Op[]; single: boolean } = {
    table: null,
    columns: null,
    ops: [],
    single: false,
  };
  const respuesta = { data: result.data ?? null, error: result.error ?? null };
  const b: Record<string, unknown> = {
    select(columns: string) {
      calls.columns = columns;
      return b;
    },
    eq(column: string, value: unknown) {
      calls.ops.push({ op: "eq", column, value });
      return b;
    },
    order(column: string, options?: { ascending?: boolean }) {
      calls.ops.push({ op: "order", column, value: options?.ascending ?? true });
      return b;
    },
    single() {
      calls.single = true;
      return Promise.resolve(respuesta);
    },
    then(resolve: (value: typeof respuesta) => unknown) {
      return Promise.resolve(respuesta).then(resolve);
    },
  };
  const client = {
    from(table: string) {
      calls.table = table;
      return b;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
});

describe("fetchPaymentMethods", () => {
  const FILA = {
    key: "pago_movil",
    label: "Pago móvil",
    currency: "VES",
    instructions: "Banco X",
    seba_entrega: true,
    is_active: false,
    sort_order: 20,
    updated_at: "2026-11-16T12:00:00+00:00",
  };

  it("lee payment_methods con las ocho columnas, por sort_order y luego label", async () => {
    const { client, calls } = fakeSupabase({ data: [FILA] });

    await fetchPaymentMethods(client);

    expect(calls.table).toBe("payment_methods");
    expect(calls.columns).toBe("key, label, currency, instructions, seba_entrega, is_active, sort_order, updated_at");
    expect(calls.ops).toEqual([
      { op: "order", column: "sort_order", value: true },
      { op: "order", column: "label", value: true },
    ]);
  });

  it("mapea snake_case a camelCase, también las inactivas", async () => {
    const { client } = fakeSupabase({ data: [FILA] });

    expect(await fetchPaymentMethods(client)).toEqual([
      {
        key: "pago_movil",
        label: "Pago móvil",
        currency: "VES",
        instructions: "Banco X",
        sebaEntrega: true,
        isActive: false,
        sortOrder: 20,
        updatedAt: "2026-11-16T12:00:00+00:00",
      },
    ]);
  });

  it("lanza ante un error en vez de devolver una lista vacía", async () => {
    const { client } = fakeSupabase({ error: { code: "42P01", message: "no existe" } });

    await expect(fetchPaymentMethods(client)).rejects.toMatchObject({ code: "42P01" });
  });
});

describe("fetchSebaV2Config", () => {
  const FILA = {
    seba_v2_modo: "sombra",
    shadow_daily_cap_usd: "5.00",
    shadow_sample_pct: 40,
    welcome_text: "Hola, buen día",
    welcome_followups: ["Uno", "Dos"],
    cashea_datos_text: "Dame tu cédula",
    cashea_minimo_usd: "25.00",
    cashea_seis_cuotas_desde_usd: 100,
  };

  it("pide las ocho columnas de la fila única", async () => {
    const { client, calls } = fakeSupabase({ data: FILA });

    await fetchSebaV2Config(client);

    expect(calls.table).toBe("agent_settings");
    expect(calls.columns).toBe(
      "seba_v2_modo, shadow_daily_cap_usd, shadow_sample_pct, welcome_text, welcome_followups, cashea_datos_text, cashea_minimo_usd, cashea_seis_cuotas_desde_usd"
    );
    expect(calls.ops).toContainEqual({ op: "eq", column: "id", value: true });
    expect(calls.single).toBe(true);
  });

  it("mapea: los numeric que llegan como string pasan a número", async () => {
    const { client } = fakeSupabase({ data: FILA });

    expect(await fetchSebaV2Config(client)).toEqual({
      modo: "sombra",
      shadowDailyCapUsd: 5,
      shadowSamplePct: 40,
      welcomeText: "Hola, buen día",
      welcomeFollowups: ["Uno", "Dos"],
      casheaDatosText: "Dame tu cédula",
      casheaMinimoUsd: 25,
      casheaSeisCuotasDesdeUsd: 100,
    });
  });

  it("un modo desconocido cae a 'apagado' y unas frases que no son arreglo, a []", async () => {
    const { client } = fakeSupabase({ data: { ...FILA, seba_v2_modo: "turbo", welcome_followups: null } });

    const config = await fetchSebaV2Config(client);

    expect(config?.modo).toBe("apagado");
    expect(config?.welcomeFollowups).toEqual([]);
  });

  it("devuelve null SOLO con 42703 (falta la migración 20261116030000) y avisa en consola", async () => {
    const { client } = fakeSupabase({ error: { code: "42703", message: 'column "seba_v2_modo" does not exist' } });

    expect(await fetchSebaV2Config(client)).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    expect(String(consoleError.mock.calls[0][0])).toContain("20261116030000");
  });

  it("con cualquier otro código LANZA (un timeout no se disfraza de 'no disponible')", async () => {
    const { client } = fakeSupabase({ error: { code: "57014", message: "statement timeout" } });

    await expect(fetchSebaV2Config(client)).rejects.toMatchObject({ code: "57014" });
  });
});

describe("fetchAgentAreas", () => {
  it("lee id y areas de agents y arma el mapa por id pasando cada valor por parseAreas", async () => {
    const { client, calls } = fakeSupabase({
      data: [
        { id: "a-1", areas: ["reclamos", "pagos", "cobranza"] },
        { id: "a-2", areas: [] },
        { id: "a-3", areas: null },
      ],
    });

    const mapa = await fetchAgentAreas(client);

    expect(calls.table).toBe("agents");
    expect(calls.columns).toBe("id, areas");
    expect(mapa).toEqual({ "a-1": ["pagos", "reclamos"], "a-2": [], "a-3": [] });
  });

  it("devuelve null SOLO con 42703 y avisa en consola", async () => {
    const { client } = fakeSupabase({ error: { code: "42703", message: 'column "areas" does not exist' } });

    expect(await fetchAgentAreas(client)).toBeNull();
    expect(String(consoleError.mock.calls[0][0])).toContain("20261116030000");
  });

  it("con otro código lanza", async () => {
    const { client } = fakeSupabase({ error: { code: "57014", message: "statement timeout" } });

    await expect(fetchAgentAreas(client)).rejects.toMatchObject({ code: "57014" });
  });
});
