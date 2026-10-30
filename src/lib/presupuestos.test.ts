import { describe, expect, it } from "vitest";
import type { Product } from "@/lib/types";
import { priceCartLines } from "@/lib/conversation-cart";
import {
  comparacionTotal,
  etiquetaComparacion,
  filtrarPresupuestos,
  lineasDePresupuesto,
  MAX_NOMBRE_CLIENTE,
  MAX_NOTA_PRESUPUESTO,
  nombreCompletoPresupuesto,
  puedeEditarPresupuesto,
  renglonesParaGuardar,
  separarNombreContacto,
  validarDatosPresupuesto,
  type Presupuesto,
  type PresupuestoItem,
} from "@/lib/presupuestos";

// 21/10/2026, "Presupuestos y mensajes rápidos" (T3): reglas puras de los
// presupuestos guardados.

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
    updatedAt: "2026-10-21T10:00:00.000Z",
    compatibility: [],
    weightKg: null,
    shippingFeeUsd: null,
    precioDivisaUsd: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    ...over,
  };
}

function renglon(over: Partial<PresupuestoItem> = {}): PresupuestoItem {
  const p = over.product ?? product();
  return {
    id: "item-1",
    productId: p.id,
    product: p,
    quantity: 1,
    priceKind: "promocion",
    precioCotizadoUsd: 20,
    ...over,
  };
}

function presupuesto(over: Partial<Presupuesto> = {}): Presupuesto {
  return {
    id: "pres-1",
    clienteNombre: "María",
    clienteApellido: "Pérez",
    contactId: null,
    conversationId: null,
    origen: "inventario",
    nota: null,
    totalCotizadoUsd: 20,
    createdBy: "agente-1",
    creadoPorNombre: "Ana",
    createdAt: "2026-10-21T10:00:00.000Z",
    updatedAt: "2026-10-21T10:00:00.000Z",
    items: [renglon()],
    ...over,
  };
}

describe("validarDatosPresupuesto", () => {
  const ok = { nombre: "María", apellido: "Pérez", nota: "" };

  it("datos completos no tienen errores; la nota es opcional", () => {
    expect(validarDatosPresupuesto(ok)).toEqual({});
  });

  it("nombre y apellido vacíos o solo espacios piden escribirlos", () => {
    expect(validarDatosPresupuesto({ ...ok, nombre: "   ", apellido: "" })).toEqual({
      nombre: "Escribe el nombre del cliente.",
      apellido: "Escribe el apellido del cliente.",
    });
  });

  it("mide sobre el texto recortado: 80 caracteres con espacios alrededor pasan; 81 no", () => {
    const justo = "a".repeat(MAX_NOMBRE_CLIENTE);
    expect(validarDatosPresupuesto({ ...ok, nombre: `  ${justo}  ` })).toEqual({});
    expect(validarDatosPresupuesto({ ...ok, nombre: justo + "a", apellido: justo + "a" })).toEqual({
      nombre: "Máximo 80 caracteres.",
      apellido: "Máximo 80 caracteres.",
    });
  });

  it("la nota admite hasta 280 caracteres recortados", () => {
    expect(validarDatosPresupuesto({ ...ok, nota: "n".repeat(MAX_NOTA_PRESUPUESTO) })).toEqual({});
    expect(validarDatosPresupuesto({ ...ok, nota: "n".repeat(MAX_NOTA_PRESUPUESTO + 1) })).toEqual({
      nota: "La nota admite hasta 280 caracteres.",
    });
  });

  it("los topes son 80 y 280", () => {
    expect(MAX_NOMBRE_CLIENTE).toBe(80);
    expect(MAX_NOTA_PRESUPUESTO).toBe(280);
  });
});

describe("separarNombreContacto", () => {
  it("null o vacío dan ambos campos vacíos", () => {
    expect(separarNombreContacto(null)).toEqual({ nombre: "", apellido: "" });
    expect(separarNombreContacto("   ")).toEqual({ nombre: "", apellido: "" });
  });

  it("una palabra es el nombre y el apellido queda vacío", () => {
    expect(separarNombreContacto("María")).toEqual({ nombre: "María", apellido: "" });
  });

  it("dos palabras: nombre y apellido", () => {
    expect(separarNombreContacto("María Pérez")).toEqual({ nombre: "María", apellido: "Pérez" });
  });

  it("tres palabras: la primera es el nombre y el resto el apellido", () => {
    expect(separarNombreContacto("María José Pérez")).toEqual({ nombre: "María", apellido: "José Pérez" });
  });

  it("colapsa los espacios repetidos y los de los bordes", () => {
    expect(separarNombreContacto("  María   José \t Pérez  ")).toEqual({ nombre: "María", apellido: "José Pérez" });
  });
});

