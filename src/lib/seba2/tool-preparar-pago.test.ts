import { describe, expect, it, vi } from "vitest";
import type { PaymentMethodConfig } from "@/lib/payment-methods";
import type { Product } from "@/lib/types";
import { crearEffectsDeMemoria, type GuionDeMemoria } from "./effects-memoria";
import { crearSesion } from "./sesion";
import { estadoInicial, type Entrega } from "./tipos";
import { lineaTiendaCerrada } from "./textos";
import {
  buildPrepararPagoTool,
  ejecutarPrepararPago,
  NOMBRE_PREPARAR_PAGO,
  type DepsDePrepararPago,
} from "./tool-preparar-pago";

const AHORA = new Date("2026-11-17T15:00:00.000Z");
const TASA = 40;
const DATOS_CASHEA = "Para generar tu link de compra necesito estos datos:\n✅ Cédula del titular";

function producto(over: Partial<Product> = {}): Product {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "CASCO FRANKIE NEGRO MATE",
    brand: null,
    price: 30,
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
    instructions: "Banco X\nTeléfono 0414-0000000",
    sebaEntrega: true,
    isActive: true,
    sortOrder: 10,
    updatedAt: "2026-11-17T10:00:00.000Z",
    ...over,
  };
}

const METODOS = [
  metodo(),
  metodo({ key: "binance", label: "Binance", currency: "USD", sebaEntrega: false, instructions: "Pay ID 1", sortOrder: 20 }),
  metodo({ key: "zelle", label: "Zelle", currency: "USD", isActive: false, sortOrder: 30 }),
];

interface Montaje {
  deps: DepsDePrepararPago;
  fx: ReturnType<typeof crearEffectsDeMemoria>;
  sesion: ReturnType<typeof crearSesion>;
}

function montar(
  productos: Product[] = [producto()],
  guion: GuionDeMemoria = {},
  extra: Partial<DepsDePrepararPago> = {},
): Montaje {
  const fx = crearEffectsDeMemoria({ yaCotizados: productos.map((p) => p.id), ...guion });
  const sesion = crearSesion({
    estado: estadoInicial(AHORA),
    escaladaAbierta: false,
    tiendaAbierta: true,
    cuandoAbre: null,
    ahora: AHORA,
  });
  const deps: DepsDePrepararPago = {
    effects: fx,
    sesion,
    metodos: METODOS,
    cashea: { datosText: DATOS_CASHEA, minimoUsd: 25, seisCuotasDesdeUsd: 100 },
    cargarProductos: async (ids) => productos.filter((p) => ids.includes(p.id)),
    leerTasa: async () => TASA,
    ...extra,
  };
  return { deps, fx, sesion };
}

function pedir(
  productoId: string,
  formaDePago: string,
  entrega: Entrega = "retiro",
  extra: { cantidad?: number; ciudad?: string } = {},
) {
  return {
    lineas: [{ productId: productoId, cantidad: extra.cantidad ?? 1 }],
    formaDePago,
    entrega,
    ciudad: extra.ciudad,
  };
}

const ID = producto().id;

