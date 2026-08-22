import { describe, expect, it } from "vitest";
import type { Product } from "@/lib/types";
import {
  INVENTORY_PAGE_SIZE,
  LOW_STOCK_THRESHOLD,
  aiVisibility,
  inventoryHref,
  inventoryPageRange,
  inventoryTotalPages,
  parseInventoryParams,
  parsePriceInput,
  parseStockInput,
  priceInBs,
  stockLevel,
  summarizeInventory,
} from "@/lib/inventory";

function product(over: Partial<Product> = {}): Product {
  return {
    id: "p1",
    name: "Carburador",
    brand: "Bera",
    price: 25,
    currency: "USD",
    stockQuantity: 10,
    description: null,
    isActive: true,
    updatedAt: "2026-08-20T10:00:00Z",
    compatibility: [],
    ...over,
  };
}

describe("stockLevel", () => {
  it("marca agotado en cero o menos", () => {
    expect(stockLevel(product({ stockQuantity: 0 }))).toBe("agotado");
    expect(stockLevel(product({ stockQuantity: -2 }))).toBe("agotado");
  });

  it("marca bajo hasta el umbral inclusive", () => {
    expect(stockLevel(product({ stockQuantity: 1 }))).toBe("bajo");
    expect(stockLevel(product({ stockQuantity: LOW_STOCK_THRESHOLD }))).toBe("bajo");
  });

  it("marca disponible por encima del umbral", () => {
    expect(stockLevel(product({ stockQuantity: LOW_STOCK_THRESHOLD + 1 }))).toBe("disponible");
  });
});

describe("aiVisibility", () => {
  // La herramienta de catálogo filtra `is_active = true`: un producto
  // desactivado deja de existir para la IA, aunque tenga stock.
  it("un producto inactivo no lo ve la IA", () => {
    expect(aiVisibility(product({ isActive: false })).visible).toBe(false);
  });

  // El stock sí viaja al modelo, así que un agotado se sigue cotizando
  // (con stock 0). Eso es visible, pero conviene advertirlo.
  it("un producto activo sin stock lo ve la IA, con advertencia", () => {
    const visibility = aiVisibility(product({ stockQuantity: 0 }));
    expect(visibility.visible).toBe(true);
    expect(visibility.warning).not.toBeNull();
  });

  it("un producto activo con stock se cotiza sin advertencias", () => {
    const visibility = aiVisibility(product({ stockQuantity: 8 }));
    expect(visibility.visible).toBe(true);
    expect(visibility.warning).toBeNull();
  });
});

describe("priceInBs", () => {
  it("convierte el precio en dólares con la tasa", () => {
    expect(priceInBs(product({ price: 25, currency: "USD" }), 40)).toBe(1000);
  });

  it("deja el precio que ya está en bolívares tal cual", () => {
    expect(priceInBs(product({ price: 1000, currency: "VES" }), 40)).toBe(1000);
  });

  it("no divide por cero cuando todavía no hay tasa", () => {
    expect(priceInBs(product({ price: 25, currency: "USD" }), 0)).toBeNull();
  });
});

describe("parseStockInput", () => {
  it("acepta un entero no negativo", () => {
    expect(parseStockInput("0")).toEqual({ ok: true, value: 0 });
    expect(parseStockInput("14")).toEqual({ ok: true, value: 14 });
    expect(parseStockInput(" 7 ")).toEqual({ ok: true, value: 7 });
  });

  it("rechaza vacío, negativos, decimales y texto", () => {
    expect(parseStockInput("").ok).toBe(false);
    expect(parseStockInput("-1").ok).toBe(false);
    expect(parseStockInput("2.5").ok).toBe(false);
    expect(parseStockInput("muchos").ok).toBe(false);
  });
});

