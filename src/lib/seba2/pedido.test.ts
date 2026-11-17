import { describe, expect, it } from "vitest";
import { cartTotals, priceCartLines } from "@/lib/conversation-cart";
import type { PaymentMethodConfig } from "@/lib/payment-methods";
import type { Product } from "@/lib/types";
import {
  armarPedido,
  renglonesParaNota,
  tipoDePrecio,
  type EntradaDePedido,
  type ResultadoPedido,
} from "./pedido";
import { LINEA_ASESOR_BINANCE, LINEA_PEDIR_COMPROBANTE } from "./textos";

const TASA = 40;

function producto(over: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "CASCO FRANKIE NEGRO MATE",
    brand: null,
    price: 20,
    currency: "USD",
    stockQuantity: 5,
    description: null,
    isActive: true,
    updatedAt: "2026-11-17T10:00:00.000Z",
    compatibility: [],
    weightKg: 1.2,
    shippingFeeUsd: 3,
    precioDivisaUsd: null,
    saintCode: "00123",
    saintAddedAt: null,
    saintRemovedAt: null,
    fotos: [],
    ...over,
  };
}

function metodo(over: Partial<PaymentMethodConfig> = {}): PaymentMethodConfig {
  return {
    key: "pago_movil",
    label: "Pago móvil",
    currency: "VES",
    instructions: "Banco X\nTeléfono 0414-0000000\nCI V-1234567",
    sebaEntrega: true,
    isActive: true,
    sortOrder: 10,
    updatedAt: "2026-11-17T10:00:00.000Z",
    ...over,
  };
}

const DATOS_CASHEA = "Para generar tu link de compra necesito estos datos:\n✅ Cédula del titular";

function entrada(over: Partial<EntradaDePedido> = {}): EntradaDePedido {
  const p = producto();
  return {
    lineas: [{ product: p, cantidad: 1 }],
    forma: "pago_movil",
    entrega: "retiro",
    ciudad: null,
    bcvRate: TASA,
    metodos: [metodo(), metodo({ key: "binance", label: "Binance", currency: "USD", sebaEntrega: false, instructions: "Pay ID 123" })],
    yaCotizados: new Set([p.id]),
    casheaDatosText: DATOS_CASHEA,
    casheaMinimoUsd: 25,
    casheaSeisCuotasDesdeUsd: 100,
    ...over,
  };
}

function mensajeDe(r: ResultadoPedido): string {
  if (r.tipo === "rechazado") throw new Error(`rechazado: ${r.razon}`);
  return r.mensaje;
}

