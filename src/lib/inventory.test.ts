import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Product } from "@/lib/types";
import {
  INVENTORY_FILTER_LABELS,
  INVENTORY_PAGE_SIZE,
  INVENTORY_VIEW_COOKIE,
  LOW_STOCK_THRESHOLD,
  NEW_FROM_SAINT_DAYS,
  aiVisibility,
  casheaReadiness,
  formatWeightInput,
  inventoryFilterHref,
  inventoryHref,
  inventoryPageRange,
  inventoryTotalPages,
  isNewFromSaint,
  ordenPorDefecto,
  paginaFueraDeRango,
  parseInventoryParams,
  parseInventoryView,
  parseWeightInput,
  precioDivisaDisplay,
  priceDisplay,
  priceInBs,
  sinPeso,
  standardPriceAmounts,
  standardPriceDisplay,
  stockLevel,
  summarizeInventory,
} from "@/lib/inventory";
import { mapProduct, PRODUCT_SELECT, SIN_PESO_FILTRO, type RawProduct } from "@/lib/inventory-data";

/*
 * 12/10/2026: un peso guardado en 0 es tan "sin cargar" como null — no hay
 * tarifa MRW para 0 kg, así que tampoco precio estándar. Badge, filtro y
 * contador "Sin peso" tienen que contar los dos casos, no solo null.
 */
describe("sinPeso", () => {
  it("null y 0 son sin peso; cualquier positivo no", () => {
    expect(sinPeso(null)).toBe(true);
    expect(sinPeso(0)).toBe(true);
    expect(sinPeso(0.001)).toBe(false);
    expect(sinPeso(4.5)).toBe(false);
  });

  it("el filtro de PostgREST del filtro y del contador cubre null y 0", () => {
    expect(SIN_PESO_FILTRO).toBe("weight_kg.is.null,weight_kg.eq.0");
  });
});

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
    shippingFeeUsd: null,
    precioDivisaUsd: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    fotos: [],
    ...over,
  };
}

