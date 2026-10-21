import { describe, expect, it } from "vitest";
import type { CartPriceKind, Product } from "@/lib/types";
import { priceInBs } from "@/lib/inventory";
import { calcularCashea, type EleccionCashea } from "@/lib/cashea";
import { OPCIONES_COPIA_INICIALES } from "@/lib/copia-carrito";
import {
  avisosRenglon,
  leerCarritoGuardado,
  precioDelCarrito,
  reducirCarrito,
  serializarCarrito,
  textoCarritoParaCliente,
  totalesCarrito,
  type LineaCarritoInventario,
  type OpcionesCashea,
} from "@/lib/inventario-carrito";
import { priceCartLines } from "@/lib/conversation-cart";

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
    updatedAt: "2026-10-12T10:00:00.000Z",
    compatibility: [],
    weightKg: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    shippingFeeUsd: null,
    ...over,
  };
}

function linea(p: Product, quantity = 1, priceKind: CartPriceKind = "promocion"): LineaCarritoInventario {
  return { product: p, quantity, quotedPriceUsd: null, priceKind };
}

const SIN_CASHEA: OpcionesCashea = { activo: false, nivel: 6, cuotas: 3, bajada: false };

function conCashea(over: Partial<EleccionCashea> = {}): OpcionesCashea {
  return { activo: true, nivel: 4, cuotas: 6, bajada: false, ...over };
}

// El carrito de referencia: $118 + 2 x $50 = $218, tasa 100 -> Bs. 21.800.
const CASCO = product({ id: "casco", name: "Casco LS2", currency: "VES", price: 11800, saintCode: "C-001" });
const GUANTE = product({ id: "guante", name: "Guante", currency: "VES", price: 5000, saintCode: "G-002" });
const CARRITO_218 = [linea(CASCO, 1), linea(GUANTE, 2)];

describe("reducirCarrito", () => {
  it("agregar un producto nuevo lo pone al final con cantidad 1", () => {
    const a = product({ id: "a" });
    const b = product({ id: "b" });
    const estado = reducirCarrito([linea(a, 3)], { tipo: "agregar", product: b });
    expect(estado.map((l) => [l.product.id, l.quantity])).toEqual([["a", 3], ["b", 1]]);
    expect(estado[1].quotedPriceUsd).toBeNull();
  });

  it("agregar sin priceKind entra a precio de promoción; con priceKind entra a ese precio", () => {
    const a = product({ id: "a" });
    expect(reducirCarrito([], { tipo: "agregar", product: a })[0].priceKind).toBe("promocion");
    expect(reducirCarrito([], { tipo: "agregar", product: a, priceKind: "estandar" })[0].priceKind).toBe("estandar");
  });

  it("agregar uno repetido con otro priceKind suma 1 y le pone ese precio", () => {
    const a = product({ id: "a" });
    const estado = reducirCarrito([linea(a, 2, "promocion")], { tipo: "agregar", product: a, priceKind: "estandar" });
    expect(estado).toHaveLength(1);
    expect(estado[0].quantity).toBe(3);
    expect(estado[0].priceKind).toBe("estandar");
  });

  it("agregar uno repetido sin priceKind lo deja en promoción (el valor por defecto manda)", () => {
    const a = product({ id: "a" });
    const estado = reducirCarrito([linea(a, 1, "estandar")], { tipo: "agregar", product: a });
    expect(estado[0].priceKind).toBe("promocion");
  });

  it("precio pone el mismo priceKind en TODOS los renglones y conserva lo demás", () => {
    const estado = [linea(product({ id: "a" }), 2, "promocion"), linea(product({ id: "b" }), 1, "estandar")];
    const nuevo = reducirCarrito(estado, { tipo: "precio", priceKind: "estandar" });
    expect(nuevo.map((l) => [l.product.id, l.quantity, l.priceKind])).toEqual([
      ["a", 2, "estandar"],
      ["b", 1, "estandar"],
    ]);
    expect(reducirCarrito(nuevo, { tipo: "precio", priceKind: "promocion" }).every((l) => l.priceKind === "promocion")).toBe(true);
  });

  it("restaurar conserva el priceKind de las líneas restauradas", () => {
    const nuevo = reducirCarrito([], { tipo: "restaurar", lineas: [linea(product({ id: "a" }), 2, "estandar")] });
    expect(nuevo[0].priceKind).toBe("estandar");
  });

  it("agregar uno repetido suma 1 y refresca el producto con el recibido", () => {
    const viejo = product({ id: "a", price: 20 });
    const nuevo = product({ id: "a", price: 25 });
    const estado = reducirCarrito([linea(viejo, 2)], { tipo: "agregar", product: nuevo });
    expect(estado).toHaveLength(1);
    expect(estado[0].quantity).toBe(3);
    expect(estado[0].product.price).toBe(25);
  });

  it.each([0, -1, 1.5, Number.NaN])("cantidad %s no es válida: devuelve el mismo estado", (quantity) => {
    const estado = [linea(product({ id: "a" }), 2)];
    expect(reducirCarrito(estado, { tipo: "cantidad", productId: "a", quantity })).toBe(estado);
  });

  it("cantidad de un id inexistente devuelve el mismo estado", () => {
    const estado = [linea(product({ id: "a" }), 2)];
    expect(reducirCarrito(estado, { tipo: "cantidad", productId: "zzz", quantity: 4 })).toBe(estado);
  });

  it("cantidad entera >= 1 la cambia sin tocar las demás líneas", () => {
    const estado = [linea(product({ id: "a" }), 1), linea(product({ id: "b" }), 1)];
    const nuevo = reducirCarrito(estado, { tipo: "cantidad", productId: "a", quantity: 3 });
    expect(nuevo.map((l) => l.quantity)).toEqual([3, 1]);
  });

  it("quitar saca solo esa línea", () => {
    const estado = [linea(product({ id: "a" })), linea(product({ id: "b" }))];
    expect(reducirCarrito(estado, { tipo: "quitar", productId: "a" }).map((l) => l.product.id)).toEqual(["b"]);
  });

  it("vaciar deja el carrito sin líneas", () => {
    expect(reducirCarrito([linea(product({ id: "a" }))], { tipo: "vaciar" })).toEqual([]);
  });

  it("restaurar pone las restauradas primero y, si el producto ya estaba en el estado, gana la línea del estado", () => {
    // El asesor agregó "b" (x4) antes de que terminara la lectura de localStorage,
    // que traía "a" (x2) y "b" (x1): "b" del estado se conserva tal cual.
    const estado = [linea(product({ id: "c" }), 1), linea(product({ id: "b", price: 99 }), 4)];
    const restauradas = [linea(product({ id: "a" }), 2), linea(product({ id: "b", price: 1 }), 1)];
    const nuevo = reducirCarrito(estado, { tipo: "restaurar", lineas: restauradas });
    expect(nuevo.map((l) => [l.product.id, l.quantity])).toEqual([["a", 2], ["b", 4], ["c", 1]]);
    expect(nuevo[1].product.price).toBe(99);
  });
});

