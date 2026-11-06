import { describe, expect, it } from "vitest";
import type { ConversationCartItem, Product } from "@/lib/types";
import { cartTotals, priceCartLines } from "@/lib/conversation-cart";
import { lineasEnDivisa, MOTIVO_COPIA_SIN_DIVISA, precioDivisaRenglon } from "@/lib/carrito-divisa";

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
    updatedAt: "2026-11-06T10:00:00.000Z",
    compatibility: [],
    weightKg: null,
    shippingFeeUsd: null,
    precioDivisaUsd: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    fotos: [],
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
    priceKind: "promocion",
    addedBy: "agent-1",
    createdAt: "2026-11-06T10:00:00.000Z",
    updatedAt: "2026-11-06T10:00:00.000Z",
    product: p,
    ...over,
  };
}

describe("precioDivisaRenglon — promoción", () => {
  it("devuelve la divisa tal cual", () => {
    expect(precioDivisaRenglon(item({ product: product({ precioDivisaUsd: 4.6 }) }))).toBe(4.6);
  });

  it("sin divisa válida (null, 0, negativo, NaN) no hay precio", () => {
    for (const v of [null, 0, -1, Number.NaN]) {
      expect(precioDivisaRenglon(item({ product: product({ precioDivisaUsd: v }) }))).toBeNull();
    }
  });
});

describe("precioDivisaRenglon — estándar (divisa + tarifa MRW)", () => {
  const est = (precioDivisaUsd: number | null, shippingFeeUsd: number | null) =>
    item({ priceKind: "estandar", product: product({ precioDivisaUsd, shippingFeeUsd }) });

  it("suma la tarifa sin recargo ni tasa", () => {
    expect(precioDivisaRenglon(est(4.6, 1.4))).toBe(6);
  });

  it("no arrastra la cola de coma flotante (0.1 + 0.2)", () => {
    expect(precioDivisaRenglon(est(0.1, 0.2))).toBe(0.3);
  });

  it("sin tarifa o sin divisa no hay precio", () => {
    expect(precioDivisaRenglon(est(4.6, null))).toBeNull();
    expect(precioDivisaRenglon(est(null, 1.4))).toBeNull();
  });
});

describe("lineasEnDivisa", () => {
  it("sin Bs. ni aviso de cambio, y subtotal = unitario x cantidad", () => {
    const entrada = priceCartLines(
      [item({ quantity: 3, quotedPriceUsd: 15, product: product({ precioDivisaUsd: 4.6 }) })],
      40,
    );
    expect(entrada[0].priceChange).not.toBeNull();
    const [l] = lineasEnDivisa(entrada);
    expect(l.unitPriceUsd).toBe(4.6);
    expect(l.subtotalUsd).toBe(13.8);
    expect(l.unitPriceBs).toBeNull();
    expect(l.subtotalBs).toBeNull();
    expect(l.priceChange).toBeNull();
    expect(l.quotedPriceUsd).toBe(15);
    expect(l.item).toBe(entrada[0].item);
  });

  it("no muta la entrada", () => {
    const entrada = priceCartLines([item({ quantity: 2, product: product({ precioDivisaUsd: 4.6 }) })], 40);
    const copia = structuredClone(entrada);
    lineasEnDivisa(entrada);
    expect(entrada).toEqual(copia);
  });

  it("caso de las capturas: 2 x 4,60 + 1 x 30,00 = 39,20, sin bolívares", () => {
    const a = item({ id: "a", quantity: 2, product: product({ id: "a", precioDivisaUsd: 4.6, weightKg: 0.5 }) });
    const b = item({ id: "b", quantity: 1, product: product({ id: "b", precioDivisaUsd: 30, weightKg: 1.2 }) });
    const lineas = priceCartLines([a, b], 40);
    const totales = cartTotals(lineasEnDivisa(lineas));
    expect(totales.usd).toBe(39.2);
    expect(totales.bs).toBeNull();
    expect(totales.unpricedCount).toBe(0);
    expect(totales.pesoKg).toBe(cartTotals(lineas).pesoKg);

    const c = item({ id: "c", product: product({ id: "c", precioDivisaUsd: null, weightKg: 1 }) });
    const con = cartTotals(lineasEnDivisa(priceCartLines([a, b, c], 40)));
    expect(con.unpricedCount).toBe(1);
    expect(con.usd).toBe(39.2);
  });

  it("expone el motivo para deshabilitar la copia", () => {
    expect(MOTIVO_COPIA_SIN_DIVISA).toBe("Hay productos sin precio divisa");
  });
});