describe("stockLevel", () => {
  it("marca agotado en cero o menos", () => {
    expect(stockLevel(product({ stockQuantity: 0 }))).toBe("agotado");
    expect(stockLevel(product({ stockQuantity: -2 }))).toBe("agotado");
  });

  // 30/10/2026 (plan «Cada repuesto con su foto»): el umbral sube de 3 a 5 por
  // pedido del operador — más de 5 verde, 1 a 5 naranja, 0 rojo. Los límites van
  // con LITERALES, no con el símbolo: probar el tope contra su propia constante
  // no detecta que alguien cambie el número (trampa del 20/9/2026).
  it("marca bajo de 1 a 5 inclusive", () => {
    expect(stockLevel(product({ stockQuantity: 1 }))).toBe("bajo");
    expect(stockLevel(product({ stockQuantity: 3 }))).toBe("bajo");
    expect(stockLevel(product({ stockQuantity: 5 }))).toBe("bajo");
  });

  it("marca disponible con 6 o más", () => {
    expect(stockLevel(product({ stockQuantity: 6 }))).toBe("disponible");
  });

  it("el umbral exportado vale 5", () => {
    expect(LOW_STOCK_THRESHOLD).toBe(5);
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

  // 27/9/2026 ("El mostrador busca sin salir del chat", D1): el pie en
  // dólares de un producto en VES redondea hacia arriba al siguiente
  // múltiplo de $0,10 (usdFromBs), no al centavo más cercano. 87 / 40 = 2,175
  // sin redondear.
  it("VES con tasa: el pie en dólares redondea hacia arriba al siguiente múltiplo de $0,10", () => {
    expect(priceDisplay(product({ price: 87, currency: "VES" }), 40)).toEqual({
      principal: "Bs. 87.00",
      pie: "$ 2.20",
    });
  });
});

// 12/10/2026 (plan "Precio promoción y precio estándar (envío MRW)"): el
// precio estándar es el precio promoción más la tarifa MRW que calcula la base.
describe("standardPriceDisplay", () => {
  it("VES con tasa: usa usdFromBs (redondeo hacia arriba) y suma la tarifa en ambas monedas", () => {
    // 87 / 40 = 2,175 -> usdFromBs 2,20 (una división directa daría 2,18).
    // Bs: 87 + round2(1,40 * 40) = 143,00. $: 2,20 + 1,40 = 3,60.
    expect(
      standardPriceDisplay(product({ price: 87, currency: "VES", weightKg: 1, shippingFeeUsd: 1.4 }), 40)
    ).toEqual({ estado: "ok", principal: "Bs. 143.00", pie: "$ 3.60", tarifa: "$ 1.40" });
  });

  it("VES con tasa: evita el ruido de coma flotante al sumar", () => {
    // 2,20 + 1,35 en coma flotante da 3,5500000000000003.
    const r = standardPriceDisplay(product({ price: 87, currency: "VES", weightKg: 1, shippingFeeUsd: 1.35 }), 40);
    expect(r).toEqual({ estado: "ok", principal: "Bs. 141.00", pie: "$ 3.55", tarifa: "$ 1.35" });
  });

  it("ejemplo de la especificación: $1,00 + $1,40 de envío = $2,40 en USD y en VES", () => {
    expect(
      standardPriceDisplay(product({ price: 1, currency: "USD", weightKg: 1, shippingFeeUsd: 1.4 }), 100)
    ).toEqual({ estado: "ok", principal: "Bs. 240.00", pie: "$ 2.40", tarifa: "$ 1.40" });
    expect(
      standardPriceDisplay(product({ price: 100, currency: "VES", weightKg: 1, shippingFeeUsd: 1.4 }), 100)
    ).toEqual({ estado: "ok", principal: "Bs. 240.00", pie: "$ 2.40", tarifa: "$ 1.40" });
  });

  it("USD con tasa: el dólar es precio + tarifa y los bolívares salen de esa suma", () => {
    expect(
      standardPriceDisplay(product({ price: 25, currency: "USD", weightKg: 2, shippingFeeUsd: 2.5 }), 40)
    ).toEqual({ estado: "ok", principal: "Bs. 1100.00", pie: "$ 27.50", tarifa: "$ 2.50" });
  });

  it("sin tasa: no mezcla monedas distintas", () => {
    expect(
      standardPriceDisplay(product({ price: 1000, currency: "VES", weightKg: 1, shippingFeeUsd: 1.4 }), 0)
    ).toEqual({ estado: "ok", principal: "Bs. 1000.00", pie: "+ $ 1.40 envío", tarifa: "$ 1.40" });
    expect(
      standardPriceDisplay(product({ price: 25, currency: "USD", weightKg: 1, shippingFeeUsd: 1.4 }), -1)
    ).toEqual({ estado: "ok", principal: "$ 26.40", pie: null, tarifa: "$ 1.40" });
  });

  it("sin peso (null o 0): nunca un número", () => {
    expect(standardPriceDisplay(product({ weightKg: null, shippingFeeUsd: null }), 40)).toEqual({
      estado: "sin_peso",
    });
    expect(standardPriceDisplay(product({ weightKg: 0, shippingFeeUsd: null }), 40)).toEqual({
      estado: "sin_peso",
    });
  });

  it("80 kg o más: fuera de la tabla de tarifas", () => {
    expect(standardPriceDisplay(product({ weightKg: 80, shippingFeeUsd: null }), 40)).toEqual({
      estado: "fuera_de_tabla",
    });
    expect(standardPriceDisplay(product({ weightKg: 95, shippingFeeUsd: null }), 40)).toEqual({
      estado: "fuera_de_tabla",
    });
  });

  it("peso válido pero sin rango en la base: sin_tarifa", () => {
    expect(standardPriceDisplay(product({ weightKg: 5, shippingFeeUsd: null }), 40)).toEqual({
      estado: "sin_tarifa",
    });
  });
});

// 14/10/2026: el carrito del chat cobra a precio estándar, así que los números
// salen de una función que `standardPriceDisplay` también usa (una sola
// aritmética para la pantalla y para la factura).
describe("standardPriceAmounts", () => {
  it("sin tarifa MRW no hay montos: null, nunca un número incompleto", () => {
    expect(standardPriceAmounts(product({ weightKg: 5, shippingFeeUsd: null }), 40)).toBeNull();
    expect(standardPriceAmounts(product({ weightKg: null, shippingFeeUsd: null }), 0)).toBeNull();
  });

  it("VES con tasa: dólar con usdFromBs + tarifa, bolívares con la tarifa convertida", () => {
    // 87 / 40 = 2,175 -> usdFromBs 2,20; + 1,40 = 3,60. Bs: 87 + round2(1,40 * 40) = 143.
    expect(standardPriceAmounts(product({ price: 87, currency: "VES", shippingFeeUsd: 1.4 }), 40)).toEqual({
      usd: 3.6,
      bs: 143,
    });
  });

  it("VES con tasa: sin ruido de coma flotante (2,20 + 1,35 = 3,55)", () => {
    expect(standardPriceAmounts(product({ price: 87, currency: "VES", shippingFeeUsd: 1.35 }), 40)?.usd).toBe(3.55);
  });

  it("USD con tasa: precio + tarifa, y los bolívares salen de esa suma", () => {
    expect(standardPriceAmounts(product({ price: 25, currency: "USD", shippingFeeUsd: 2.5 }), 40)).toEqual({
      usd: 27.5,
      bs: 1100,
    });
  });

  it("USD sin tasa: el dólar sí se puede sumar, los bolívares no", () => {
    expect(standardPriceAmounts(product({ price: 25, currency: "USD", shippingFeeUsd: 1.4 }), 0)).toEqual({
      usd: 26.4,
      bs: null,
    });
  });

  it("VES sin tasa: no se mezclan monedas, ni dólar ni bolívares", () => {
    expect(standardPriceAmounts(product({ price: 1000, currency: "VES", shippingFeeUsd: 1.4 }), 0)).toEqual({
      usd: null,
      bs: null,
    });
  });
});

/**
 * Doble mínimo de Supabase para `mapProduct`: solo `storage.from(bucket).getPublicUrl`,
 * que es lo único que toca (arma el texto de la URL, no hace red).
 */
const fakeStorageSupabase = {
  storage: {
    from: (bucket: string) => ({
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://sb.test/storage/v1/object/public/${bucket}/${path}` } }),
    }),
  },
} as unknown as SupabaseClient;

describe("mapProduct / PRODUCT_SELECT (tarifa MRW)", () => {
  const raw = (over: Partial<RawProduct> = {}): RawProduct => ({
    id: "p1",
    name: "Carburador",
    brand: null,
    price: 25,
    currency: "USD",
    stock_quantity: 3,
    description: null,
    is_active: true,
    updated_at: "2026-10-12T10:00:00Z",
    weight_kg: 1,
    tarifa_envio_usd: null,
    precio_divisa_usd: null,
    saint_code: null,
    saint_added_at: null,
    saint_removed_at: null,
    product_compatibility: null,
    product_photos: null,
    ...over,
  });

  it("convierte la tarifa que PostgREST entrega como texto", () => {
    expect(mapProduct(raw({ tarifa_envio_usd: "1.40" }), fakeStorageSupabase).shippingFeeUsd).toBe(1.4);
    expect(mapProduct(raw({ tarifa_envio_usd: 2.5 }), fakeStorageSupabase).shippingFeeUsd).toBe(2.5);
  });

  it("null se queda null", () => {
    expect(mapProduct(raw({ tarifa_envio_usd: null }), fakeStorageSupabase).shippingFeeUsd).toBeNull();
  });

  it("el select pide tarifa_envio_usd", () => {
    expect(PRODUCT_SELECT).toContain("tarifa_envio_usd");
  });

  // 30/10/2026 (plan "Precio divisa desde SAINT"): campo calculado de PostgREST,
  // `numeric` que puede llegar como texto.
  it("convierte el precio divisa que PostgREST entrega como texto o número", () => {
    expect(mapProduct(raw({ precio_divisa_usd: "12.35" }), fakeStorageSupabase).precioDivisaUsd).toBe(12.35);
    expect(mapProduct(raw({ precio_divisa_usd: 7 }), fakeStorageSupabase).precioDivisaUsd).toBe(7);
  });

  it("precio divisa null se queda null (nunca 0)", () => {
    expect(mapProduct(raw({ precio_divisa_usd: null }), fakeStorageSupabase).precioDivisaUsd).toBeNull();
  });

  it("el select pide precio_divisa_usd", () => {
    expect(PRODUCT_SELECT).toContain("precio_divisa_usd");
  });

  // 30/10/2026 (plan «Cada repuesto con su foto», T2).
  it("el select trae las fotos con product_photos(id, storage_path, is_primary, position)", () => {
    expect(PRODUCT_SELECT).toContain("product_photos(id, storage_path, is_primary, position)");
  });

  it("sin fotos (null o vacío) el repuesto trae fotos: []", () => {
    expect(mapProduct(raw({ product_photos: null }), fakeStorageSupabase).fotos).toEqual([]);
    expect(mapProduct(raw({ product_photos: [] }), fakeStorageSupabase).fotos).toEqual([]);
  });

  it("ordena las fotos (principal primero, luego position) y arma la URL pública de cada una", () => {
    const fotos = mapProduct(
      raw({
        product_photos: [
          { id: "b", storage_path: "p1/b.jpg", is_primary: false, position: 2 },
          { id: "a", storage_path: "p1/a.jpg", is_primary: true, position: 3 },
          { id: "c", storage_path: "p1/c.jpg", is_primary: false, position: 1 },
        ],
      }),
      fakeStorageSupabase
    ).fotos;

    expect(fotos.map((f) => f.id)).toEqual(["a", "c", "b"]);
    expect(fotos[0]).toEqual({
      id: "a",
      storagePath: "p1/a.jpg",
      url: "https://sb.test/storage/v1/object/public/product-photos/p1/a.jpg",
      isPrimary: true,
      position: 3,
    });
  });
});

// 30/10/2026 (plan "Precio divisa desde SAINT"): el precio divisa es
// `SAPROD.Precio1` de SAINT, ya en USD. Solo informativo: no se convierte con la tasa.
describe("precioDivisaDisplay", () => {
  it("un precio real se pinta con el mismo formato '$ 12.35' que el pie de priceDisplay", () => {
    expect(precioDivisaDisplay({ precioDivisaUsd: 12.35 })).toEqual({ estado: "ok", principal: "$ 12.35" });
    expect(precioDivisaDisplay({ precioDivisaUsd: 1234.5 })).toEqual({ estado: "ok", principal: "$ 1234.50" });
  });

  it("0, negativo, null o NaN no son un precio: 'sin_precio', nunca '$ 0.00'", () => {
    expect(precioDivisaDisplay({ precioDivisaUsd: 0 })).toEqual({ estado: "sin_precio" });
    expect(precioDivisaDisplay({ precioDivisaUsd: -3 })).toEqual({ estado: "sin_precio" });
    expect(precioDivisaDisplay({ precioDivisaUsd: null })).toEqual({ estado: "sin_precio" });
    expect(precioDivisaDisplay({ precioDivisaUsd: Number.NaN })).toEqual({ estado: "sin_precio" });
    expect(precioDivisaDisplay({ precioDivisaUsd: Number.POSITIVE_INFINITY })).toEqual({ estado: "sin_precio" });
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

// 30/10/2026 (plan «Cada repuesto con su foto», T2): lo que Cashea exige para
// el envío gratis, en el orden en que se le dice al asesor qué le falta.
describe("casheaReadiness", () => {
  const foto = { id: "f1", storagePath: "p1/f1.jpg", url: "https://x/f1.jpg", isPrimary: true, position: 0 };
  const listo = (over: Partial<Product> = {}) =>
    product({ fotos: [foto], weightKg: 1.5, precioDivisaUsd: 12, isActive: true, ...over });

  it("con foto, peso, precio divisa y activo está listo", () => {
    expect(casheaReadiness(listo())).toEqual({ listo: true, faltan: [] });
  });

  it("sin foto falta «Foto principal»", () => {
    expect(casheaReadiness(listo({ fotos: [] }))).toEqual({ listo: false, faltan: ["Foto principal"] });
  });

  it("peso null o 0 falta «Peso cargado»; uno positivo no", () => {
    expect(casheaReadiness(listo({ weightKg: null })).faltan).toEqual(["Peso cargado"]);
    expect(casheaReadiness(listo({ weightKg: 0 })).faltan).toEqual(["Peso cargado"]);
    expect(casheaReadiness(listo({ weightKg: 0.001 })).faltan).toEqual([]);
  });

  it("precio divisa null o 0 falta «Precio divisa en SAINT»", () => {
    expect(casheaReadiness(listo({ precioDivisaUsd: null })).faltan).toEqual(["Precio divisa en SAINT"]);
    expect(casheaReadiness(listo({ precioDivisaUsd: 0 })).faltan).toEqual(["Precio divisa en SAINT"]);
  });

  it("inactivo falta «Activo en Saint»", () => {
    expect(casheaReadiness(listo({ isActive: false }))).toEqual({ listo: false, faltan: ["Activo en Saint"] });
  });

  it("varios faltantes salen en el orden foto, peso, precio divisa, activo", () => {
    const r = casheaReadiness(product({ fotos: [], weightKg: null, precioDivisaUsd: null, isActive: false }));
    expect(r).toEqual({
      listo: false,
      faltan: ["Foto principal", "Peso cargado", "Precio divisa en SAINT", "Activo en Saint"],
    });
  });
});

describe("parseInventoryView", () => {
  it("solo «cuadricula» devuelve cuadrícula", () => {
    expect(parseInventoryView("cuadricula")).toBe("cuadricula");
  });

  it("«lista», vacío, undefined, null y basura devuelven lista (D4: la vista inicial es Lista)", () => {
    expect(parseInventoryView("lista")).toBe("lista");
    expect(parseInventoryView("")).toBe("lista");
    expect(parseInventoryView(undefined)).toBe("lista");
    expect(parseInventoryView(null)).toBe("lista");
    expect(parseInventoryView("basura")).toBe("lista");
  });

  it("la cookie se llama sbk-inventario-vista", () => {
    expect(INVENTORY_VIEW_COOKIE).toBe("sbk-inventario-vista");
  });
});

describe("filtro «Sin foto»", () => {
  it("parseInventoryParams lo acepta y su etiqueta es «Sin foto»", () => {
    expect(parseInventoryParams({ filtro: "sin-foto" }).filter).toBe("sin-foto");
    expect(INVENTORY_FILTER_LABELS["sin-foto"]).toBe("Sin foto");
  });

  it("no cambia el orden por defecto: nombre", () => {
    expect(parseInventoryParams({ filtro: "sin-foto" }).sort).toBe("nombre");
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

/**
 * T4 del plan "Inventario y caja" (13/10/2026): bajo el filtro «Sin peso» la
 * lista abre ordenada por existencia (de mayor a menor), porque lo que hay en
 * el mostrador es lo que el asesor puede pesar hoy. Es el orden POR DEFECTO de
 * ese filtro, no una píldora más: un orden explícito en la URL —incluido
 * «Por nombre», que bajo los demás filtros se omite por ser el default— se
 * respeta siempre.
 */
describe("orden por defecto de «Sin peso»", () => {
  it("ordenPorDefecto: existencia solo bajo sin-peso, nombre en los demás", () => {
    expect(ordenPorDefecto("sin-peso")).toBe("existencia");
    expect(ordenPorDefecto("todos")).toBe("nombre");
    expect(ordenPorDefecto("agotados")).toBe("nombre");
    expect(ordenPorDefecto("bajo-stock")).toBe("nombre");
    expect(ordenPorDefecto("inactivos")).toBe("nombre");
  });

  it("parse: sin orden en la URL, «Sin peso» abre por existencia", () => {
    expect(parseInventoryParams({ filtro: "sin-peso" }).sort).toBe("existencia");
  });

  it("parse: un orden explícito gana, incluido «nombre»", () => {
    expect(parseInventoryParams({ filtro: "sin-peso", orden: "nombre" }).sort).toBe("nombre");
    expect(parseInventoryParams({ filtro: "sin-peso", orden: "stock" }).sort).toBe("stock");
    expect(parseInventoryParams({ filtro: "sin-peso", orden: "precio" }).sort).toBe("precio");
  });

  it("parse: un orden inventado cae al default del filtro", () => {
    expect(parseInventoryParams({ filtro: "sin-peso", orden: "color" }).sort).toBe("existencia");
    expect(parseInventoryParams({ orden: "color" }).sort).toBe("nombre");
  });

  it("parse: «existencia» es un orden válido también en la URL", () => {
    expect(parseInventoryParams({ orden: "existencia" }).sort).toBe("existencia");
  });

  it("inventoryHref omite el orden cuando es el default del filtro", () => {
    expect(inventoryHref({ query: "", filter: "sin-peso", sort: "existencia", page: 1 })).toBe(
      "/inventario?filtro=sin-peso"
    );
  });

  it("inventoryHref escribe orden=nombre bajo sin-peso: si no, el clic en «Por nombre» no haría nada", () => {
    expect(inventoryHref({ query: "", filter: "sin-peso", sort: "nombre", page: 1 })).toBe(
      "/inventario?filtro=sin-peso&orden=nombre"
    );
  });

  it("la URL de sin-peso con orden=nombre vuelve a leerse como nombre (ida y vuelta)", () => {
    const params = { query: "", filter: "sin-peso" as const, sort: "nombre" as const, page: 2 };
    const url = new URL(inventoryHref(params), "http://x");
    expect(parseInventoryParams(Object.fromEntries(url.searchParams))).toEqual(params);
  });
});

describe("inventoryFilterHref — cambiar de filtro no arrastra un orden que no era del usuario", () => {
  const base = { query: "", filter: "todos" as const, sort: "nombre" as const, page: 4 };

  it("de «Todos» a «Sin peso» deja el default de sin-peso (nada de orden=nombre) y reinicia la página", () => {
    expect(inventoryFilterHref(base, "sin-peso")).toBe("/inventario?filtro=sin-peso");
  });

  it("de «Sin peso» (existencia implícita) a «Todos» vuelve a nombre, sin orden en la URL", () => {
    expect(inventoryFilterHref({ ...base, filter: "sin-peso", sort: "existencia" }, "todos")).toBe("/inventario");
  });

  it("un orden elegido a mano sobrevive al cambio de filtro", () => {
    expect(inventoryFilterHref({ ...base, sort: "precio" }, "sin-peso")).toBe("/inventario?filtro=sin-peso&orden=precio");
    expect(inventoryFilterHref({ ...base, filter: "sin-peso", sort: "nombre" }, "agotados")).toBe(
      "/inventario?filtro=agotados"
    );
  });

  it("conserva la búsqueda", () => {
    expect(inventoryFilterHref({ ...base, query: "bujía" }, "sin-peso")).toBe(
      "/inventario?q=buj%C3%ADa&filtro=sin-peso"
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

/*
 * 13/10/2026: una `?page=` fuera de rango (un enlace viejo, o un filtro que
 * acorta la lista) llegaba a PostgREST como 416 y reventaba la pantalla.
 * La página decide a dónde redirigir con esta función pura.
 */
describe("paginaFueraDeRango", () => {
  it("dentro de rango no redirige", () => {
    expect(paginaFueraDeRango(1, 400)).toBeNull();
    expect(paginaFueraDeRango(10, 400)).toBeNull();
    expect(paginaFueraDeRango(1, 40)).toBeNull();
  });

  it("la última página exacta no redirige (el borde)", () => {
    expect(paginaFueraDeRango(10, 400)).toBeNull();
    expect(paginaFueraDeRango(11, 401)).toBeNull();
  });

  it("pasarse del total manda a la última página", () => {
    expect(paginaFueraDeRango(11, 400)).toBe(10);
    expect(paginaFueraDeRango(999, 401)).toBe(11);
  });

  it("sin resultados, cualquier página mayor a 1 manda a la 1", () => {
    expect(paginaFueraDeRango(2, 0)).toBe(1);
    expect(paginaFueraDeRango(50, 0)).toBe(1);
    expect(paginaFueraDeRango(1, 0)).toBeNull();
  });
});
