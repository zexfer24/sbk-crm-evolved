import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchQuickReplies } from "@/lib/data";

// T5b, plan "La ronda del cliente" (30/9/2026): `fetchQuickReplies` pide
// `owner_id` (null = compartido) y lo mapea a `ownerId`. La RLS ya filtra los
// personales ajenos; acá solo se fija la forma de la consulta y del mapeo.

function fakeSupabase(rows: unknown[]) {
  const calls: { table?: string; columns?: string; order?: string } = {};
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        select(columns: string) {
          calls.columns = columns;
          return {
            order(column: string) {
              calls.order = column;
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("fetchQuickReplies", () => {
  it("pide owner_id, ordena por label y mapea ownerId (null = compartido)", async () => {
    const { client, calls } = fakeSupabase([
      { id: "1", label: "Horario", content: "8 a 18", owner_id: null },
      { id: "2", label: "Buen día", content: "Buen día, soy Ana", owner_id: "agente-1" },
    ]);

    const result = await fetchQuickReplies(client);

    expect(calls.table).toBe("quick_replies");
    expect(calls.columns).toMatch(/\bowner_id\b/);
    expect(calls.order).toBe("label");
    expect(result).toEqual([
      { id: "1", label: "Horario", content: "8 a 18", ownerId: null },
      { id: "2", label: "Buen día", content: "Buen día, soy Ana", ownerId: "agente-1" },
    ]);
  });
});