describe("prepararPago — datos de pago de contado", () => {
  it("guarda el carrito, envía el resumen y deja el estado en datos_enviados", async () => {
    const { deps, fx, sesion } = montar();
    const salida = await ejecutarPrepararPago(deps, pedir(ID, "pago_movil"));

    expect(fx.registro.secuencia).toEqual(["guardarCarrito", "enviarTexto"]);
    expect(fx.registro.carrito).toEqual([{ productId: ID, cantidad: 1, priceKind: "promocion" }]);
    expect(fx.registro.mensajes).toHaveLength(1);
    expect(fx.registro.mensajes[0]).toMatchObject({ origen: "herramienta", tipo: "texto" });
    expect(fx.registro.mensajes[0].texto).toContain("Total: $30,00 BCV (Bs. 1.200,00)");
    expect(fx.registro.mensajes[0].texto).toContain("Banco X");

    expect(sesion.estado).toMatchObject({
      etapa: "datos_enviados",
      lineas: [{ productId: ID, cantidad: 1 }],
      forma: "pago_movil",
      entrega: "retiro",
      ciudad: null,
      totalUsd: 30,
      totalBs: 1200,
      priceKind: "promocion",
    });
    expect(sesion.estado.actualizadoEn).toBe(AHORA.toISOString());
    expect(sesion.terminado).toBe(true);
    expect(sesion.paso).toBeNull();
    expect(sesion.herramientas).toEqual([NOMBRE_PREPARAR_PAGO]);
    expect(sesion.productos.has(ID)).toBe(true);
    expect(sesion.fuentes).toEqual([fx.registro.mensajes[0].texto]);
    expect(salida).toBe("Listo: el resumen y los datos de pago ya se enviaron. No escribas nada más.");
  });

  it("un envío de contado guarda el carrito a precio estándar y recuerda la ciudad", async () => {
    const { deps, fx, sesion } = montar();
    await ejecutarPrepararPago(deps, pedir(ID, "pago_movil", "envio", { ciudad: "  Barinas " }));
    expect(fx.registro.carrito).toEqual([{ productId: ID, cantidad: 1, priceKind: "estandar" }]);
    expect(sesion.estado).toMatchObject({ priceKind: "estandar", totalUsd: 33, ciudad: "Barinas", entrega: "envio" });
    expect(fx.registro.mensajes[0].texto).toContain("Total con envío MRW incluido: ");
  });

  it("un envío fallido no pasa a asesor ni marca terminado", async () => {
    const { deps, fx, sesion } = montar([producto()], { envioFalla: true });
    const salida = await ejecutarPrepararPago(deps, pedir(ID, "pago_movil"));
    expect(fx.registro.secuencia).toEqual(["guardarCarrito", "enviarTexto"]);
    expect(fx.registro.pases).toEqual([]);
    expect(sesion.terminado).toBe(false);
    expect(sesion.estado.etapa).toBe("entender");
    expect(salida).toBe("No se pudo enviar el mensaje.");
  });
});

describe("prepararPago — Cashea (D1)", () => {
  it("manda el resumen y pasa a ventas por listo_para_comprar, con nota completa", async () => {
    const { deps, fx, sesion } = montar([producto({ price: 50 })]);
    const salida = await ejecutarPrepararPago(deps, pedir(ID, "cashea"));

    expect(fx.registro.secuencia).toEqual(["guardarCarrito", "enviarTexto", "pasarAAsesor"]);
    expect(fx.registro.mensajes[0].texto).toContain(DATOS_CASHEA);
    expect(fx.registro.mensajes[0].texto).toContain("envío gratis con Cashea");
    expect(fx.registro.pases).toHaveLength(1);
    const pase = fx.registro.pases[0];
    expect(pase).toMatchObject({ area: "ventas", motivo: "listo_para_comprar" });
    expect(pase.nota).toContain("1 × CASCO FRANKIE NEGRO MATE (SAINT 00123)");
    expect(pase.nota).toContain("Cashea");
    expect(pase.nota).toContain("Falta: enviarle el link de Cashea");
    expect(pase.nota.length).toBeLessThanOrEqual(600);

    expect(sesion.estado.etapa).toBe("con_asesor");
    expect(sesion.estado).toMatchObject({ forma: "cashea", totalUsd: 50, priceKind: "promocion" });
    expect(sesion.paso).toEqual({ area: "ventas", motivo: "listo_para_comprar" });
    expect(sesion.terminado).toBe(true);
    expect(salida).toBe("Listo: el resumen ya se envió y el caso pasó a ventas. No escribas nada más.");
  });

  it("falta poco para el mínimo: la primera vez NO envía ni pasa, marca el complemento; la segunda sí", async () => {
    const { deps, fx, sesion } = montar([producto({ price: 23 })]);

    const primera = await ejecutarPrepararPago(deps, pedir(ID, "cashea"));
    expect(fx.registro.secuencia).toEqual([]);
    expect(fx.registro.mensajes).toEqual([]);
    expect(sesion.estado.complementoSugerido).toBe(true);
    expect(sesion.estado.etapa).toBe("entender");
    expect(sesion.terminado).toBe(false);
    expect(primera).toContain("$2,00");
    expect(primera).toContain("compra mínima de Cashea");
    expect(primera).toContain("UNA vez");
    expect(sesion.fuentes).toContain(primera);

    const segunda = await ejecutarPrepararPago(deps, pedir(ID, "cashea"));
    expect(fx.registro.secuencia).toEqual(["guardarCarrito", "enviarTexto", "pasarAAsesor"]);
    expect(sesion.estado.etapa).toBe("con_asesor");
    expect(sesion.terminado).toBe(true);
    expect(segunda).toContain("pasó a ventas");
  });

  it("falta entre 0,01 y 15 $ para las seis cuotas: sugiere el complemento una vez", async () => {
    const { deps, fx, sesion } = montar([producto({ price: 90 })]);
    const primera = await ejecutarPrepararPago(deps, pedir(ID, "cashea"));
    expect(fx.registro.secuencia).toEqual([]);
    expect(sesion.estado.complementoSugerido).toBe(true);
    expect(primera).toContain("$10,00");
    expect(primera).toContain("seis cuotas");
    expect(primera).not.toMatch(/inicial|%/);
  });

  it("falta más de 15 $ para las seis cuotas: no hay sugerencia, envía y pasa", async () => {
    const { deps, fx } = montar([producto({ price: 80 })]);
    await ejecutarPrepararPago(deps, pedir(ID, "cashea"));
    expect(fx.registro.secuencia).toEqual(["guardarCarrito", "enviarTexto", "pasarAAsesor"]);
  });

  it("si el complemento ya se sugirió en un turno anterior, no vuelve a frenar", async () => {
    const { deps, fx, sesion } = montar([producto({ price: 23 })]);
    sesion.estado = { ...sesion.estado, complementoSugerido: true };
    await ejecutarPrepararPago(deps, pedir(ID, "cashea"));
    expect(fx.registro.secuencia).toEqual(["guardarCarrito", "enviarTexto", "pasarAAsesor"]);
  });
});