describe("parsePriceInput", () => {
  it("acepta precios con hasta dos decimales", () => {
    expect(parsePriceInput("25")).toEqual({ ok: true, value: 25 });
    expect(parsePriceInput("25.50")).toEqual({ ok: true, value: 25.5 });
    expect(parsePriceInput("0")).toEqual({ ok: true, value: 0 });
  });

  it("acepta la coma decimal, que es como se escribe acá", () => {
    expect(parsePriceInput("25,50")).toEqual({ ok: true, value: 25.5 });
  });

  it("rechaza negativos, texto y más de dos decimales", () => {
    expect(parsePriceInput("-5").ok).toBe(false);
    expect(parsePriceInput("caro").ok).toBe(false);
    expect(parsePriceInput("25.555").ok).toBe(false);
    expect(parsePriceInput("").ok).toBe(false);
  });
});

describe("summarizeInventory", () => {
  it("cuenta activos, agotados y bajos por separado", () => {
    const resumen = summarizeInventory([
      product({ id: "a", stockQuantity: 10 }),
      product({ id: "b", stockQuantity: 0 }),
      product({ id: "c", stockQuantity: 2 }),
      product({ id: "d", stockQuantity: 5, isActive: false }),
    ]);
    expect(resumen.total).toBe(4);
    expect(resumen.activos).toBe(3);
    expect(resumen.agotados).toBe(1);
    expect(resumen.bajos).toBe(1);
  });

  it("no cuenta como agotado un producto que la IA ni siquiera ve", () => {
    const resumen = summarizeInventory([product({ id: "a", stockQuantity: 0, isActive: false })]);
    expect(resumen.agotados).toBe(0);
    expect(resumen.activos).toBe(0);
  });

  it("suma el valor del inventario solo con lo que está en dólares", () => {
    const resumen = summarizeInventory([
      product({ id: "a", price: 10, currency: "USD", stockQuantity: 3 }),
      product({ id: "b", price: 400, currency: "VES", stockQuantity: 2 }),
    ]);
    expect(resumen.valorUsd).toBe(30);
    expect(resumen.hasNonUsdPrices).toBe(true);
  });
});

describe("parseInventoryParams", () => {
  it("aplica los valores por defecto", () => {
    expect(parseInventoryParams({})).toEqual({ query: "", filter: "todos", sort: "nombre", page: 1 });
  });

  it("acepta los filtros válidos y descarta los inventados", () => {
    expect(parseInventoryParams({ filtro: "agotados" }).filter).toBe("agotados");
    expect(parseInventoryParams({ filtro: "bajo-stock" }).filter).toBe("bajo-stock");
    expect(parseInventoryParams({ filtro: "inactivos" }).filter).toBe("inactivos");
    expect(parseInventoryParams({ filtro: "loquesea" }).filter).toBe("todos");
  });

  it("acepta los órdenes válidos y descarta los inventados", () => {
    expect(parseInventoryParams({ orden: "stock" }).sort).toBe("stock");
    expect(parseInventoryParams({ orden: "precio" }).sort).toBe("precio");
    expect(parseInventoryParams({ orden: "color" }).sort).toBe("nombre");
  });

  it("ignora páginas absurdas", () => {
    expect(parseInventoryParams({ page: "0" }).page).toBe(1);
    expect(parseInventoryParams({ page: "x" }).page).toBe(1);
    expect(parseInventoryParams({ page: "4" }).page).toBe(4);
  });
});

describe("inventoryHref", () => {
  it("omite los valores por defecto", () => {
    expect(inventoryHref({ query: "", filter: "todos", sort: "nombre", page: 1 })).toBe("/inventario");
  });

  it("conserva lo que no es por defecto", () => {
    expect(inventoryHref({ query: "bujía", filter: "agotados", sort: "stock", page: 2 })).toBe(
      "/inventario?q=buj%C3%ADa&filtro=agotados&orden=stock&page=2"
    );
  });
});

describe("paginación del inventario", () => {
  it("traduce la página a un rango", () => {
    expect(inventoryPageRange(1)).toEqual({ from: 0, to: INVENTORY_PAGE_SIZE - 1 });
    expect(inventoryPageRange(2)).toEqual({ from: INVENTORY_PAGE_SIZE, to: INVENTORY_PAGE_SIZE * 2 - 1 });
  });

  it("cuenta al menos una página", () => {
    expect(inventoryTotalPages(0)).toBe(1);
    expect(inventoryTotalPages(INVENTORY_PAGE_SIZE + 1)).toBe(2);
  });
});
