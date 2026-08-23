import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent } from "@/lib/types";
import { closeSaleWithContactInfo, type SaleLineItem } from "@/lib/mutations";

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