describe("nombreCompletoPresupuesto", () => {
  it("une nombre y apellido", () => {
    expect(nombreCompletoPresupuesto({ clienteNombre: "María", clienteApellido: "Pérez" })).toBe("María Pérez");
  });

  it("sin apellido no deja un espacio colgando", () => {
    expect(nombreCompletoPresupuesto({ clienteNombre: "María", clienteApellido: "" })).toBe("María");
  });
});

describe("filtrarPresupuestos", () => {
  const maria = presupuesto({ id: "1", clienteNombre: "María", clienteApellido: "Pérez", createdBy: "a1" });
  const jose = presupuesto({ id: "2", clienteNombre: "José Luis", clienteApellido: "Rodríguez", createdBy: "a2" });
  const lista = [maria, jose];

  it("sin texto ni autor devuelve todo", () => {
    expect(filtrarPresupuestos(lista, { texto: "", soloDe: null })).toEqual(lista);
    expect(filtrarPresupuestos(lista, { texto: "   ", soloDe: null })).toEqual(lista);
  });

  it("ignora acentos y mayúsculas, en el sentido que sea", () => {
    expect(filtrarPresupuestos(lista, { texto: "maria", soloDe: null }).map((p) => p.id)).toEqual(["1"]);
    expect(filtrarPresupuestos(lista, { texto: "PÉREZ", soloDe: null }).map((p) => p.id)).toEqual(["1"]);
    expect(filtrarPresupuestos(lista, { texto: "rodriguez", soloDe: null }).map((p) => p.id)).toEqual(["2"]);
    expect(filtrarPresupuestos(lista, { texto: "jose", soloDe: null }).map((p) => p.id)).toEqual(["2"]);
  });

  it("todas las palabras deben aparecer, en cualquier orden, sobre «nombre apellido»", () => {
    expect(filtrarPresupuestos(lista, { texto: "luis jose", soloDe: null }).map((p) => p.id)).toEqual(["2"]);
    expect(filtrarPresupuestos(lista, { texto: "maria rodriguez", soloDe: null })).toEqual([]);
  });

  it("soloDe deja únicamente los de ese autor, y se combina con el texto", () => {
    expect(filtrarPresupuestos(lista, { texto: "", soloDe: "a2" }).map((p) => p.id)).toEqual(["2"]);
    expect(filtrarPresupuestos(lista, { texto: "maria", soloDe: "a2" })).toEqual([]);
  });

  it("no muta la lista recibida", () => {
    const copia = [...lista];
    filtrarPresupuestos(lista, { texto: "maria", soloDe: null });
    expect(lista).toEqual(copia);
  });
});

describe("puedeEditarPresupuesto", () => {
  const p = { createdBy: "agente-1" };

  it("el dueño puede, sea cual sea su rol", () => {
    expect(puedeEditarPresupuesto(p, { id: "agente-1", role: "agent" })).toBe(true);
    expect(puedeEditarPresupuesto(p, { id: "agente-1", role: "caja" })).toBe(true);
  });

  it("un supervisor o admin puede aunque sea ajeno", () => {
    expect(puedeEditarPresupuesto(p, { id: "otro", role: "supervisor" })).toBe(true);
    expect(puedeEditarPresupuesto(p, { id: "otro", role: "admin" })).toBe(true);
  });

  it("otro asesor, o la caja, no puede cambiar uno ajeno", () => {
    expect(puedeEditarPresupuesto(p, { id: "otro", role: "agent" })).toBe(false);
    expect(puedeEditarPresupuesto(p, { id: "otro", role: "caja" })).toBe(false);
  });

  it("un presupuesto sin autor (el asesor se fue) solo lo cambia un supervisor o admin", () => {
    const huerfano = { createdBy: null };
    expect(puedeEditarPresupuesto(huerfano, { id: "otro", role: "agent" })).toBe(false);
    expect(puedeEditarPresupuesto(huerfano, { id: "otro", role: "supervisor" })).toBe(true);
  });
});