describe("leerCarritoGuardado", () => {
  it.each([
    [null],
    ["basura"],
    ["{}"],
    ["[1,2]"],
    ["\"hola\""],
    [""],
  ])("%s no es un carrito: devuelve []", (raw) => {
    expect(leerCarritoGuardado(raw)).toEqual([]);
  });

  it("descarta cantidades que no son enteros >= 1 y productId vacío o no texto", () => {
    const raw = JSON.stringify([
      { productId: "a", quantity: 0 },
      { productId: "b", quantity: -2 },
      { productId: "c", quantity: 1.5 },
      { productId: "d", quantity: "3" },
      { productId: "", quantity: 1 },
      { productId: 7, quantity: 1 },
      { quantity: 2 },
      { productId: "ok", quantity: 2 },
    ]);
    expect(leerCarritoGuardado(raw)).toEqual([{ productId: "ok", quantity: 2, priceKind: "promocion" }]);
  });

  it("fusiona ids repetidos sumando cantidades y conserva la posición de la primera aparición", () => {
    const raw = JSON.stringify([
      { productId: "a", quantity: 1 },
      { productId: "b", quantity: 2 },
      { productId: "a", quantity: 3 },
    ]);
    expect(leerCarritoGuardado(raw)).toEqual([
      { productId: "a", quantity: 4, priceKind: "promocion" },
      { productId: "b", quantity: 2, priceKind: "promocion" },
    ]);
  });

  it("un JSON viejo sin priceKind se lee como promoción", () => {
    const raw = JSON.stringify([{ productId: "a", quantity: 1 }]);
    expect(leerCarritoGuardado(raw)).toEqual([{ productId: "a", quantity: 1, priceKind: "promocion" }]);
  });

  it("un priceKind desconocido o que no es texto se lee como promoción; «estandar» se respeta", () => {
    const raw = JSON.stringify([
      { productId: "a", quantity: 1, priceKind: "estandar" },
      { productId: "b", quantity: 1, priceKind: "premium" },
      { productId: "c", quantity: 1, priceKind: 7 },
    ]);
    expect(leerCarritoGuardado(raw).map((g) => [g.productId, g.priceKind])).toEqual([
      ["a", "estandar"],
      ["b", "promocion"],
      ["c", "promocion"],
    ]);
  });

  it("ids repetidos con distinto priceKind: gana el de la primera aparición", () => {
    const raw = JSON.stringify([
      { productId: "a", quantity: 1, priceKind: "estandar" },
      { productId: "a", quantity: 2, priceKind: "promocion" },
    ]);
    expect(leerCarritoGuardado(raw)).toEqual([{ productId: "a", quantity: 3, priceKind: "estandar" }]);
  });

  it("ida y vuelta con serializarCarrito: solo guarda productId, cantidad y a qué precio se cobra", () => {
    const raw = serializarCarrito([linea(CASCO, 1, "estandar"), linea(GUANTE, 2)]);
    expect(JSON.parse(raw)).toEqual([
      { productId: "casco", quantity: 1, priceKind: "estandar" },
      { productId: "guante", quantity: 2, priceKind: "promocion" },
    ]);
    expect(leerCarritoGuardado(raw)).toEqual([
      { productId: "casco", quantity: 1, priceKind: "estandar" },
      { productId: "guante", quantity: 2, priceKind: "promocion" },
    ]);
  });
});

