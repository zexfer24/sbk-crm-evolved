import { describe, expect, it } from "vitest";
import type { Product } from "@/lib/types";
import {
  INVENTORY_PAGE_SIZE,
  LOW_STOCK_THRESHOLD,
  NEW_FROM_SAINT_DAYS,
  aiVisibility,
  formatWeightInput,
  inventoryHref,
  inventoryPageRange,
  inventoryTotalPages,
  isNewFromSaint,
  parseInventoryParams,
  parseWeightInput,
  priceDisplay,
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
    weightKg: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
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
  // desactivado deja de existir para la IA, aunque tenga stock. Desde
  // que Saint es el único dueño del inventario (25/9/2026), inactivo ya no
  // es "un asesor lo apagó": es que Saint lo dio de baja.
  it("un producto inactivo no lo ve la IA, y el aviso dice que la baja es de Saint", () => {
    const visibility = aiVisibility(product({ isActive: false }));
    expect(visibility.visible).toBe(false);
    expect(visibility.warning).toBe("Ya no está en Saint: la IA no lo ofrece ni lo cotiza.");
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

/**
 * Badge "Nuevo desde Saint" (T2, plan "El inventario llega de Saint y no se
 * toca a mano", 25/9/2026, decisión del operador del 24/9): se muestra 7
 * días desde `saint_added_at` — lo que tarda el asesor en cargarle el peso a
 * un producto recién llegado.
 */
describe("isNewFromSaint", () => {
  const AHORA = new Date("2026-09-25T12:00:00Z");

  function haceDias(dias: number): string {
    return new Date(AHORA.getTime() - dias * 24 * 60 * 60 * 1000).toISOString();
  }

  it("el tope son 7 días", () => {
    expect(NEW_FROM_SAINT_DAYS).toBe(7);
  });

  it("sin saintAddedAt nunca es nuevo", () => {
    expect(isNewFromSaint({ saintAddedAt: null }, AHORA)).toBe(false);
  });

  it("llegó hace 1 día: es nuevo", () => {
    expect(isNewFromSaint({ saintAddedAt: haceDias(1) }, AHORA)).toBe(true);
  });

  it("llegó hace 6 días y 23 horas: todavía es nuevo", () => {
    const fecha = new Date(AHORA.getTime() - (6 * 24 + 23) * 60 * 60 * 1000).toISOString();
    expect(isNewFromSaint({ saintAddedAt: fecha }, AHORA)).toBe(true);
  });

  it("llegó hace exactamente 7 días: ya no es nuevo", () => {
    expect(isNewFromSaint({ saintAddedAt: haceDias(7) }, AHORA)).toBe(false);
  });

  it("llegó hace 30 días: ya no es nuevo", () => {
    expect(isNewFromSaint({ saintAddedAt: haceDias(30) }, AHORA)).toBe(false);
  });
});

// El precio se lee en bolívares y no se edita desde el CRM (19/9/2026):
// `priceDisplay` reemplaza a `parsePriceInput`/`commitPrice`, que se
// borraron con esta corrida.
describe("priceDisplay", () => {
  it("USD con tasa: bolívares arriba, dólares en el pie", () => {
    expect(priceDisplay(product({ price: 25, currency: "USD" }), 40)).toEqual({
      principal: "Bs. 1000.00",
      pie: "$ 25.00",
    });
  });

  it("VES con tasa: bolívares arriba, dólares equivalentes en el pie", () => {
    expect(priceDisplay(product({ price: 1000, currency: "VES" }), 40)).toEqual({
      principal: "Bs. 1000.00",
      pie: "$ 25.00",
    });
  });

  it("sin tasa: la moneda propia del producto arriba, sin pie inventado", () => {
    expect(priceDisplay(product({ price: 25, currency: "USD" }), 0)).toEqual({
      principal: "$ 25.00",
      pie: null,
    });
    expect(priceDisplay(product({ price: 1000, currency: "VES" }), 0)).toEqual({
      principal: "Bs. 1000.00",
      pie: null,
    });
  });

  it("tasa negativa se trata igual que sin tasa", () => {
    expect(priceDisplay(product({ price: 25, currency: "USD" }), -1)).toEqual({
      principal: "$ 25.00",
      pie: null,
    });
  });
});

describe("parseWeightInput", () => {
  it("acepta un peso con hasta tres decimales, coma o punto", () => {
    expect(parseWeightInput("0,250")).toEqual({ ok: true, value: 0.25 });
    expect(parseWeightInput("1.500")).toEqual({ ok: true, value: 1.5 });
    expect(parseWeightInput("2")).toEqual({ ok: true, value: 2 });
  });

  it("vacío es un peso válido: significa que todavía no se cargó", () => {
    expect(parseWeightInput("")).toEqual({ ok: true, value: null });
    expect(parseWeightInput("   ")).toEqual({ ok: true, value: null });
  });

  it("rechaza negativos, texto y más de tres decimales", () => {
    expect(parseWeightInput("-1").ok).toBe(false);
    expect(parseWeightInput("pesado").ok).toBe(false);
    expect(parseWeightInput("1.2345").ok).toBe(false);
  });

  it("rechaza por encima del tope", () => {
    expect(parseWeightInput("10000").ok).toBe(false);
    expect(parseWeightInput("9999.999")).toEqual({ ok: true, value: 9999.999 });
  });
});

describe("formatWeightInput", () => {
  it("vacío para null, tres decimales fijos para un número", () => {
    expect(formatWeightInput(null)).toBe("");
    expect(formatWeightInput(0.25)).toBe("0.250");
    expect(formatWeightInput(2)).toBe("2.000");
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

  it("cuenta sin peso solo sobre los activos", () => {
    const resumen = summarizeInventory([
      product({ id: "a", weightKg: null }),
      product({ id: "b", weightKg: 0.5 }),
      product({ id: "c", weightKg: null, isActive: false }),
    ]);
    expect(resumen.withoutWeight).toBe(1);
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
    expect(parseInventoryParams({ filtro: "sin-peso" }).filter).toBe("sin-peso");
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
