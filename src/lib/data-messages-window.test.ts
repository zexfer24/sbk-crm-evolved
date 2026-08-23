import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CHAT_MESSAGES_WINDOW, fetchMessages, fetchMessagesBefore } from "@/lib/data";

// ---------------------------------------------------------------------------
// Fake del query builder para la ventana de mensajes:
// `.from().select().eq().order().limit()` y su variante con `.lt()` para
// pedir lo anterior a un mensaje. Guarda cada llamada para poder afirmar
// sobre el orden pedido, que es justamente donde está el riesgo: pedir los
// últimos N exige orden DESCENDENTE y luego invertir.
// ---------------------------------------------------------------------------

interface QueryCall {
  orderAscending: boolean | undefined;
  limit: number;
  ltValue?: string;
}

function makeRow(index: number) {
  return {
    id: `msg-${index}`,
    conversation_id: "conv-1",
    direction: "inbound" as const,
    sender_type: "customer" as const,
    message_type: "text" as const,
    content: `mensaje ${index}`,
    template_name: null,
    media_url: null,
    is_internal_note: false,
    whatsapp_status: null,
    reply_to_message_id: null,
    created_at: new Date(2024, 0, 1, 0, 0, index).toISOString(),
    sender_agent: null,
  };
}

/** `rows` va en orden cronológico ascendente, como están en la tabla. */
function createFakeSupabase(rows: ReturnType<typeof makeRow>[]) {
  const calls: QueryCall[] = [];

  function resolver(ascending: boolean | undefined, ltValue?: string) {
    return {
      // La rama sin ventana pagina con `.range()`; se incluye para poder
      // comprobar que ese camino sigue trayendo el historial completo.
      range(from: number, to: number) {
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
      },
      limit(count: number) {
        calls.push({ orderAscending: ascending, limit: count, ltValue });
        const pool = ltValue ? rows.filter((r) => r.created_at < ltValue) : rows;
        // Descendente = los más nuevos primero.
        const ordered = ascending === false ? [...pool].reverse() : pool;
        return Promise.resolve({ data: ordered.slice(0, count), error: null });
      },
    };
  }

  const client = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                order(_column: string, opts?: { ascending?: boolean }) {
                  return {
                    ...resolver(opts?.ascending),
                    lt(_col: string, value: string) {
                      return resolver(opts?.ascending, value);
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

  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchMessages · ventana", () => {
  /**
   * Abrir un chat traía TODO su historial. En una conversación larga son
   * miles de filas viajando al navegador cada vez que se hace clic en ella,
   * cuando lo único que se ve al abrir son los últimos mensajes.
   */
  it("trae solo los últimos mensajes cuando se pide una ventana", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 500 }, (_, i) => makeRow(i))
    );

    const result = await fetchMessages(client, "conv-1", { limit: CHAT_MESSAGES_WINDOW });

    expect(result).toHaveLength(CHAT_MESSAGES_WINDOW);
    // Pedir "los últimos" exige orden descendente en la consulta.
    expect(calls[0].orderAscending).toBe(false);
  });

  /**
   * El chat se lee de arriba hacia abajo: por más que la consulta pida los
   * más nuevos primero, lo que se pinta tiene que quedar en orden
   * cronológico o la conversación se lee al revés.
   */
  it("devuelve la ventana en orden cronológico", async () => {
    const { client } = createFakeSupabase(Array.from({ length: 500 }, (_, i) => makeRow(i)));

    const result = await fetchMessages(client, "conv-1", { limit: 3 });

    expect(result.map((m) => m.content)).toEqual(["mensaje 497", "mensaje 498", "mensaje 499"]);
  });

  /** Sin ventana pedida se conserva el comportamiento de traer el historial entero. */
  it("sigue trayendo todo cuando no se pide ventana", async () => {
    const { client } = createFakeSupabase(Array.from({ length: 40 }, (_, i) => makeRow(i)));

    const result = await fetchMessages(client, "conv-1");

    expect(result).toHaveLength(40);
  });
});

describe("fetchMessagesBefore", () => {
  /**
   * Es lo que hace que acotar la ventana no le quite nada al asesor: el
   * historial viejo sigue disponible, se pide cuando hace falta.
   */
  it("trae los mensajes anteriores a uno dado, en orden cronológico", async () => {
    const { client, calls } = createFakeSupabase(
      Array.from({ length: 500 }, (_, i) => makeRow(i))
    );
    const corte = new Date(2024, 0, 1, 0, 0, 100).toISOString();

    const result = await fetchMessagesBefore(client, "conv-1", corte, 3);

    expect(calls[0].ltValue).toBe(corte);
    expect(result.map((m) => m.content)).toEqual(["mensaje 97", "mensaje 98", "mensaje 99"]);
  });

  /** Al llegar al principio del hilo no hay nada anterior que traer. */
  it("devuelve vacío cuando ya no queda historial", async () => {
    const { client } = createFakeSupabase(Array.from({ length: 500 }, (_, i) => makeRow(i)));
    const primero = new Date(2024, 0, 1, 0, 0, 0).toISOString();

    const result = await fetchMessagesBefore(client, "conv-1", primero, 20);

    expect(result).toEqual([]);
  });
});