describe("totalesCarrito sin Cashea", () => {
  it("dos productos en bolívares con tasa 100: Bs. 21.800 y $218 sumando los dólares por renglón", () => {
    const t = totalesCarrito(CARRITO_218, 100, SIN_CASHEA);
    expect(t.bs).toBe(21800);
    expect(t.usd).toBe(218);
    expect(t.unidades).toBe(3);
    expect(t.renglones).toBe(2);
    expect(t.unpricedCount).toBe(0);
    expect(t.cashea).toBeNull();
    expect(t.inicialBs).toBeNull();
    expect(t.cuotaBs).toBeNull();
    expect(t.lineas).toHaveLength(2);
  });

  it("el total en dólares suma los renglones ya redondeados, no convierte el total en bolívares", () => {
    // Bs. 1001 / 100 = $10,01 -> $10,10 por renglón. Dos renglones: $20,20.
    // Convertir el total de una vez (2002 / 100 = 20,02) daría $20,10: se regalaría plata.
    const a = product({ id: "a", currency: "VES", price: 1001 });
    const b = product({ id: "b", currency: "VES", price: 1001 });
    const t = totalesCarrito([linea(a), linea(b)], 100, SIN_CASHEA);
    expect(t.usd).toBe(20.2);
    expect(t.usd).not.toBe(20.1);
    expect(t.bs).toBe(2002);
  });

  it("sin tasa un producto en bolívares queda sin precio en dólares, pero sus bolívares siguen sumando", () => {
    const t = totalesCarrito([linea(product({ currency: "VES", price: 5000 }))], 0, conCashea());
    expect(t.unpricedCount).toBe(1);
    expect(t.bs).toBe(5000);
    expect(t.cashea).toBeNull();
    expect(t.inicialBs).toBeNull();
    expect(t.cuotaBs).toBeNull();
  });

  it("un producto en dólares se convierte a bolívares con la tasa, vía priceInBs", () => {
    const p = product({ currency: "USD", price: 25 });
    const t = totalesCarrito([linea(p, 2)], 36.5, SIN_CASHEA);
    expect(t.usd).toBe(50);
    expect(t.bs).toBe(Number(((priceInBs(p, 36.5) as number) * 2).toFixed(2)));
    expect(t.bs).toBe(1825);
  });

  it("los renglones vienen ya con precio, iguales a priceCartLines", () => {
    const t = totalesCarrito(CARRITO_218, 100, SIN_CASHEA);
    expect(t.lineas).toEqual(priceCartLines(CARRITO_218, 100));
  });
});

describe("totalesCarrito con precio estándar (21/10/2026)", () => {
  const CON_TARIFA = product({ id: "t", name: "Caucho", price: 25, currency: "USD", weightKg: 2, shippingFeeUsd: 2.5 });

  it("cada renglón se cobra a su priceKind: el estándar suma la tarifa MRW, la promoción no", () => {
    const t = totalesCarrito([linea(CON_TARIFA, 2, "estandar"), linea(product({ id: "u", price: 10 }), 1)], 40, SIN_CASHEA);
    expect(t.usd).toBe(65);
    expect(t.unpricedCount).toBe(0);
    expect(totalesCarrito([linea(CON_TARIFA, 2, "promocion")], 40, SIN_CASHEA).usd).toBe(50);
  });

  it("un estándar sin tarifa (sin peso) cuenta como renglón sin precio y apaga Cashea", () => {
    const sinPeso = product({ id: "s", price: 25, weightKg: null, shippingFeeUsd: null });
    const t = totalesCarrito([linea(sinPeso, 1, "estandar")], 40, conCashea());
    expect(t.unpricedCount).toBe(1);
    expect(t.usd).toBe(0);
    expect(t.cashea).toBeNull();
  });
});