describe("armarPedido — el total sale del MISMO camino que el carrito del asesor", () => {
  it("un producto a promoción: el total es igual a cartTotals(priceCartLines(...)) del carrito", () => {
    const p = producto({ price: 18.5 });
    const r = armarPedido(entrada({ lineas: [{ product: p, cantidad: 3 }], yaCotizados: new Set([p.id]) }));
    expect(r.tipo).toBe("datos_de_pago");
    if (r.tipo !== "datos_de_pago") return;
    const esperado = cartTotals(
      priceCartLines([{ product: p, quantity: 3, quotedPriceUsd: null, priceKind: "promocion" }], TASA),
    );
    expect(r.totalUsd).toBe(esperado.usd);
    expect(r.totalBs).toBe(esperado.bs);
    expect(r.priceKind).toBe("promocion");
  });

  it("un producto en bolívares pasa por usdFromBs igual que el carrito (nada recalculado a mano)", () => {
    const p = producto({ currency: "VES", price: 1017 });
    const r = armarPedido(entrada({ lineas: [{ product: p, cantidad: 1 }], yaCotizados: new Set([p.id]) }));
    const esperado = cartTotals(
      priceCartLines([{ product: p, quantity: 1, quotedPriceUsd: null, priceKind: "promocion" }], TASA),
    );
    expect(r.tipo).toBe("datos_de_pago");
    if (r.tipo !== "datos_de_pago") return;
    expect(r.totalUsd).toBe(esperado.usd);
  });

  it("contado con envío y todos con tarifa: usa el precio estándar y dice «envío MRW incluido»", () => {
    const p = producto({ price: 20, shippingFeeUsd: 3 });
    const r = armarPedido(
      entrada({ lineas: [{ product: p, cantidad: 2 }], entrega: "envio", ciudad: "Barinas", yaCotizados: new Set([p.id]) }),
    );
    expect(r.tipo).toBe("datos_de_pago");
    if (r.tipo !== "datos_de_pago") return;
    expect(r.priceKind).toBe("estandar");
    const esperado = cartTotals(
      priceCartLines([{ product: p, quantity: 2, quotedPriceUsd: null, priceKind: "estandar" }], TASA),
    );
    expect(r.totalUsd).toBe(esperado.usd);
    expect(r.totalUsd).toBe(46);
    expect(r.mensaje).toContain("Total con envío MRW incluido: ");
    expect(r.mensaje).toContain("Banco X");
    expect(r.mensaje).toContain(LINEA_PEDIR_COMPROBANTE);
  });

  it("el mensaje de datos de pago lleva el total con formatQuote, las instrucciones tal cual y el comprobante", () => {
    const r = armarPedido(entrada());
    expect(r.tipo).toBe("datos_de_pago");
    const m = mensajeDe(r);
    expect(m.startsWith("Tu pedido:\n1 × CASCO FRANKIE NEGRO MATE — $20,00 BCV\n")).toBe(true);
    expect(m).toContain("Total: $20,00 BCV (Bs. 800,00)");
    expect(m).toContain("\n\nBanco X\nTeléfono 0414-0000000\nCI V-1234567\n\n");
    expect(m.endsWith(LINEA_PEDIR_COMPROBANTE)).toBe(true);
  });

  it("renglones repetidos del mismo producto se suman", () => {
    const p = producto();
    const r = armarPedido(
      entrada({ lineas: [{ product: p, cantidad: 1 }, { product: p, cantidad: 2 }], yaCotizados: new Set([p.id]) }),
    );
    expect(r.tipo).toBe("datos_de_pago");
    if (r.tipo !== "datos_de_pago") return;
    expect(r.totalUsd).toBe(60);
    expect(r.mensaje).toContain("3 × CASCO FRANKIE NEGRO MATE");
  });
});

describe("armarPedido — sin precio estándar, sin tasa, sin precio", () => {
  it("contado con envío y un producto sin tarifa: pasa a ventas, sin instrucciones ni ningún «$»", () => {
    const bueno = producto({ id: "a", name: "CASCO A" });
    const sinTarifa = producto({ id: "b", name: "BATERIA B", weightKg: null, shippingFeeUsd: null });
    const r = armarPedido(
      entrada({
        lineas: [{ product: bueno, cantidad: 1 }, { product: sinTarifa, cantidad: 1 }],
        entrega: "envio",
        ciudad: "Barinas",
        yaCotizados: new Set(["a", "b"]),
      }),
    );
    expect(r.tipo).toBe("pasar_a_ventas");
    if (r.tipo !== "pasar_a_ventas") return;
    expect(r.razon).toBe("sin_precio_estandar");
    expect(r.detalle).toContain("BATERIA B");
    expect(r.detalle).not.toContain("CASCO A");
    expect(r.mensaje).not.toContain("Banco X");
    expect(r.mensaje).not.toContain("$");
    expect(r.mensaje).not.toContain("Bs");
    expect(r.mensaje).toContain("1 × CASCO A");
    expect(r.mensaje).toContain("Un asesor te confirma el total por este mismo chat.");
  });

  it("sin tasa: pasa a ventas con razón sin_tasa y sin montos", () => {
    for (const bcvRate of [null, 0, -3]) {
      const r = armarPedido(entrada({ bcvRate }));
      expect(r.tipo).toBe("pasar_a_ventas");
      if (r.tipo !== "pasar_a_ventas") continue;
      expect(r.razon).toBe("sin_tasa");
      expect(r.mensaje).not.toContain("$");
    }
  });

  it("un producto sin precio de promoción calculable pasa a ventas con razón sin_precio", () => {
    const p = producto({ price: 0 });
    const r = armarPedido(entrada({ lineas: [{ product: p, cantidad: 1 }], yaCotizados: new Set([p.id]) }));
    expect(r.tipo).toBe("pasar_a_ventas");
    if (r.tipo !== "pasar_a_ventas") return;
    expect(r.razon).toBe("sin_precio");
    expect(r.detalle).toContain(p.name);
  });

  it("una forma de contado sin instrucciones cargadas no puede entregarse: metodo_no_entregable", () => {
    const r = armarPedido(entrada({ metodos: [metodo({ instructions: "   " })] }));
    expect(r.tipo).toBe("pasar_a_ventas");
    if (r.tipo !== "pasar_a_ventas") return;
    expect(r.razon).toBe("metodo_no_entregable");
    expect(r.mensaje).not.toContain("$");
  });
});

