import { describe, expect, it } from "vitest";
import type { ConversationCartItem, Product } from "@/lib/types";
import {
  cartToSaleLines,
  cartTotals,
  priceCartLines,
  quoteComparisonLabel,
} from "@/lib/conversation-cart";

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "Carburador PZ27",
    brand: null,
    price: 20,
    currency: "USD",
    stockQuantity: 5,
    description: null,
    isActive: true,
    updatedAt: "2026-09-29T10:00:00.000Z",
    compatibility: [],
    weightKg: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    ...over,
  };
}

function item(over: Partial<ConversationCartItem> = {}): ConversationCartItem {
  const p = over.product ?? product();
  return {
    id: "cart-1",
    conversationId: "conv-1",
    productId: p.id,
    quantity: 1,
    origin: "inventory",
    quoteId: null,
    quotedPriceUsd: null,
    addedBy: "agent-1",
    createdAt: "2026-09-29T10:00:00.000Z",
    updatedAt: "2026-09-29T10:00:00.000Z",
    product: p,
    ...over,
  };
}

describe("priceCartLines — el precio es el VIGENTE (D6), nunca el cotizado", () => {
  it("un producto en dólares se cobra a su precio de hoy y da su equivalente en bolívares", () => {
    const [line] = priceCartLines([item({ quantity: 2 })], 40);
    expect(line.unitPriceUsd).toBe(20);
    expect(line.unitPriceBs).toBe(800);
    expect(line.subtotalUsd).toBe(40);
    expect(line.subtotalBs).toBe(1600);
  });

  it("aunque el renglón venga de una cotización, se factura el precio de hoy y no el cotizado", () => {
    // Seba cotizó $18; el producto hoy vale $20. Lo que se cobra es $20.
    const [line] = priceCartLines(
      [item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 18, quantity: 3 })],
      40
    );
    expect(line.unitPriceUsd).toBe(20);
    expect(line.subtotalUsd).toBe(60);
  });

  it("un producto en bolívares pasa por usdFromBs: redondeo hacia arriba al décimo, a favor del negocio", () => {
    // 101 Bs / 40 = 2,525 -> $2,60 (no $2,53 ni $2,50).
    const [line] = priceCartLines([item({ product: product({ currency: "VES", price: 101 }) })], 40);
    expect(line.unitPriceUsd).toBe(2.6);
    expect(line.unitPriceBs).toBe(101);
  });

  it("sin tasa, un producto en bolívares queda sin precio en dólares (no se inventa uno)", () => {
    const [line] = priceCartLines([item({ product: product({ currency: "VES", price: 101 }) })], 0);
    expect(line.unitPriceUsd).toBeNull();
    expect(line.subtotalUsd).toBeNull();
    expect(line.unitPriceBs).toBe(101);
  });

  it("sin tasa, un producto en dólares sí tiene precio pero no equivalente en bolívares", () => {
    const [line] = priceCartLines([item()], 0);
    expect(line.unitPriceUsd).toBe(20);
    expect(line.unitPriceBs).toBeNull();
    expect(line.subtotalBs).toBeNull();
  });
});

describe("quoteComparisonLabel — «cotizado $X · hoy $Y» solo cuando difieren", () => {
  it("muestra las dos cifras cuando el precio de hoy no es el que cotizó Seba", () => {
    const [line] = priceCartLines([item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 18 })], 40);
    expect(line.priceChange).toEqual({ quotedUsd: 18, todayUsd: 20 });
    expect(quoteComparisonLabel(line)).toBe("cotizado $18.00 · hoy $20.00");
  });

  it("no muestra nada si el precio cotizado es igual al de hoy", () => {
    const [line] = priceCartLines([item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 20 })], 40);
    expect(line.priceChange).toBeNull();
    expect(quoteComparisonLabel(line)).toBeNull();
  });

  it("no muestra nada si el renglón no viene de una cotización", () => {
    const [line] = priceCartLines([item({ quotedPriceUsd: null })], 40);
    expect(quoteComparisonLabel(line)).toBeNull();
  });

  it("no compara si hoy no se puede calcular el precio en dólares", () => {
    const [line] = priceCartLines(
      [item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 3, product: product({ currency: "VES", price: 101 }) })],
      0
    );
    expect(quoteComparisonLabel(line)).toBeNull();
  });
});

describe("cartTotals — el total en $ es la suma de lo que se factura", () => {
  it("suma los subtotales en dólares por renglón y los bolívares por renglón", () => {
    const lines = priceCartLines(
      [
        item({ id: "a", quantity: 2 }),
        item({ id: "b", productId: "prod-2", product: product({ id: "prod-2", price: 5 }), quantity: 3 }),
      ],
      40
    );
    expect(cartTotals(lines)).toEqual({ usd: 55, bs: 2200, unpricedCount: 0 });
  });

  it("no vuelve a redondear el total: suma los dólares ya redondeados por renglón", () => {
    // Dos renglones VES de 101 Bs a tasa 40: cada uno $2,60 -> $5,20 en total.
    // Convertir el total en bolívares (202 / 40 = 5,05) habría dado $5,10.
    const lines = priceCartLines(
      [
        item({ id: "a", product: product({ id: "p1", currency: "VES", price: 101 }) }),
        item({ id: "b", productId: "p2", product: product({ id: "p2", currency: "VES", price: 101 }) }),
      ],
      40
    );
    expect(cartTotals(lines).usd).toBe(5.2);
    expect(cartTotals(lines).bs).toBe(202);
  });

  it("no arrastra colas de coma flotante", () => {
    const lines = priceCartLines([item({ quantity: 3, product: product({ price: 0.1 }) })], 40);
    expect(cartTotals(lines).usd).toBe(0.3);
  });

  it("cuenta los renglones sin precio y los deja fuera del total en dólares", () => {
    const lines = priceCartLines(
      [
        item({ id: "a" }),
        item({ id: "b", productId: "p2", product: product({ id: "p2", currency: "VES", price: 101 }) }),
      ],
      0
    );
    const totals = cartTotals(lines);
    expect(totals.usd).toBe(20);
    expect(totals.unpricedCount).toBe(1);
    expect(totals.bs).toBeNull();
  });

  it("un carrito vacío suma cero", () => {
    expect(cartTotals(priceCartLines([], 40))).toEqual({ usd: 0, bs: 0, unpricedCount: 0 });
  });
});

describe("cartToSaleLines — lo que recibe closeSaleWithContactInfo", () => {
  it("arma los renglones de la venta con el precio vigente y el vínculo por product_id", () => {
    const lines = priceCartLines(
      [item({ id: "cart-7", origin: "quote", quoteId: "q-1", quotedPriceUsd: 18, quantity: 2 })],
      40
    );
    expect(cartToSaleLines(lines)).toEqual([
      {
        id: "cart-7",
        origin: "quote",
        productId: "prod-1",
        description: "Carburador PZ27",
        unitPrice: 20,
        quantity: 2,
      },
    ]);
  });

  it("deja fuera los renglones que no tienen precio calculable", () => {
    const lines = priceCartLines(
      [item({ id: "a", product: product({ currency: "VES", price: 101 }) })],
      0
    );
    expect(cartToSaleLines(lines)).toEqual([]);
  });
});
