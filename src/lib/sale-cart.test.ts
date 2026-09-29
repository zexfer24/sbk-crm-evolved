import { describe, expect, it } from "vitest";
import type { Product } from "@/lib/types";
import { productPriceUsd } from "@/lib/sale-cart";

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod-9",
    name: "Filtro de aceite",
    brand: "Genérico",
    price: 4.5,
    currency: "USD",
    stockQuantity: 20,
    description: null,
    isActive: true,
    updatedAt: "2026-08-22T10:00:00.000Z",
    compatibility: [],
    weightKg: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    ...over,
  };
}

describe("productPriceUsd", () => {
  it("deja el precio en dólares tal cual", () => {
    expect(productPriceUsd(product({ price: 4.5, currency: "USD" }), 40)).toBe(4.5);
  });

  it("convierte desde bolívares con la tasa", () => {
    expect(productPriceUsd(product({ price: 800, currency: "VES" }), 40)).toBe(20);
  });

  // Sin tasa no se puede convertir, y meter un cero en la venta sería peor
  // que no dejar agregarlo.
  it("devuelve null si hay que convertir y no hay tasa", () => {
    expect(productPriceUsd(product({ price: 800, currency: "VES" }), 0)).toBeNull();
  });

  // 27/9/2026 ("El mostrador busca sin salir del chat", D1/D3): la venta
  // cobra el mismo dólar redondeado hacia arriba que ve el asesor en
  // Inventario, no el valor exacto sin redondear. 87 / 40 = 2,175.
  it("redondea hacia arriba al siguiente múltiplo de $0,10, igual que Inventario", () => {
    expect(productPriceUsd(product({ price: 87, currency: "VES" }), 40)).toBe(2.2);
  });
});