describe("renglonesParaGuardar", () => {
  it("toma product_id, cantidad, a qué precio se cobra y el precio vigente como referencia", () => {
    const lineas = priceCartLines(
      [
        { product: product({ id: "a", price: 25, shippingFeeUsd: 2.5 }), quantity: 2, quotedPriceUsd: null, priceKind: "estandar" as const },
        { product: product({ id: "b", price: 10 }), quantity: 1, quotedPriceUsd: null, priceKind: "promocion" as const },
      ],
      40,
    );
    expect(renglonesParaGuardar(lineas)).toEqual([
      { product_id: "a", quantity: 2, price_kind: "estandar", precio_cotizado_usd: 27.5 },
      { product_id: "b", quantity: 1, price_kind: "promocion", precio_cotizado_usd: 10 },
    ]);
  });

  it("un renglón sin precio guarda null (no se inventa un número); sin priceKind es promoción", () => {
    const lineas = priceCartLines(
      [{ product: product({ id: "v", currency: "VES", price: 101 }), quantity: 1, quotedPriceUsd: null }],
      0,
    );
    expect(renglonesParaGuardar(lineas)).toEqual([
      { product_id: "v", quantity: 1, price_kind: "promocion", precio_cotizado_usd: null },
    ]);
  });
});

describe("lineasDePresupuesto", () => {
  it("arma las líneas del carrito con el precio cotizado solo como referencia", () => {
    const p = presupuesto({
      items: [
        renglon({ id: "i1", product: product({ id: "a" }), quantity: 3, priceKind: "estandar", precioCotizadoUsd: 27.5 }),
        renglon({ id: "i2", product: product({ id: "b" }), quantity: 1, priceKind: "promocion", precioCotizadoUsd: null }),
      ],
    });
    const lineas = lineasDePresupuesto(p);
    expect(lineas.map((l) => [l.product.id, l.quantity, l.priceKind, l.quotedPriceUsd])).toEqual([
      ["a", 3, "estandar", 27.5],
      ["b", 1, "promocion", null],
    ]);
  });

  it("D1: reabrir cobra el precio de HOY, no el cotizado", () => {
    const p = presupuesto({ items: [renglon({ product: product({ price: 30 }), precioCotizadoUsd: 20 })] });
    const [linea] = priceCartLines(lineasDePresupuesto(p), 40);
    expect(linea.unitPriceUsd).toBe(30);
  });
});

describe("comparacionTotal", () => {
  it("devuelve cotizado y hoy cuando el total cambió", () => {
    const p = presupuesto({ totalCotizadoUsd: 20, items: [renglon({ product: product({ price: 30 }) })] });
    expect(comparacionTotal(p, 40)).toEqual({ cotizadoUsd: 20, hoyUsd: 30 });
  });

  it("es null si no cambió o la diferencia es menor a medio centavo", () => {
    expect(comparacionTotal(presupuesto(), 40)).toBeNull();
    const casi = presupuesto({ totalCotizadoUsd: 20.004 });
    expect(comparacionTotal(casi, 40)).toBeNull();
    const sube = presupuesto({ totalCotizadoUsd: 20.01 });
    expect(comparacionTotal(sube, 40)).toEqual({ cotizadoUsd: 20.01, hoyUsd: 20 });
  });

  it("es null si el presupuesto se guardó sin total", () => {
    expect(comparacionTotal(presupuesto({ totalCotizadoUsd: null }), 40)).toBeNull();
  });

  it("es null si hoy algún renglón no tiene precio (falta la tasa o la tarifa)", () => {
    const enBs = presupuesto({
      totalCotizadoUsd: 2.6,
      items: [renglon({ product: product({ currency: "VES", price: 101 }) })],
    });
    expect(comparacionTotal(enBs, 0)).toBeNull();
    expect(comparacionTotal(enBs, 40)).toBeNull(); // 101 Bs / 40 = $2,60: no cambió
    const sinTarifa = presupuesto({ items: [renglon({ priceKind: "estandar" })] });
    expect(comparacionTotal(sinTarifa, 40)).toBeNull();
  });

  it("multiplica por la cantidad", () => {
    const p = presupuesto({
      totalCotizadoUsd: 40,
      items: [renglon({ product: product({ price: 25 }), quantity: 2 })],
    });
    expect(comparacionTotal(p, 40)).toEqual({ cotizadoUsd: 40, hoyUsd: 50 });
  });
});

describe("etiquetaComparacion", () => {
  it("usa el mismo formato $X.YY del resumen", () => {
    expect(etiquetaComparacion({ cotizadoUsd: 84.9 })).toBe("cotizado $84.90");
    expect(etiquetaComparacion({ cotizadoUsd: 7 })).toBe("cotizado $7.00");
  });
});
