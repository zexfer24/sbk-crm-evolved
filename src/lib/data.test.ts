import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchMessages } from "@/lib/data";

// ---------------------------------------------------------------------------
// Fake SupabaseClient: simula el query builder encadenable que usa
// fetchMessages (`.from().select().eq().order().range()`), devolviendo
// páginas reales de datos según el rango pedido. No es un mock genérico:
// reproduce el comportamiento de paginación de PostgREST para poder
// verificar que fetchMessages pagina correctamente.
// ---------------------------------------------------------------------------

interface RawMessageRow {
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  sender_type: "customer" | "agent" | "ai" | "system";
  message_type: "text";
  content: string | null;
  template_name: string | null;
  media_url: string | null;
  is_internal_note: boolean;
  whatsapp_status: null;
  reply_to_message_id: string | null;
  created_at: string;
  sender_agent: null;
}

interface RangeCall {
  table: string;
  eqColumn: string;
  eqValue: string;
  orderColumn: string;
  orderAscending: boolean | undefined;
  from: number;
  to: number;
}

function makeRow(index: number, conversationId: string): RawMessageRow {
  // created_at estrictamente creciente para respetar el orden ascendente.
  const createdAt = new Date(2024, 0, 1, 0, 0, index).toISOString();
  return {
    id: `msg-${index}`,
    conversation_id: conversationId,
    direction: "inbound",
    sender_type: "customer",
    message_type: "text",
    content: `mensaje ${index}`,
    template_name: null,
    media_url: null,
    is_internal_note: false,
    whatsapp_status: null,
    reply_to_message_id: null,
    created_at: createdAt,
    sender_agent: null,
  };
}

/**
 * Crea un fake de SupabaseClient cuyo `.range(from, to)` devuelve un
 * "slice" real del arreglo `rows` (simulando paginación de PostgREST).
 * Si `errorOnCallNumber` coincide con el número de llamada a `.range`
 * (1-indexed), esa página devuelve `{ data: null, error }` en su lugar.
 */
function createFakeSupabase(
  rows: RawMessageRow[],
  options?: { errorOnCallNumber?: number }
) {
  const calls: RangeCall[] = [];
  let rangeCallCount = 0;

  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq(eqColumn: string, eqValue: string) {
              return {
                order(orderColumn: string, orderOpts?: { ascending?: boolean }) {
                  return {
                    range(from: number, to: number) {
                      rangeCallCount += 1;
                      calls.push({
                        table,
                        eqColumn,
                        eqValue,
                        orderColumn,
                        orderAscending: orderOpts?.ascending,
                        from,
                        to,
                      });

                      if (options?.errorOnCallNumber === rangeCallCount) {
                        return Promise.resolve({
                          data: null,
                          error: { message: "boom: fallo simulado de PostgREST" },
                        });
                      }

                      const page = rows.slice(from, to + 1);
                      return Promise.resolve({ data: page, error: null });
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

  return {
    client: client as unknown as SupabaseClient,
    getCalls: () => calls,
  };
}

describe("fetchMessages", () => {
  it("devuelve exactamente los mensajes de una conversación con menos de 1000 (sin paginar de más)", async () => {
    const conversationId = "conv-short";
    const rows = [
      makeRow(0, conversationId),
      makeRow(1, conversationId),
      makeRow(2, conversationId),
    ];
    const { client, getCalls } = createFakeSupabase(rows);

    const result = await fetchMessages(client, conversationId);

    expect(result).toHaveLength(3);
    expect(result.map((m) => m.id)).toEqual(["msg-0", "msg-1", "msg-2"]);

    // Como la primera página (de tamaño PAGE_SIZE) devolvió menos filas que
    // el tamaño de página, no debe haber pedido una segunda página.
    expect(getCalls()).toHaveLength(1);
    expect(getCalls()[0].from).toBe(0);
    expect(getCalls()[0].to).toBe(999);
  });

  it("devuelve los 2500 mensajes completos de una conversación con más de 1000 (paginando en 3 páginas)", async () => {
    const conversationId = "conv-long";
    const totalMessages = 2500;
    const rows = Array.from({ length: totalMessages }, (_, i) => makeRow(i, conversationId));
    const { client, getCalls } = createFakeSupabase(rows);

    const result = await fetchMessages(client, conversationId);

    expect(result).toHaveLength(totalMessages);
    expect(result[0].id).toBe("msg-0");
    expect(result[totalMessages - 1].id).toBe(`msg-${totalMessages - 1}`);
    // Verifica que no hay huecos ni duplicados en la secuencia completa.
    expect(result.map((m) => m.id)).toEqual(rows.map((r) => r.id));

    const calls = getCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ from: 0, to: 999 });
    expect(calls[1]).toMatchObject({ from: 1000, to: 1999 });
    expect(calls[2]).toMatchObject({ from: 2000, to: 2999 });

    // Cada página debe mantener el mismo filtro y el mismo orden estable.
    for (const call of calls) {
      expect(call.table).toBe("messages");
      expect(call.eqColumn).toBe("conversation_id");
      expect(call.eqValue).toBe(conversationId);
      expect(call.orderColumn).toBe("created_at");
      expect(call.orderAscending).toBe(true);
    }
  });

  it("propaga el error si una página intermedia falla, en vez de devolver datos parciales en silencio", async () => {
    const conversationId = "conv-error";
    const totalMessages = 2500;
    const rows = Array.from({ length: totalMessages }, (_, i) => makeRow(i, conversationId));
    // La primera página (llamada 1) tiene éxito; la segunda (llamada 2) falla.
    const { client, getCalls } = createFakeSupabase(rows, { errorOnCallNumber: 2 });

    await expect(fetchMessages(client, conversationId)).rejects.toMatchObject({
      message: "boom: fallo simulado de PostgREST",
    });

    // No debe haber intentado pedir una tercera página tras el error.
    expect(getCalls()).toHaveLength(2);
  });
});
