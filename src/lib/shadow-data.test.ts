import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchAdvisorFollowups,
  fetchPendingSuggestion,
  fetchShadowDrafts,
  fetchShadowReviews,
  fetchShadowSpendToday,
  fetchSombraResumen,
} from "@/lib/shadow-data";

/**
 * Fake de Supabase que REGISTRA operador + columna + valor de cada filtro (y el
 * argumento real de `.limit()`/`.order()`): un fake que se traga el operador
 * deja pasar `.eq` por `.gte`, que fue la trampa del 20/9/2026 (CLAUDE.md).
 */
interface Call {
  table: string;
  ops: [string, ...unknown[]][];
}

function fakeSupabase(result: { data?: unknown; error?: unknown } = {}, rpcResult?: { data?: unknown; error?: unknown }) {
  const calls: Call[] = [];
  const rpcCalls: { fn: string; args: unknown }[] = [];

  function builder(table: string) {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const b: Record<string, unknown> = {};
    for (const op of ["select", "eq", "gte", "gt", "lt", "in", "order", "limit"]) {
      b[op] = (...args: unknown[]) => {
        call.ops.push([op, ...args]);
        return b;
      };
    }
    b.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: result.data ?? [], error: result.error ?? null }).then(resolve);
    return b;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: rpcResult?.data ?? null, error: rpcResult?.error ?? null });
    },
  } as unknown as SupabaseClient;

  return { client, calls, rpcCalls };
}

const ROW = {
  id: "d1",
  conversation_id: "c1",
  modo: "copiloto",
  rafaga: ["hola"],
  mensajes: [{ orden: 1, tipo: "texto", texto: "Hola", origen: "modelo" }],
  created_at: "2026-11-17T15:00:00.000Z",
  sugerencia_estado: "pendiente",
};

describe("fetchShadowDrafts", () => {
  it("pide desde la fecha, de más nuevo a más viejo y con límite 200 por defecto", async () => {
    const { client, calls } = fakeSupabase({ data: [ROW] });
    const out = await fetchShadowDrafts(client, { desde: "2026-11-10T00:00:00.000Z" });

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("d1");
    expect(calls[0].table).toBe("agent_shadow_drafts");
    expect(calls[0].ops).toContainEqual(["gte", "created_at", "2026-11-10T00:00:00.000Z"]);
    expect(calls[0].ops).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(calls[0].ops).toContainEqual(["limit", 200]);
  });

  it("acepta un `hasta` y un límite propio", async () => {
    const { client, calls } = fakeSupabase({ data: [] });
    await fetchShadowDrafts(client, { desde: "2026-11-10T00:00:00.000Z", hasta: "2026-11-12T00:00:00.000Z", limit: 50 });
    expect(calls[0].ops).toContainEqual(["lt", "created_at", "2026-11-12T00:00:00.000Z"]);
    expect(calls[0].ops).toContainEqual(["limit", 50]);
  });

  it("relanza el error de la base", async () => {
    const { client } = fakeSupabase({ error: { code: "42P01", message: "no existe" } });
    await expect(fetchShadowDrafts(client, { desde: "x" })).rejects.toMatchObject({ code: "42P01" });
  });
});

