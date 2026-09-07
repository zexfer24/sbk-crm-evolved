import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent } from "@/lib/types";
import {
  closeSaleWithContactInfo,
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
