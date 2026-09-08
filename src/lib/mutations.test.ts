import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent } from "@/lib/types";
import {
  closeSaleWithContactInfo,
  createContactConversation,
  markConversationRead,
  markConversationUnread,
  pinConversation,
  setAiEnabled,
  unassign,
  unpinConversation,
  type SaleLineItem,
} from "@/lib/mutations";

const AGENT: Agent = {
  id: "agent-1",
  displayName: "José Riera",
  fullName: "José Riera",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function createFakeSupabase() {
  const calls: { table: string; op: "insert" | "update"; payload: unknown }[] = [];
  let nextOrderId = 1;

  const client = {
    from(table: string) {
      if (table === "contacts") {
        return { update: (payload: unknown) => ({ eq: async () => { calls.push({ table, op: "update", payload }); return { error: null }; } }) };
      }
      if (table === "orders") {
        return {
          insert: (payload: unknown) => {
            calls.push({ table, op: "insert", payload });
            return {
              select: () => ({
                single: async () => ({ data: { id: `order-${nextOrderId++}` }, error: null }),
              }),
            };
          },
        };
      }
      if (table === "order_items") {
        return {
          insert: async (payload: unknown) => {
            calls.push({ table, op: "insert", payload });
            return { error: null };
          },
        };
      }
      if (table === "conversations") {
        return { update: (payload: unknown) => ({ eq: async () => { calls.push({ table, op: "update", payload }); return { error: null }; } }) };
      }
      if (table === "messages") {
        return { insert: async (payload: unknown) => { calls.push({ table, op: "insert", payload }); return { error: null }; } };
      }
      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

const CONTACT_DETAILS = {
  displayName: "Cliente Demo",
  cedulaType: "V" as const,
  cedulaNumber: "12345678",
  state: "Barinas",
  city: "Barinas",
  address: "Calle Falsa 123",
  paymentProofUrl: "https://example.com/proof.jpg",
  paymentMethod: "pago_movil" as const,
};

describe("closeSaleWithContactInfo — el monto sale del catálogo, nunca de un número a mano", () => {
  it("rechaza cerrar la venta sin un solo renglón", async () => {
    const { client } = createFakeSupabase();
    await expect(
      closeSaleWithContactInfo(client, "conv-1", "contact-1", AGENT, CONTACT_DETAILS, [], 40)
    ).rejects.toThrow(/al menos un repuesto/i);
  });

  it("crea la orden con el total exacto de los renglones y enlaza la conversación", async () => {
    const { client, calls } = createFakeSupabase();
    const items: SaleLineItem[] = [
      { id: "q-1", origin: "quote", productId: "prod-1", description: "Carburador PZ27", unitPrice: 18, quantity: 1 },
      { id: "prod-2", origin: "inventory", productId: "prod-2", description: "Kit de arrastre", unitPrice: 32.5, quantity: 2 },
    ];

    await closeSaleWithContactInfo(client, "conv-1", "contact-1", AGENT, CONTACT_DETAILS, items, 40);

    const orderInsert = calls.find((c) => c.table === "orders" && c.op === "insert");
    expect(orderInsert?.payload).toMatchObject({
      contact_id: "contact-1",
      currency: "USD",
      total_amount: 83, // 18*1 + 32.5*2
      bcv_rate: 40,
    });

    const itemsInsert = calls.find((c) => c.table === "order_items" && c.op === "insert");
    expect(itemsInsert?.payload).toEqual([
      { order_id: "order-1", product_id: "prod-1", description: "Carburador PZ27", quantity: 1, unit_price: 18 },
      { order_id: "order-1", product_id: "prod-2", description: "Kit de arrastre", quantity: 2, unit_price: 32.5 },
    ]);

    const conversationUpdate = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(conversationUpdate?.payload).toMatchObject({
      deal_status: "won",
      order_id: "order-1",
    });
  });
});

/**
 * Apartar un chat y volver a darlo por leído son la misma acción invertida.
 * Lo que estos tests fijan es que ninguna de las dos toque `unread_count`
 * para mentir: apartar no inventa un mensaje, y dar por leído sí tiene que
 * limpiar las dos señales a la vez —si no, un chat apartado seguiría en
 * "Sin leer" para siempre después de abrirlo.
 */
describe("marcar una conversación como no leída", () => {
  it("aparta el chat sin tocar el contador de mensajes sin leer", async () => {
    const { client, calls } = createFakeSupabase();

    await markConversationUnread(client, "conv-1");

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update?.payload).toEqual({ manually_unread: true });
  });

  it("darla por leída limpia el contador y el apartado a la vez", async () => {
    const { client, calls } = createFakeSupabase();

    await markConversationRead(client, "conv-1");

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update?.payload).toEqual({ unread_count: 0, manually_unread: false });
  });
});

/**
 * T2.2 del plan "La bandeja que no pierde" (5/9/2026): hasta tres chats
 * fijados por asesor. `pinConversation`/`unpinConversation` no arman la
 * regla del tope de tres —eso vive en el trigger
 * `conversation_pins_limit_before_insert` de la migración
 * 20260905040000_conversation_pins.sql, y lo verifica `supabase/tests/pins.sql`
 * contra la base real—; lo único que estos tests fijan es que el par
 * agente/conversación viaja tal cual a la tabla, y que un error de la base
 * (el del cuarto pin, u otro cualquiera) sube sin que la función lo trague.
 */
/**
 * T7, corrida "La IA ve lo que llega" (8/9/2026): human-handled.ts dejó de
 * preguntar "¿alguna vez escribió un asesor?" y pasó a comparar fechas, así
 * que estas dos mutaciones ya no dependen de nada más que de sus columnas
 * propias para devolver un chat a la IA — no tocan `messages`, no tocan
 * fechas. Lo único que fijan estos tests es que el UPDATE de `conversations`
 * lleva EXACTAMENTE esa columna y ninguna otra: si algún día empezara a
 * escribir también, por ejemplo, `last_customer_message_at` a mano, rompería
 * los dos candados documentados en CLAUDE.md sobre esa columna.
 */
describe("setAiEnabled / unassign — devuelven el chat a la IA sin tocar messages", () => {
  it("setAiEnabled(true) actualiza SOLO ai_enabled", async () => {
    const { client, calls } = createFakeSupabase();

    await setAiEnabled(client, "conv-1", AGENT, true);

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update?.payload).toEqual({ ai_enabled: true });
  });

  it("unassign actualiza SOLO assigned_agent_id", async () => {
    const { client, calls } = createFakeSupabase();

    await unassign(client, "conv-1", AGENT, "María");

    const update = calls.find((c) => c.table === "conversations" && c.op === "update");
    expect(update?.payload).toEqual({ assigned_agent_id: null });
  });
});

describe("pinConversation / unpinConversation", () => {
  function createFakePinsSupabase() {
    const calls: { op: "insert" | "delete"; agentId: string; conversationId: string }[] = [];

    const client = {
      from(table: string) {
        if (table !== "conversation_pins") {
          throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
        }
        return {
          insert: async (payload: { agent_id: string; conversation_id: string }) => {
            calls.push({ op: "insert", agentId: payload.agent_id, conversationId: payload.conversation_id });
            return { error: null };
          },
          delete: () => ({
            eq: (_col1: string, agentId: string) => ({
              eq: async (_col2: string, conversationId: string) => {
                calls.push({ op: "delete", agentId, conversationId });
                return { error: null };
              },
            }),
          }),
        };
      },
    };

    return { client: client as unknown as SupabaseClient, calls };
  }

  it("fija: inserta el par agente/conversación", async () => {
    const { client, calls } = createFakePinsSupabase();

    await pinConversation(client, "agent-1", "conv-9");

    expect(calls).toEqual([{ op: "insert", agentId: "agent-1", conversationId: "conv-9" }]);
  });

  it("propaga el error del cuarto pin en vez de tragárselo", async () => {
    const client = {
      from: () => ({
        insert: async () => ({
          error: new Error("Ya tenés tres conversaciones fijadas. Desfijá una para poder fijar esta."),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(pinConversation(client, "agent-1", "conv-9")).rejects.toThrow(/tres conversaciones fijadas/);
  });

  it("desfija: borra por agente Y conversación, no solo por conversación", async () => {
    const { client, calls } = createFakePinsSupabase();

    await unpinConversation(client, "agent-1", "conv-9");

    expect(calls).toEqual([{ op: "delete", agentId: "agent-1", conversationId: "conv-9" }]);
  });
});

/**
 * T6 (8/9/2026): "Agregar contacto" desde la bandeja. El fake reproduce las
 * tres tablas que toca la mutación -- `whatsapp_channels` (vía
 * `fetchDefaultChannel`, ya probado aparte en `data.test.ts`), `contacts` y
 * `conversations` -- y deja simular el código `23505` (unique_violation) de
 * Postgres en cualquiera de los dos inserts, que es el camino real: repetir
 * el mismo teléfono es el caso de uso más probable, no un error.
 */
describe("createContactConversation — un contacto nace desde la bandeja", () => {
  interface ContactConversationFakeOptions {
    channelRow?: { id: string; status: string } | null;
    contactInsertError?: { code: string } | null;
    existingContactId?: string;
    conversationInsertError?: { code: string } | null;
    existingConversationId?: string;
  }

  function createContactFlowSupabase(options: ContactConversationFakeOptions = {}) {
    const calls: { table: string; op: "insert"; payload: unknown }[] = [];
    const channelRow = options.channelRow === undefined ? { id: "chan-1", status: "connected" } : options.channelRow;

    const client = {
      from(table: string) {
        if (table === "whatsapp_channels") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () =>
                    channelRow && channelRow.status === "connected"
                      ? { data: [channelRow], error: null }
                      : { data: [], error: null },
                }),
              }),
              order: () => ({
                limit: async () => (channelRow ? { data: [channelRow], error: null } : { data: [], error: null }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            insert: (payload: unknown) => {
              calls.push({ table, op: "insert", payload });
              return {
                select: () => ({
                  single: async () =>
                    options.contactInsertError
                      ? { data: null, error: options.contactInsertError }
                      : { data: { id: "contact-new" }, error: null },
                }),
              };
            },
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { id: options.existingContactId ?? "contact-existing" }, error: null }),
              }),
            }),
          };
        }
        if (table === "conversations") {
          return {
            insert: (payload: unknown) => {
              calls.push({ table, op: "insert", payload });
              return {
                select: () => ({
                  single: async () =>
                    options.conversationInsertError
                      ? { data: null, error: options.conversationInsertError }
                      : { data: { id: "conv-new" }, error: null },
                }),
              };
            },
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: { id: options.existingConversationId ?? "conv-existing" }, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "messages") {
          return {
            insert: async (payload: unknown) => {
              calls.push({ table, op: "insert", payload });
              return { error: null };
            },
          };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
    };

    return { client: client as unknown as SupabaseClient, calls };
  }

  it("crea contacto y conversación nuevos, y deja la nota interna de auditoría", async () => {
    const { client, calls } = createContactFlowSupabase();

    const result = await createContactConversation(client, {
      displayName: "Pedro Pérez",
      phoneNumber: "+584141234567",
      agent: AGENT,
    });

    expect(result).toEqual({ conversationId: "conv-new", existed: false });

    const contactInsert = calls.find((c) => c.table === "contacts");
    expect(contactInsert?.payload).toEqual({ display_name: "Pedro Pérez", phone_number: "+584141234567" });

    const conversationInsert = calls.find((c) => c.table === "conversations");
    expect(conversationInsert?.payload).toEqual({
      contact_id: "contact-new",
      whatsapp_channel_id: "chan-1",
      status: "open",
    });

    const noteInsert = calls.find((c) => c.table === "messages");
    expect(noteInsert?.payload).toMatchObject({
      conversation_id: "conv-new",
      direction: "outbound",
      sender_type: "system",
      sender_agent_id: AGENT.id,
      message_type: "system_event",
      is_internal_note: true,
      content: "Contacto agregado desde la bandeja por José Riera",
    });
  });

  it("sin ningún canal de WhatsApp configurado, no crea nada y lanza", async () => {
    const { client, calls } = createContactFlowSupabase({ channelRow: null });

    await expect(
      createContactConversation(client, { displayName: "Pedro", phoneNumber: "+584141234567", agent: AGENT })
    ).rejects.toThrow(/ningún canal/i);

    expect(calls).toEqual([]);
  });

  it("un teléfono repetido (23505 en contacts) reutiliza el contacto y marca existed sin dejar nota", async () => {
    const { client, calls } = createContactFlowSupabase({
      contactInsertError: { code: "23505" },
      existingContactId: "contact-existing",
    });

    const result = await createContactConversation(client, {
      displayName: "Pedro",
      phoneNumber: "+584141234567",
      agent: AGENT,
    });

    expect(result).toEqual({ conversationId: "conv-new", existed: true });

    const conversationInsert = calls.find((c) => c.table === "conversations");
    expect(conversationInsert?.payload).toMatchObject({ contact_id: "contact-existing" });

    expect(calls.some((c) => c.table === "messages")).toBe(false);
  });

  it("una conversación repetida (23505 en conversations) reutiliza esa conversación y marca existed", async () => {
    const { client, calls } = createContactFlowSupabase({
      conversationInsertError: { code: "23505" },
      existingConversationId: "conv-repetida",
    });

    const result = await createContactConversation(client, {
      displayName: "Pedro",
      phoneNumber: "+584141234567",
      agent: AGENT,
    });

    expect(result).toEqual({ conversationId: "conv-repetida", existed: true });
    expect(calls.some((c) => c.table === "messages")).toBe(false);
  });

  it("un error de la base que no es 23505 sube tal cual, no se traga", async () => {
    const { client } = createContactFlowSupabase({
      contactInsertError: { code: "42501" },
    });

    await expect(
      createContactConversation(client, { displayName: "Pedro", phoneNumber: "+584141234567", agent: AGENT })
    ).rejects.toEqual({ code: "42501" });
  });
});