describe("armarPedido — Cashea (D1)", () => {
  it("el mensaje trae los datos del titular y «envío gratis con Cashea», sin inicial, cuotas, % ni enlace", () => {
    const p = producto({ price: 30 });
    const r = armarPedido(entrada({ forma: "cashea", lineas: [{ product: p, cantidad: 1 }], yaCotizados: new Set([p.id]) }));
    expect(r.tipo).toBe("cashea");
    const m = mensajeDe(r);
    expect(m).toContain(DATOS_CASHEA);
    expect(m).toContain("Total: $30,00 BCV · envío gratis con Cashea");
    expect(m).toContain("1 × CASCO FRANKIE NEGRO MATE — $30,00 BCV");
    expect(m).not.toContain("%");
    expect(m).not.toContain("inicial de");
    expect(m).not.toContain("cuota de");
    expect(m).not.toContain("http");
  });

  it("Cashea con envío usa el precio de promoción (el envío es gratis), nunca el estándar", () => {
    const p = producto({ price: 30, shippingFeeUsd: 5 });
    const r = armarPedido(
      entrada({ forma: "cashea", entrega: "envio", ciudad: "Barinas", lineas: [{ product: p, cantidad: 1 }], yaCotizados: new Set([p.id]) }),
    );
    expect(r.tipo).toBe("cashea");
    if (r.tipo !== "cashea") return;
    expect(r.totalUsd).toBe(30);
  });

  it("un pedido de 23 $ con mínimo 25 deja faltaParaMinimoUsd = 2", () => {
    const p = producto({ price: 23 });
    const r = armarPedido(entrada({ forma: "cashea", lineas: [{ product: p, cantidad: 1 }], yaCotizados: new Set([p.id]) }));
    expect(r.tipo).toBe("cashea");
    if (r.tipo !== "cashea") return;
    expect(r.faltaParaMinimoUsd).toBe(2);
    expect(r.faltaParaSeisCuotasUsd).toBe(77);
  });

  it("un pedido que supera ambos umbrales deja los dos faltantes en null", () => {
    const p = producto({ price: 120 });
    const r = armarPedido(entrada({ forma: "cashea", lineas: [{ product: p, cantidad: 1 }], yaCotizados: new Set([p.id]) }));
    expect(r.tipo).toBe("cashea");
    if (r.tipo !== "cashea") return;
    expect(r.faltaParaMinimoUsd).toBeNull();
    expect(r.faltaParaSeisCuotasUsd).toBeNull();
  });

  it("Cashea no consulta las formas de contado: aunque no esté entre los métodos, no es «forma_inactiva»", () => {
    const r = armarPedido(entrada({ forma: "cashea", metodos: [] }));
    expect(r.tipo).toBe("cashea");
  });
});

describe("armarPedido — forma que no entrega Seba (Binance, D3)", () => {
  it("pasa a ventas SIN montos aunque la forma no se llame Binance", () => {
    const r = armarPedido(
      entrada({
        forma: "zinli",
        metodos: [metodo({ key: "zinli", label: "Zinli", currency: "USD", sebaEntrega: false, instructions: "Correo zinli@x.com" })],
      }),
    );
    expect(r.tipo).toBe("pasar_a_ventas");
    if (r.tipo !== "pasar_a_ventas") return;
    expect(r.razon).toBe("binance_divisa");
    expect(r.mensaje).not.toContain("$");
    expect(r.mensaje).not.toContain("Bs");
    expect(r.mensaje).not.toContain("Correo zinli");
    expect(r.mensaje).toContain("1 × CASCO FRANKIE NEGRO MATE");
    expect(r.mensaje.endsWith(LINEA_ASESOR_BINANCE)).toBe(true);
  });
});

