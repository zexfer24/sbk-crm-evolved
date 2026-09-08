import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchConversationIdByPhone } from "@/lib/data";

// ---------------------------------------------------------------------------
// El botón "Abrir el chat de {newPhone}" del aviso de cambio de número (D2,
// "El cliente que cambió de número", 6/9/2026; botón del 8/9/2026) necesita
// resolver a qué conversación saltar. `fetchConversationIdByPhone` hace DOS
// consultas — `contacts` por teléfono y `conversations` por `contact_id` — y
// el fake acá distingue una de otra por la tabla pedida a `.from()`.
// ---------------------------------------------------------------------------

interface FakeConversationRow {
  id: string;
  contact_id: string;
  last_message_at: string | null;
}

function createFakeSupabase(contactId: string | null, conversations: FakeConversationRow[]) {
  const calls: { table: string; order?: [string, unknown]; limit?: number }[] = [];

  const client = {
    from(table: string) {
      if (table === "contacts") {
        return {
          select() {
            return {
              eq(column: string, value: string) {
                if (column !== "phone_number") throw new Error(`columna inesperada: ${column}`);
                return {
                  maybeSingle() {
                    return Promise.resolve({
                      data: contactId && value ? { id: contactId } : null,
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      }

      if (table === "conversations") {
        const record: { table: string; order?: [string, unknown]; limit?: number } = { table };
        calls.push(record);
        return {
          select() {
            return {
              eq(column: string, value: string) {
                if (column !== "contact_id") throw new Error(`columna inesperada: ${column}`);
                const matching = conversations.filter((row) => row.contact_id === value);
                return {
                  order(orderColumn: string, options: unknown) {
                    record.order = [orderColumn, options];
                    const sorted = [...matching].sort((a, b) => {
                      const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : -Infinity;
                      const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : -Infinity;
                      return tb - ta;
                    });
                    return {
                      limit(n: number) {
                        record.limit = n;
                        return {
                          maybeSingle() {
                            return Promise.resolve({ data: sorted[0] ?? null, error: null });
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`tabla inesperada: ${table}`);
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchConversationIdByPhone", () => {
  it("con dos conversaciones del mismo contacto, devuelve la más reciente por el ORDEN pedido a la base", async () => {
    const { client, calls } = createFakeSupabase("contact-1", [
      { id: "conv-vieja", contact_id: "contact-1", last_message_at: "2026-08-01T10:00:00Z" },
      { id: "conv-nueva", contact_id: "contact-1", last_message_at: "2026-09-08T10:00:00Z" },
    ]);

    const result = await fetchConversationIdByPhone(client, "+584121234567");

    expect(result).toBe("conv-nueva");
    // Lo que decide cuál es "la más reciente" es el `.order()` pedido a la
    // base, no el orden en que el fixture trae las filas: una mutación que
    // quite ese `.order()` no debe dejar pasar este caso igual.
    expect(calls).toHaveLength(1);
    expect(calls[0].order).toEqual(["last_message_at", { ascending: false, nullsFirst: false }]);
    expect(calls[0].limit).toBe(1);
  });

  it("sin contacto para ese teléfono, devuelve null y no consulta conversations", async () => {
    const { client, calls } = createFakeSupabase(null, []);

    const result = await fetchConversationIdByPhone(client, "+584129999999");

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("con contacto pero sin ninguna conversación, devuelve null", async () => {
    const { client } = createFakeSupabase("contact-2", []);

    const result = await fetchConversationIdByPhone(client, "+584125555555");

    expect(result).toBeNull();
  });
});