describe("prepararPago — pasa a ventas sin montos", () => {
  it("una forma que Seba no entrega (Binance) envía el resumen sin cifras y pasa el caso", async () => {
    const { deps, fx, sesion } = montar();
    await ejecutarPrepararPago(deps, pedir(ID, "binance"));
    expect(fx.registro.secuencia).toEqual(["guardarCarrito", "enviarTexto", "pasarAAsesor"]);
    expect(fx.registro.mensajes[0].texto).not.toContain("$");
    expect(fx.registro.pases[0].nota).toContain("Falta: precio en divisa y datos de Binance");
    expect(fx.registro.pases[0]).toMatchObject({ area: "ventas", motivo: "listo_para_comprar" });
    expect(sesion.estado).toMatchObject({ etapa: "con_asesor", forma: "binance", totalUsd: null, totalBs: null });
    expect(sesion.terminado).toBe(true);
  });

  it("un envío sin peso pasa a ventas y la nota dice qué falta", async () => {
    const sinPeso = producto({ weightKg: null, shippingFeeUsd: null });
    const { deps, fx } = montar([sinPeso]);
    await ejecutarPrepararPago(deps, pedir(ID, "pago_movil", "envio", { ciudad: "Barinas" }));
    expect(fx.registro.mensajes[0].texto).not.toContain("$");
    expect(fx.registro.mensajes[0].texto).not.toContain("Banco X");
    const nota = fx.registro.pases[0].nota;
    expect(nota).toContain("Falta: precio con envío de CASCO FRANKIE NEGRO MATE (sin peso cargado)");
    expect(nota).toContain("envío (Barinas)");
  });

  it("sin tasa pasa a ventas", async () => {
    const { deps, fx } = montar([producto()], {}, { leerTasa: async () => null });
    await ejecutarPrepararPago(deps, pedir(ID, "pago_movil"));
    expect(fx.registro.secuencia).toEqual(["guardarCarrito", "enviarTexto", "pasarAAsesor"]);
    expect(fx.registro.pases[0].nota).toContain("tasa");
  });

  it("la nota nunca pasa de 600 caracteres", async () => {
    const largos = Array.from({ length: 15 }, (_, n) =>
      producto({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name: `PRODUCTO CON UN NOMBRE MUY LARGO NUMERO ${n} `.repeat(2), price: 60 }),
    );
    const { deps, fx } = montar(largos);
    await ejecutarPrepararPago(deps, {
      lineas: largos.map((p) => ({ productId: p.id, cantidad: 1 })),
      formaDePago: "cashea",
      entrega: "retiro",
    });
    expect(fx.registro.pases[0].nota.length).toBeLessThanOrEqual(600);
  });

  it("tienda cerrada: tras el pase agrega la línea de apertura como texto fijo", async () => {
    const { deps, fx } = montar([producto({ price: 50 })], {
      pase: { abierta: false, cuandoAbre: "el lunes a las 8:00 am" },
    });
    await ejecutarPrepararPago(deps, pedir(ID, "cashea"));
    expect(fx.registro.secuencia).toEqual(["guardarCarrito", "enviarTexto", "pasarAAsesor", "enviarTexto"]);
    expect(fx.registro.mensajes).toHaveLength(2);
    expect(fx.registro.mensajes[1]).toMatchObject({
      origen: "fijo",
      texto: lineaTiendaCerrada("el lunes a las 8:00 am"),
    });
  });

  it("tienda abierta: no agrega ninguna línea de apertura", async () => {
    const { deps, fx } = montar([producto({ price: 50 })]);
    await ejecutarPrepararPago(deps, pedir(ID, "cashea"));
    expect(fx.registro.mensajes).toHaveLength(1);
  });

  it("si pasarAAsesor lanza, no manda la línea de tienda cerrada, marca terminado y relanza", async () => {
    const { deps, fx, sesion } = montar([producto({ price: 50 })], {
      paseLanza: new Error("la base no responde"),
      pase: { abierta: false, cuandoAbre: "el lunes a las 8:00 am" },
    });
    await expect(ejecutarPrepararPago(deps, pedir(ID, "cashea"))).rejects.toThrow("la base no responde");
    expect(fx.registro.mensajes).toHaveLength(1);
    expect(sesion.terminado).toBe(true);
    expect(sesion.estado.etapa).not.toBe("con_asesor");
    expect(sesion.paso).toBeNull();
  });
});