describe("fetchShadowReviews", () => {
  it("sin ids no consulta nada", async () => {
    const { client, calls } = fakeSupabase();
    expect(await fetchShadowReviews(client, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("filtra por draft_id con `in`, y parte los lotes largos para no pasar el límite de la URL", async () => {
    const ids = Array.from({ length: 230 }, (_, i) => `id-${i}`);
    const { client, calls } = fakeSupabase({
      data: [{ draft_id: "id-1", veredicto: "igual", reviewed_by: "a", reviewed_at: "2026-11-17T16:00:00.000Z" }],
    });
    const out = await fetchShadowReviews(client, ids);

    expect(calls).toHaveLength(3);
    expect(calls[0].ops).toContainEqual(["in", "draft_id", ids.slice(0, 100)]);
    expect(calls[2].ops).toContainEqual(["in", "draft_id", ids.slice(200)]);
    // Las tres consultas devuelven la misma fila del fake: se concatenan.
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ draftId: "id-1", veredicto: "igual" });
  });
});

describe("fetchAdvisorFollowups", () => {
  it("pide los TRES mensajes siguientes de un asesor: salientes, sin notas internas, en orden ascendente", async () => {
    const { client, calls } = fakeSupabase({ data: [] });
    await fetchAdvisorFollowups(client, "c1", "2026-11-17T15:00:00.000Z");

    const ops = calls[0].ops;
    expect(calls[0].table).toBe("messages");
    expect(ops).toContainEqual(["eq", "conversation_id", "c1"]);
    expect(ops).toContainEqual(["eq", "sender_type", "agent"]);
    expect(ops).toContainEqual(["eq", "direction", "outbound"]);
    expect(ops).toContainEqual(["eq", "is_internal_note", false]);
    expect(ops).toContainEqual(["gt", "created_at", "2026-11-17T15:00:00.000Z"]);
    expect(ops).toContainEqual(["order", "created_at", { ascending: true }]);
    expect(ops).toContainEqual(["limit", 3]);
  });

  it("devuelve los mensajes y los minutos que tardó el primero", async () => {
    const { client } = fakeSupabase({
      data: [
        { id: "m1", content: "Hola, claro", message_type: "text", created_at: "2026-11-17T15:04:30.000Z" },
        { id: "m2", content: "¿Qué moto?", message_type: "text", created_at: "2026-11-17T15:05:00.000Z" },
      ],
    });
    const out = await fetchAdvisorFollowups(client, "c1", "2026-11-17T15:00:00.000Z");
    expect(out.messages.map((m) => m.content)).toEqual(["Hola, claro", "¿Qué moto?"]);
    expect(out.minutesToFirst).toBe(4.5);
  });

  it("sin respuesta del asesor: lista vacía y minutesToFirst null", async () => {
    const { client } = fakeSupabase({ data: [] });
    expect(await fetchAdvisorFollowups(client, "c1", "2026-11-17T15:00:00.000Z")).toEqual({
      messages: [],
      minutesToFirst: null,
    });
  });
});

describe("fetchShadowSpendToday", () => {
  it("llama a la RPC y devuelve el número", async () => {
    const { client, rpcCalls } = fakeSupabase({}, { data: "0.4231" });
    expect(await fetchShadowSpendToday(client)).toBeCloseTo(0.4231);
    expect(rpcCalls[0].fn).toBe("shadow_spend_today");
  });

  it("si la RPC falla devuelve null (se pinta «—»), no 0", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeSupabase({}, { error: { code: "PGRST202" } });
    expect(await fetchShadowSpendToday(client)).toBeNull();
    spy.mockRestore();
  });

  it("si la RPC devuelve algo que no es un número, null", async () => {
    const { client } = fakeSupabase({}, { data: null });
    expect(await fetchShadowSpendToday(client)).toBeNull();
  });
});

describe("fetchPendingSuggestion", () => {
  it("pide el último borrador de COPILOTO de la conversación (no el de sombra)", async () => {
    const { client, calls } = fakeSupabase({ data: [ROW] });
    const out = await fetchPendingSuggestion(client, "c1");

    expect(out?.id).toBe("d1");
    const ops = calls[0].ops;
    expect(calls[0].table).toBe("agent_shadow_drafts");
    expect(ops).toContainEqual(["eq", "conversation_id", "c1"]);
    expect(ops).toContainEqual(["eq", "modo", "copiloto"]);
    expect(ops).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(ops).toContainEqual(["limit", 1]);
  });

  it("sin borradores devuelve null", async () => {
    const { client } = fakeSupabase({ data: [] });
    expect(await fetchPendingSuggestion(client, "c1")).toBeNull();
  });
});

describe("fetchSombraResumen", () => {
  const RANGO = { desde: "2026-11-10T04:00:00.000Z", hasta: "2026-11-17T20:00:00.000Z" };
  const FILA = {
    consumo: {
      dias: [{ dia: "2026-11-17", borradores: 2, input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, costo_usd: 0.5 }],
      total: { borradores: 2, input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, costo_usd: 0.5, sin_tarifa: 0 },
      hoy_usd: 0.5,
      tope_usd: 5,
      muestreo_pct: 100,
    },
    preparacion: { ejes: [], senales: { total: 2, con_guardas: 0, pasarian_a_asesor: 0, sin_mensajes: 0 } },
  };

  it("llama a la RPC con los dos parámetros y devuelve el resumen mapeado", async () => {
    const { client, rpcCalls } = fakeSupabase({}, { data: FILA });
    const out = await fetchSombraResumen(client, RANGO);

    expect(rpcCalls).toEqual([{ fn: "sombra_resumen", args: { p_desde: RANGO.desde, p_hasta: RANGO.hasta } }]);
    expect(out?.consumo.total.costoUsd).toBe(0.5);
    expect(out?.consumo.dias[0].dia).toBe("2026-11-17");
  });

  it("un 42501 (no es supervisor ni admin) se RELANZA: no se esconde como si no hubiera datos", async () => {
    const { client } = fakeSupabase({}, { error: { code: "42501", message: "no autorizado" } });
    await expect(fetchSombraResumen(client, RANGO)).rejects.toMatchObject({ code: "42501" });
  });

  it.each(["42883", "PGRST202"])("función inexistente (%s: falta aplicar la migración) devuelve null y deja el error en consola", async (code) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeSupabase({}, { error: { code, message: "no existe" } });

    expect(await fetchSombraResumen(client, RANGO)).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("cualquier otro error se relanza", async () => {
    const { client } = fakeSupabase({}, { error: { code: "57014", message: "statement timeout" } });
    await expect(fetchSombraResumen(client, RANGO)).rejects.toMatchObject({ code: "57014" });
  });

  it("una respuesta que no tiene la forma esperada da null", async () => {
    const { client } = fakeSupabase({}, { data: { cualquier: "cosa" } });
    expect(await fetchSombraResumen(client, RANGO)).toBeNull();
  });
});