describe("armarPedido — rechazos", () => {
  it("pedido vacío", () => {
    const r = armarPedido(entrada({ lineas: [] }));
    expect(r).toMatchObject({ tipo: "rechazado", razon: "pedido_vacio" });
  });

  it("cantidad fuera de 1-20 o no entera", () => {
    for (const cantidad of [0, -1, 21, 1.5, Number.NaN]) {
      const p = producto();
      const r = armarPedido(entrada({ lineas: [{ product: p, cantidad }] }));
      expect(r).toMatchObject({ tipo: "rechazado", razon: "cantidad_invalida" });
    }
  });

  it("la suma de renglones repetidos que pasa de 20 también es cantidad inválida", () => {
    const p = producto();
    const r = armarPedido(entrada({ lineas: [{ product: p, cantidad: 12 }, { product: p, cantidad: 12 }] }));
    expect(r).toMatchObject({ tipo: "rechazado", razon: "cantidad_invalida" });
  });

  it("un producto que no se ha cotizado en la conversación", () => {
    const r = armarPedido(entrada({ yaCotizados: new Set() }));
    expect(r.tipo).toBe("rechazado");
    if (r.tipo !== "rechazado") return;
    expect(r.razon).toBe("producto_no_buscado");
    expect(r.detalle).toContain("CASCO FRANKIE NEGRO MATE");
  });

  it("un producto sin existencia", () => {
    const p = producto({ stockQuantity: 0 });
    const r = armarPedido(entrada({ lineas: [{ product: p, cantidad: 1 }], yaCotizados: new Set([p.id]) }));
    expect(r.tipo).toBe("rechazado");
    if (r.tipo !== "rechazado") return;
    expect(r.razon).toBe("sin_existencia");
    expect(r.detalle).toContain(p.name);
  });

  it("forma de contado inexistente o inactiva", () => {
    expect(armarPedido(entrada({ forma: "efectivo_fantasma" }))).toMatchObject({ tipo: "rechazado", razon: "forma_inactiva" });
    expect(
      armarPedido(entrada({ metodos: [metodo({ isActive: false })] })),
    ).toMatchObject({ tipo: "rechazado", razon: "forma_inactiva" });
  });

  it("envío sin ciudad (vacía o solo espacios)", () => {
    for (const ciudad of [null, "", "   "]) {
      const r = armarPedido(entrada({ entrega: "envio", ciudad }));
      expect(r).toMatchObject({ tipo: "rechazado", razon: "falta_ciudad" });
    }
  });

  it("un rechazo no trae mensaje para el cliente", () => {
    const r = armarPedido(entrada({ lineas: [] }));
    expect(r).not.toHaveProperty("mensaje");
  });
});

describe("armarPedido — ningún mensaje nombra a Seba ni promete confirmar el pago", () => {
  it("recorre todos los caminos que sí producen un mensaje", () => {
    const sinTarifa = producto({ id: "b", weightKg: null, shippingFeeUsd: null });
    const casos: EntradaDePedido[] = [
      entrada(),
      entrada({ entrega: "envio", ciudad: "Barinas" }),
      entrada({ forma: "cashea" }),
      entrada({ forma: "binance" }),
      entrada({ bcvRate: null }),
      entrada({ lineas: [{ product: sinTarifa, cantidad: 1 }], entrega: "envio", ciudad: "Barinas", yaCotizados: new Set(["b"]) }),
    ];
    for (const caso of casos) {
      const r = armarPedido(caso);
      const m = mensajeDe(r);
      expect(m).not.toMatch(/seba/i);
      expect(m.toLowerCase()).not.toContain("gracias por tu compra");
      expect(m.toLowerCase()).not.toContain("pago confirmado");
    }
  });
});

describe("tipoDePrecio y renglonesParaNota", () => {
  it("estándar solo con forma de contado y envío", () => {
    expect(tipoDePrecio("pago_movil", "envio")).toBe("estandar");
    expect(tipoDePrecio("pago_movil", "retiro")).toBe("promocion");
    expect(tipoDePrecio("pago_movil", "delivery")).toBe("promocion");
    expect(tipoDePrecio("cashea", "envio")).toBe("promocion");
  });

  it("renglonesParaNota: cantidad, nombre exacto y código de SAINT si lo hay", () => {
    const filas = renglonesParaNota([
      { product: producto({ name: "CASCO A", saintCode: "0042" }), cantidad: 2 },
      { product: producto({ id: "x", name: "BATERIA B", saintCode: null }), cantidad: 1 },
    ]);
    expect(filas).toEqual(["2 × CASCO A (SAINT 0042)", "1 × BATERIA B"]);
  });
});