describe("prepararPago — rechazos: no envía nada y le explica al modelo", () => {
  it("falta la ciudad de un envío", async () => {
    const { deps, fx, sesion } = montar();
    const salida = await ejecutarPrepararPago(deps, pedir(ID, "pago_movil", "envio"));
    expect(fx.registro.secuencia).toEqual([]);
    expect(salida).toBe("Falta la ciudad de envío: pregúntasela al cliente.");
    expect(sesion.terminado).toBe(false);
    expect(sesion.herramientas).toEqual([NOMBRE_PREPARAR_PAGO]);
  });

  it("producto que no se ha cotizado en la conversación", async () => {
    const { deps, fx } = montar([producto()], { yaCotizados: [] });
    const salida = await ejecutarPrepararPago(deps, pedir(ID, "pago_movil"));
    expect(fx.registro.secuencia).toEqual([]);
    expect(salida).toBe("Ese producto no se ha cotizado en esta conversación: búscalo primero con buscarRepuesto.");
  });

  it("un producto cotizado en ESTE turno vale aunque la base todavía no lo tenga anotado", async () => {
    // En sombra la búsqueda no inserta en conversation_quotes: el turno anota lo
    // que cotizó en `sesion.productos`, y eso tiene que alcanzar.
    const { deps, fx, sesion } = montar([producto()], { yaCotizados: [] });
    sesion.productos.add(ID);
    const salida = await ejecutarPrepararPago(deps, pedir(ID, "pago_movil"));
    expect(salida).toContain("Listo");
    expect(fx.registro.secuencia.length).toBeGreaterThan(0);
  });

  it("un id que nunca se cotizó se rechaza SIN ir a la base a buscarlo", async () => {
    // Prueba real del 17/11/2026: el modelo llegó a mandar un id que no era el del producto. Lo que
    // no está en lo cotizado no se consulta: ni un viaje a la base con un id que escribió un modelo.
    const cargarProductos = vi.fn(async () => [producto()]);
    const { deps, fx } = montar([producto()], { yaCotizados: [] }, { cargarProductos });
    const salida = await ejecutarPrepararPago(deps, pedir(ID, "pago_movil"));
    expect(salida).toContain("no se ha cotizado");
    expect(cargarProductos).not.toHaveBeenCalled();
    expect(fx.registro.secuencia).toEqual([]);
  });

  it("un id que la base no devuelve cuenta como producto no buscado", async () => {
    const { deps, fx } = montar([], { yaCotizados: [ID] });
    const salida = await ejecutarPrepararPago(deps, pedir(ID, "pago_movil"));
    expect(fx.registro.secuencia).toEqual([]);
    expect(salida).toContain("no se ha cotizado");
  });

  it("producto sin existencia: nombra el producto", async () => {
    const { deps, fx } = montar([producto({ stockQuantity: 0 })]);
    const salida = await ejecutarPrepararPago(deps, pedir(ID, "pago_movil"));
    expect(fx.registro.secuencia).toEqual([]);
    expect(salida).toContain("CASCO FRANKIE NEGRO MATE no tiene existencia");
  });

  it("forma de pago inactiva: lista las formas disponibles", async () => {
    const { deps, fx } = montar();
    const salida = await ejecutarPrepararPago(deps, pedir(ID, "zelle"));
    expect(fx.registro.secuencia).toEqual([]);
    expect(salida).toContain("Cashea");
    expect(salida).toContain("Pago móvil");
    expect(salida).not.toContain("Zelle");
  });

  it("cantidad inválida", async () => {
    const { deps, fx } = montar();
    const salida = await ejecutarPrepararPago(deps, pedir(ID, "pago_movil", "retiro", { cantidad: 25 }));
    expect(fx.registro.secuencia).toEqual([]);
    expect(salida).toContain("cantidad");
  });
});

