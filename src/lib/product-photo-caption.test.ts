import { describe, expect, it } from "vitest";
import { productPhotoCaption } from "@/lib/product-photo-caption";
import { formatQuote } from "@/lib/ai/precio";
import type { Product } from "@/lib/types";

/**
 * Pie de la foto que un asesor manda desde el buscador del chat (30/10/2026,
 * plan «Cada repuesto con su foto», T6, D2): «nombre — precio» con el formato
 * con el que cotiza Seba, y NUNCA la palabra «envío» (trampa de
 * `cartSummaryText`: el precio promoción no incluye ni anuncia el envío).
 */

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "DISCO DE FRENO DELANTERO BERA SBR",
    brand: null,
    price: 87,
    currency: "VES",
    stockQuantity: 5,
    description: null,
    isActive: true,
    updatedAt: "2026-10-30T00:00:00.000Z",
    compatibility: [],
    weightKg: 2,
    shippingFeeUsd: 4,
    precioDivisaUsd: null,
    saintCode: "1234",
    saintAddedAt: null,
    saintRemovedAt: null,
    fotos: [],
    ...overrides,
  };
}

describe("productPhotoCaption", () => {
  it("con tasa lleva nombre, raya, BCV y Bs.", () => {
    const caption = productPhotoCaption(product(), 40);
    expect(caption).toContain("DISCO DE FRENO DELANTERO BERA SBR");
    expect(caption).toContain("—");
    expect(caption).toContain("BCV");
    expect(caption).toContain("Bs.");
  });

  it("producto en bolívares: el dólar sale de usdFromBs (redondeo hacia arriba a $0,10)", () => {
    // 87 Bs / 40 = 2,175 -> sube a 2,20
    expect(productPhotoCaption(product(), 40)).toBe(
      `DISCO DE FRENO DELANTERO BERA SBR — ${formatQuote(2.2, 87)}`
    );
  });

  it("producto en dólares: el dólar es el precio y los bolívares salen de la tasa", () => {
    const caption = productPhotoCaption(product({ price: 14.1, currency: "USD" }), 40);
    expect(caption).toBe(`DISCO DE FRENO DELANTERO BERA SBR — ${formatQuote(14.1, 564)}`);
  });

  it("sin tasa devuelve solo el nombre", () => {
    expect(productPhotoCaption(product(), 0)).toBe("DISCO DE FRENO DELANTERO BERA SBR");
    expect(productPhotoCaption(product({ currency: "USD", price: 10 }), -1)).toBe(
      "DISCO DE FRENO DELANTERO BERA SBR"
    );
  });

  it("nunca dice «envío», con o sin tarifa MRW", () => {
    const casos = [
      product(),
      product({ currency: "USD", price: 14.1 }),
      product({ shippingFeeUsd: null, weightKg: null }),
      product({ name: "ACEITE 20W50" }),
    ];
    for (const p of casos) {
      expect(productPhotoCaption(p, 40)).not.toMatch(/env[ií]o/i);
      expect(productPhotoCaption(p, 0)).not.toMatch(/env[ií]o/i);
    }
  });
});