describe("precioDelCarrito", () => {
  it("es null con el carrito vacío", () => {
    expect(precioDelCarrito([])).toBeNull();
  });

  it("devuelve el precio común cuando todos los renglones coinciden", () => {
    expect(precioDelCarrito([linea(product({ id: "a" })), linea(product({ id: "b" }))])).toBe("promocion");
    expect(precioDelCarrito([linea(product({ id: "a" }), 1, "estandar")])).toBe("estandar");
  });

  it("devuelve «mixto» cuando hay de los dos", () => {
    expect(
      precioDelCarrito([linea(product({ id: "a" }), 1, "estandar"), linea(product({ id: "b" }), 1, "promocion")]),
    ).toBe("mixto");
  });
});

describe("totalesCarrito con Cashea", () => {
  it("N4, 6 cuotas: el plan es el de calcularCashea sobre el total en centavos, y los Bs. salen de los centavos", () => {
    const t = totalesCarrito(CARRITO_218, 100, conCashea());
    const esperado = calcularCashea({ montoCents: 21800, nivel: 4, cuotas: 6, bajada: false });
    expect(t.cashea).toEqual(esperado);
    expect(t.inicialBs).toBe(5450);
    expect(t.cuotaBs).toBe(2725);
    const plan = t.cashea!;
    expect(plan.inicialCents + plan.montosCuotasCents.reduce((a, b) => a + b, 0)).toBe(21800);
  });

  it("un total de $100 o menos no habilita 6 cuotas: el plan queda en 3 y ajustado", () => {
    const t = totalesCarrito([linea(product({ currency: "USD", price: 100 }))], 40, conCashea());
    expect(t.cashea?.cuotas).toBe(3);
    expect(t.cashea?.ajustado).toBe(true);
  });

  it("sin renglones no hay plan", () => {
    expect(totalesCarrito([], 100, conCashea()).cashea).toBeNull();
  });
});

describe("avisosRenglon", () => {
  const avisos = (p: Product, quantity: number, rate = 100) =>
    avisosRenglon(priceCartLines([linea(p, quantity)], rate)[0]);

  it("un producto sano no tiene avisos", () => {
    expect(avisos(product({ stockQuantity: 5 }), 2)).toEqual([]);
  });

  it("Saint lo dio de baja", () => {
    expect(avisos(product({ isActive: false, stockQuantity: 5 }), 1)).toEqual(["Saint lo dio de baja"]);
  });

  it("sin stock (cero o negativo)", () => {
    expect(avisos(product({ stockQuantity: 0 }), 1)).toEqual(["Sin stock"]);
    expect(avisos(product({ stockQuantity: -2 }), 1)).toEqual(["Sin stock"]);
  });

  it("solo hay N cuando hay menos que lo pedido", () => {
    expect(avisos(product({ stockQuantity: 2 }), 3)).toEqual(["Solo hay 2"]);
    expect(avisos(product({ stockQuantity: 3 }), 3)).toEqual([]);
  });

  it("sin precio por falta de tasa", () => {
    expect(avisos(product({ currency: "VES", price: 100, stockQuantity: 5 }), 1, 0)).toEqual([
      "Sin precio (falta la tasa)",
    ]);
  });

  it("estándar sin peso: el aviso dice el motivo con el mismo texto de la fila del Inventario", () => {
    const avisosEstandar = (p: Product) => avisosRenglon(priceCartLines([linea(p, 1, "estandar")], 100)[0]);
    expect(avisosEstandar(product({ weightKg: null, shippingFeeUsd: null }))).toEqual([
      "Sin precio estándar: Sin peso cargado",
    ]);
    expect(avisosEstandar(product({ weightKg: 120, shippingFeeUsd: null }))).toEqual([
      "Sin precio estándar: Más de 80 kg: fuera de la tabla MRW",
    ]);
    expect(avisosEstandar(product({ weightKg: 5, shippingFeeUsd: null }))).toEqual([
      "Sin precio estándar: Sin tarifa MRW para este peso",
    ]);
  });

  it("estándar con tarifa pero en bolívares y sin tasa sigue diciendo que falta la tasa", () => {
    const enBs = product({ currency: "VES", price: 100, weightKg: 2, shippingFeeUsd: 2.5 });
    expect(avisosRenglon(priceCartLines([linea(enBs, 1, "estandar")], 0)[0])).toEqual(["Sin precio (falta la tasa)"]);
  });

  it("estándar sano no tiene avisos, y en promoción un producto sin peso tampoco los tiene", () => {
    const sano = product({ weightKg: 2, shippingFeeUsd: 2.5 });
    expect(avisosRenglon(priceCartLines([linea(sano, 1, "estandar")], 100)[0])).toEqual([]);
    const sinPeso = product({ weightKg: null, shippingFeeUsd: null });
    expect(avisosRenglon(priceCartLines([linea(sinPeso, 1, "promocion")], 100)[0])).toEqual([]);
  });

  it("combinados salen en orden: baja, sin stock, solo hay N, sin precio", () => {
    expect(avisos(product({ isActive: false, stockQuantity: 0, currency: "VES", price: 100 }), 2, 0)).toEqual([
      "Saint lo dio de baja",
      "Sin stock",
      "Sin precio (falta la tasa)",
    ]);
    expect(avisos(product({ isActive: false, stockQuantity: 1, currency: "VES", price: 100 }), 2, 0)).toEqual([
      "Saint lo dio de baja",
      "Solo hay 1",
      "Sin precio (falta la tasa)",
    ]);
  });
});