describe("prepararPago — la herramienta del SDK", () => {
  type Schema = { safeParse: (v: unknown) => { success: boolean } };
  function esquema(): Schema {
    const { deps } = montar();
    return (buildPrepararPagoTool(deps) as unknown as { inputSchema: Schema }).inputSchema;
  }
  const valida = { lineas: [{ productId: ID, cantidad: 2 }], formaDePago: "cashea", entrega: "retiro" };

  it("acepta un pedido bien formado, con o sin ciudad", () => {
    expect(esquema().safeParse(valida).success).toBe(true);
    expect(esquema().safeParse({ ...valida, formaDePago: "pago_movil", entrega: "envio", ciudad: "Barinas" }).success).toBe(true);
  });

  it("rechaza una forma de pago que no está activa (o no existe)", () => {
    expect(esquema().safeParse({ ...valida, formaDePago: "zelle" }).success).toBe(false);
    expect(esquema().safeParse({ ...valida, formaDePago: "efectivo_fantasma" }).success).toBe(false);
  });

  it("rechaza cantidad 0, no entera o mayor que 20", () => {
    for (const cantidad of [0, 1.5, 21]) {
      expect(esquema().safeParse({ ...valida, lineas: [{ productId: ID, cantidad }] }).success).toBe(false);
    }
  });

  it("rechaza lista vacía, más de 15 renglones, un id que no es uuid y una entrega desconocida", () => {
    expect(esquema().safeParse({ ...valida, lineas: [] }).success).toBe(false);
    const muchas = Array.from({ length: 16 }, () => ({ productId: ID, cantidad: 1 }));
    expect(esquema().safeParse({ ...valida, lineas: muchas }).success).toBe(false);
    expect(esquema().safeParse({ ...valida, lineas: [{ productId: "no-es-uuid", cantidad: 1 }] }).success).toBe(false);
    // Un id con forma de UUID pero que no es v4 (los del catálogo de demostración: «eeeeeeee-0000-0000-…»)
    // tiene que pasar tal cual. Con `z.uuid()` el modelo, obligado por el formato, lo «corregía» a un v4
    // válido (…-4000-8000-…) y el producto dejaba de existir (prueba real del 17/11/2026).
    expect(
      esquema().safeParse({ ...valida, lineas: [{ productId: "eeeeeeee-0000-0000-0000-000000000005", cantidad: 1 }] }).success
    ).toBe(true);
    expect(esquema().safeParse({ ...valida, entrega: "drone" }).success).toBe(false);
  });

  it("rechaza una ciudad de más de 60 caracteres", () => {
    expect(esquema().safeParse({ ...valida, ciudad: "x".repeat(61) }).success).toBe(false);
  });

  it("R2/C3: la descripción dice de dónde salen los productId y que no hace falta buscar de nuevo lo que ya está en el pedido", () => {
    const { deps } = montar();
    const { description } = buildPrepararPagoTool(deps) as unknown as { description: string };
    expect(description).toContain("«Pedido» en TURNO ACTUAL");
    expect(description).toContain("buscarRepuesto");
    expect(description).toMatch(/NO hace falta buscar de nuevo un producto que ya está en el pedido/);
  });

  it("el execute del SDK corre la misma lógica", async () => {
    const { deps, fx } = montar();
    const t = buildPrepararPagoTool(deps) as unknown as {
      execute: (entrada: unknown, opciones: unknown) => Promise<string>;
    };
    const salida = await t.execute(pedir(ID, "pago_movil"), { toolCallId: "t1", messages: [] });
    expect(salida).toContain("Listo");
    expect(fx.registro.secuencia).toEqual(["guardarCarrito", "enviarTexto"]);
  });
});
