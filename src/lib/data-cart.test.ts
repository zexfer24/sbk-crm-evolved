import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCart } from "@/lib/data";

// ---------------------------------------------------------------------------
// T8, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026). `fetchCart` lee el carrito persistente de una
// conversación (`conversation_cart_items`) con el producto y, si el renglón
// vino de una cotización de Seba, el precio que se cotizó. Este archivo fija
// el mapeo (snake_case -> camelCase, `quotedPriceUsd` sale de la cotización
// enlazada y es `null` sin ella) y que la consulta filtre por la conversación
// pedida, en el orden en que se fueron agregando los renglones.
// ---------------------------------------------------------------------------

function rawItem(over: Record<string, unknown> = {}) {
  return {
    id: "cart-1",
    conversation_id: "conv-1",
    product_id: "prod-1",
    quantity: 2,
    origin: "quote",
    quote_id: "q-1",
    added_by: "agent-1",
    created_at: "2026-09-29T10:00:00Z",
    updated_at: "2026-09-29T10:05:00Z",
    quote: { price_usd: "18.50" },
    product: {
      id: "prod-1",
      name: "Carburador PZ27",
      brand: "Keihin",
      price: "20.00",
      currency: "USD",
      stock_quantity: 5,
      description: null,
      is_active: true,
      updated_at: "2026-09-29T09:00:00Z",
      weight_kg: null,
      saint_code: "A123",
      saint_added_at: null,
      saint_removed_at: null,
      product_compatibility: [{ id: "c-1", moto_brand: "Bera", moto_model: "SBR" }],
    },
    ...over,
  };
}

type Orderable = { order: (column: string, options: unknown) => Promise<unknown> & Orderable };

function createFakeSupabase(result: { data: unknown[] | null; error: unknown }) {
  const calls: { table?: string; select?: string; eq?: [string, unknown]; order: [string, unknown][] } = { order: [] };

  // `.order()` es encadenable (created_at + id) y a la vez esperable: devuelve
  // una promesa que también tiene `.order`.
  const orderable: Orderable = {
    order(column, options) {
      calls.order.push([column, options]);
      return Object.assign(Promise.resolve(result), { order: orderable.order });
    },
  };

  const client = {
    from(table: string) {
      calls.table = table;
      return {
        select(columns: string) {
          calls.select = columns;
          return {
            eq(column: string, value: unknown) {
              calls.eq = [column, value];
              return orderable;
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchCart", () => {
  it("lee los renglones de LA conversación pedida, en el orden en que se agregaron", async () => {
    const { client, calls } = createFakeSupabase({ data: [], error: null });

    await fetchCart(client, "conv-7");

    expect(calls.table).toBe("conversation_cart_items");
    expect(calls.eq).toEqual(["conversation_id", "conv-7"]);
    expect(calls.order).toEqual([
      ["created_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("trae el producto y el precio cotizado en la misma consulta", async () => {
    const { client, calls } = createFakeSupabase({ data: [], error: null });

    await fetchCart(client, "conv-1");

    expect(calls.select).toContain("product:products(");
    expect(calls.select).toContain("quote:conversation_quotes(price_usd)");
  });

  it("mapea el renglón, el producto completo y el precio cotizado como número", async () => {
    const { client } = createFakeSupabase({ data: [rawItem()], error: null });

    const [item] = await fetchCart(client, "conv-1");

    expect(item).toMatchObject({
      id: "cart-1",
      conversationId: "conv-1",
      productId: "prod-1",
      quantity: 2,
      origin: "quote",
      quoteId: "q-1",
      quotedPriceUsd: 18.5,
      addedBy: "agent-1",
    });
    expect(item.product).toMatchObject({
      id: "prod-1",
      name: "Carburador PZ27",
      price: 20,
      currency: "USD",
      stockQuantity: 5,
      saintCode: "A123",
    });
    expect(item.product.compatibility).toEqual([{ id: "c-1", motoBrand: "Bera", motoModel: "SBR" }]);
  });

  it("un renglón sin cotización enlazada tiene quotedPriceUsd null", async () => {
    const { client } = createFakeSupabase({
      data: [rawItem({ origin: "inventory", quote_id: null, quote: null })],
      error: null,
    });

    const [item] = await fetchCart(client, "conv-1");

    expect(item.quotedPriceUsd).toBeNull();
    expect(item.quoteId).toBeNull();
  });

  it("propaga el error de la base: un carrito que no se pudo leer no se pinta como vacío", async () => {
    const { client } = createFakeSupabase({ data: null, error: new Error("boom") });

    await expect(fetchCart(client, "conv-1")).rejects.toThrow("boom");
  });
});