describe("textoCarritoParaCliente", () => {
  const BASE =
    "Casco LS2\nSKU: C-001\nPrecio: $118.00\n\n" +
    "Guante (x2)\nSKU: G-002\nPrecio: $50.00 c/u · $100.00\n\n" +
    "Total: $218.00\n" +
    "Total en bolívares: Bs. 21.800,00";

  it("sin Cashea: bloques por producto, total en dólares y total en bolívares", () => {
    expect(textoCarritoParaCliente(totalesCarrito(CARRITO_218, 100, SIN_CASHEA))).toBe(BASE);
  });

  it("con Cashea suma el plan: nivel, inicial y resto", () => {
    expect(textoCarritoParaCliente(totalesCarrito(CARRITO_218, 100, conCashea()))).toBe(
      `${BASE}\n\nFinanciado con Cashea (nivel 4):\n` +
        "Inicial (25%): $54,50\n" +
        "Resto: 6 cuotas de $27,25, cada 14 días, sin intereses.",
    );
  });

  it("con planCashea apagado el plan no se agrega aunque Cashea esté activo", () => {
    const totales = totalesCarrito(CARRITO_218, 100, conCashea());
    expect(textoCarritoParaCliente(totales, { ...OPCIONES_COPIA_INICIALES, planCashea: false })).toBe(BASE);
  });

  it("con las opciones iniciales el texto es el de siempre (con y sin Cashea)", () => {
    const sinPlan = totalesCarrito(CARRITO_218, 100, SIN_CASHEA);
    expect(textoCarritoParaCliente(sinPlan, OPCIONES_COPIA_INICIALES)).toBe(textoCarritoParaCliente(sinPlan));
    const conPlan = totalesCarrito(CARRITO_218, 100, conCashea());
    expect(textoCarritoParaCliente(conPlan, OPCIONES_COPIA_INICIALES)).toContain("Financiado con Cashea (nivel 4)");
  });

  it("las casillas del chat también valen aquí: sin código ni total en bolívares", () => {
    const totales = totalesCarrito(CARRITO_218, 100, SIN_CASHEA);
    const texto = textoCarritoParaCliente(totales, { ...OPCIONES_COPIA_INICIALES, codigo: false, totalBs: false });
    expect(texto).toBe(
      "Casco LS2\nPrecio: $118.00\n\nGuante (x2)\nPrecio: $50.00 c/u · $100.00\n\nTotal: $218.00",
    );
  });

  it("un renglón estándar se copia sin la frase del envío", () => {
    const conTarifa = product({ id: "t", name: "Caucho", price: 25, saintCode: "T-1", weightKg: 2, shippingFeeUsd: 2.5 });
    const texto = textoCarritoParaCliente(totalesCarrito([linea(conTarifa, 1, "estandar")], 40, SIN_CASHEA));
    expect(texto).not.toContain("incluye envío");
    expect(texto).toContain("Precio: $27.50");
  });

  it("es null con un renglón sin precio y con el carrito vacío", () => {
    const sinTasa = totalesCarrito([linea(product({ currency: "VES", price: 5000 }))], 0, conCashea());
    expect(textoCarritoParaCliente(sinTasa)).toBeNull();
    expect(textoCarritoParaCliente(totalesCarrito([], 100, SIN_CASHEA))).toBeNull();
  });
});
