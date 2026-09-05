import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPinnedIds } from "@/lib/data";

// ---------------------------------------------------------------------------
// T2.2 del plan "La bandeja que no pierde" (5/9/2026): hasta tres chats
// fijados por asesor (`conversation_pins`). `fetchPinnedIds` es una consulta
// chica a propósito -- la regla de negocio real (el tope de tres) vive en el
// trigger de la migración 20260905040000_conversation_pins.sql y la verifica
// supabase/tests/pins.sql contra la base real. Lo que este archivo fija es
// lo único que le toca al cliente: que la condición por agente viaja en el
// `.eq()` (no queda librado a que RLS sola haga el corte, ver el comentario
// de la función en data.ts) y que el resultado es un Set de ids, no filas.
// ---------------------------------------------------------------------------

function createFakeSupabase(rows: { conversation_id: string }[]) {
  const calls: { table: string; column: string; value: string }[] = [];

  const client = {
    from(table: string) {
      return {
        select: () => ({
          eq: async (column: string, value: string) => {
            calls.push({ table, column, value });
            return { data: rows, error: null };
          },
        }),
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchPinnedIds", () => {
  it("pide conversation_pins filtrado por el agente que mira", async () => {
    const { client, calls } = createFakeSupabase([{ conversation_id: "conv-1" }]);

    await fetchPinnedIds(client, "agent-1");

    expect(calls).toEqual([{ table: "conversation_pins", column: "agent_id", value: "agent-1" }]);
  });

  it("devuelve los ids como Set, no como arreglo de filas", async () => {
    const { client } = createFakeSupabase([
      { conversation_id: "conv-1" },
      { conversation_id: "conv-2" },
    ]);

    const ids = await fetchPinnedIds(client, "agent-1");

    expect(ids).toBeInstanceOf(Set);
    expect([...ids].sort()).toEqual(["conv-1", "conv-2"]);
  });

  it("sin pines, devuelve un Set vacío en vez de null o undefined", async () => {
    const { client } = createFakeSupabase([]);

    const ids = await fetchPinnedIds(client, "agent-1");

    expect(ids.size).toBe(0);
  });

  it("propaga el error de la consulta en vez de tragárselo", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: async () => ({ data: null, error: new Error("caída de red") }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(fetchPinnedIds(client, "agent-1")).rejects.toThrow(/caída de red/);
  });
});
