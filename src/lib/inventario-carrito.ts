import type { CartPriceKind, Product } from "@/lib/types";
import {
  cartSummaryText,
  cartTotals,
  priceCartLines,
  type PricedCartLine,
} from "@/lib/conversation-cart";
import { OPCIONES_COPIA_INICIALES, type OpcionesCopia } from "@/lib/copia-carrito";
import { motivoSinEstandar, standardPriceDisplay } from "@/lib/inventory";
import {
  bsDeCents,
  calcularCashea,
  lineaInicial,
  lineaResto,
  toCents,
  type EleccionCashea,
  type PlanCashea,
} from "@/lib/cashea";

/**
 * Carrito de cotización del Inventario (12/10/2026, plan "Carrito de
 * cotización en el Inventario, con Cashea").
 *
 * El asesor arma una cotización suelta en /inventario, sin cliente ni
 * conversación. Este módulo es PURO (sin React ni Supabase): el reducer, la
 * (de)serialización para localStorage, los totales con el plan Cashea
 * opcional, los avisos por renglón y el texto para WhatsApp.
 *
 * D6 (igual que el carrito de una conversación, `conversation-cart.ts`): en
 * localStorage se guarda SOLO `[{productId, quantity, priceKind}]`. El precio
 * no se guarda nunca; sale de `products` + tasa BCV en el momento de mirar, así
 * que una cotización armada ayer se ve al precio de hoy. `quotedPriceUsd` es
 * `null` en el carrito armado a mano; solo trae valor cuando el carrito viene
 * de reabrir un presupuesto guardado (21/10/2026, `lineasDePresupuesto`), y
 * entonces es referencia, nunca se cobra (D1). Existe para cumplir
 * `PriceableCartItem` y reutilizar `priceCartLines`/`cartTotals`/
 * `cartSummaryText` sin copiarlos.
 *
 * 21/10/2026 ("Presupuestos y mensajes rápidos", T3): cada renglón lleva su
 * `priceKind` (promoción o estándar, como el carrito del chat). Hasta esa
 * fecha este carrito cobraba SIEMPRE la promoción —no había forma de elegir—
 * y el asesor que quería cotizar con el envío MRW incluido tenía que sumarlo a
 * mano. Un JSON guardado antes de esa fecha no trae `priceKind` y se lee como
 * promoción, que es lo que ese carrito cobraba.
 */

export interface LineaCarritoInventario {
  product: Product;
  quantity: number;
  /** Solo referencia (D1): lo que se cotizó al guardar el presupuesto reabierto; nunca se cobra. */
  quotedPriceUsd: number | null;
  priceKind: CartPriceKind;
}

export type AccionCarrito =
  /** Sin `priceKind` entra a precio de promoción. Si el producto ya estaba, suma 1 y queda a ese precio. */
  | { tipo: "agregar"; product: Product; priceKind?: CartPriceKind }
  /** Cambia el precio de TODOS los renglones a la vez. */
  | { tipo: "precio"; priceKind: CartPriceKind }
  | { tipo: "cantidad"; productId: string; quantity: number }
  | { tipo: "quitar"; productId: string }
  | { tipo: "vaciar" }
  | { tipo: "restaurar"; lineas: LineaCarritoInventario[] };

/** Una cantidad válida es un entero >= 1 (nada de 0, negativos, decimales ni NaN). */
function esCantidadValida(quantity: unknown): quantity is number {
  return typeof quantity === "number" && Number.isInteger(quantity) && quantity >= 1;
}

export function reducirCarrito(
  estado: LineaCarritoInventario[],
  accion: AccionCarrito,
): LineaCarritoInventario[] {
  switch (accion.tipo) {
    case "agregar": {
      const priceKind = accion.priceKind ?? "promocion";
      const existe = estado.some((l) => l.product.id === accion.product.id);
      if (!existe) return [...estado, { product: accion.product, quantity: 1, quotedPriceUsd: null, priceKind }];
      // Se refresca `product` con el recibido: la fila de Inventario que el
      // asesor acaba de tocar es más nueva que la copia que guardó el carrito.
      return estado.map((l) =>
        l.product.id === accion.product.id
          ? { ...l, product: accion.product, quantity: l.quantity + 1, priceKind }
          : l,
      );
    }
    case "precio":
      return estado.map((l) => (l.priceKind === accion.priceKind ? l : { ...l, priceKind: accion.priceKind }));
    case "cantidad": {
      if (!esCantidadValida(accion.quantity)) return estado;
      if (!estado.some((l) => l.product.id === accion.productId)) return estado;
      return estado.map((l) => (l.product.id === accion.productId ? { ...l, quantity: accion.quantity } : l));
    }
    case "quitar":
      return estado.filter((l) => l.product.id !== accion.productId);
    case "vaciar":
      return [];
    case "restaurar": {
      // La lectura de localStorage es asíncrona respecto del primer render: el
      // asesor pudo agregar algo antes de que terminara. Lo del estado manda
      // (es lo más reciente que hizo); las restauradas van primero en su orden
      // y lo que solo estaba en el estado queda después.
      const delEstado = new Map(estado.map((l) => [l.product.id, l]));
      const vistos = new Set<string>();
      const resultado: LineaCarritoInventario[] = [];
      for (const restaurada of accion.lineas) {
        const id = restaurada.product.id;
        if (vistos.has(id)) continue;
        vistos.add(id);
        resultado.push(delEstado.get(id) ?? restaurada);
      }
      for (const l of estado) {
        if (!vistos.has(l.product.id)) resultado.push(l);
      }
      return resultado;
    }
  }
}

export interface GuardadoCarrito {
  productId: string;
  quantity: number;
  priceKind: CartPriceKind;
}

export function serializarCarrito(lineas: LineaCarritoInventario[]): string {
  const guardado: GuardadoCarrito[] = lineas.map((l) => ({
    productId: l.product.id,
    quantity: l.quantity,
    priceKind: l.priceKind,
  }));
  return JSON.stringify(guardado);
}

/** Defensivo: solo «estandar» cobra el envío; ausente o cualquier otra cosa es promoción (lo que cobraba el carrito antes del 21/10/2026). */
function priceKindGuardado(valor: unknown): CartPriceKind {
  return valor === "estandar" ? "estandar" : "promocion";
}

/** A qué precio se cobra el carrito entero: uno común, `"mixto"` si hay de los dos, `null` si está vacío. */
export function precioDelCarrito(lineas: LineaCarritoInventario[]): CartPriceKind | "mixto" | null {
  if (lineas.length === 0) return null;
  const primero = lineas[0].priceKind;
  return lineas.every((l) => l.priceKind === primero) ? primero : "mixto";
}

/**
 * Lo que dejó localStorage, sin fiarse de nada: el valor lo pudo escribir una
 * versión vieja, otra pestaña o el propio navegador. Nunca lanza. Una entrada
 * mala se descarta sola; los ids repetidos se fusionan sumando cantidades (y
 * conservan el `priceKind` de la primera aparición).
 */
export function leerCarritoGuardado(raw: string | null): GuardadoCarrito[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const porId = new Map<string, GuardadoCarrito>();
  for (const entrada of parsed) {
    if (typeof entrada !== "object" || entrada === null) continue;
    const { productId, quantity, priceKind } = entrada as Record<string, unknown>;
    if (typeof productId !== "string" || productId === "") continue;
    if (!esCantidadValida(quantity)) continue;
    const previa = porId.get(productId);
    if (previa) previa.quantity += quantity;
    else porId.set(productId, { productId, quantity, priceKind: priceKindGuardado(priceKind) });
  }
  return [...porId.values()];
}

export interface OpcionesCashea extends EleccionCashea {
  activo: boolean;
}

export interface TotalesCarritoInventario {
  /** Los renglones ya con precio, para que la pantalla no vuelva a calcular. */
  lineas: PricedCartLine<LineaCarritoInventario>[];
  usd: number;
  bs: number | null;
  unpricedCount: number;
  unidades: number;
  renglones: number;
  /** `null` si Cashea está apagado, si no hay renglones o si algún renglón no tiene precio en dólares. */
  cashea: PlanCashea | null;
  inicialBs: number | null;
  cuotaBs: number | null;
}

export function totalesCarrito(
  lineas: LineaCarritoInventario[],
  bcvRate: number,
  cashea: OpcionesCashea,
): TotalesCarritoInventario {
  const priced = priceCartLines(lineas, bcvRate);
  // El total en dólares SUMA los dólares ya redondeados por renglón
  // (`usdFromBs`, hacia arriba al décimo): jamás se convierte el total en
  // bolívares, que regalaría los décimos que el redondeo cobra.
  const { usd, bs, unpricedCount } = cartTotals(priced);

  // Con un renglón sin precio el total en dólares es falso (le falta ese
  // renglón): financiar sobre él engañaría al cliente, así que no hay plan.
  const hayPlan = cashea.activo && lineas.length > 0 && unpricedCount === 0;
  const plan = hayPlan
    ? calcularCashea({
        montoCents: toCents(usd),
        nivel: cashea.nivel,
        cuotas: cashea.cuotas,
        bajada: cashea.bajada,
      })
    : null;

  return {
    lineas: priced,
    usd,
    bs,
    unpricedCount,
    unidades: lineas.reduce((suma, l) => suma + l.quantity, 0),
    renglones: lineas.length,
    cashea: plan,
    inicialBs: plan ? bsDeCents(plan.inicialCents, bcvRate) : null,
    cuotaBs: plan ? bsDeCents(plan.cuotaCents, bcvRate) : null,
  };
}

/**
 * Avisos de un renglón, en este orden: baja de Saint, sin stock, stock
 * insuficiente, sin precio. Un estándar sin tarifa MRW dice POR QUÉ (sin peso,
 * fuera de la tabla, sin rango) con el mismo texto de la fila del Inventario
 * (`motivoSinEstandar`); si la tarifa existe y lo que falta es la tasa (un
 * producto en bolívares), sigue el aviso de siempre.
 */
export function avisosRenglon(linea: PricedCartLine<LineaCarritoInventario>): string[] {
  const { product, quantity } = linea.item;
  const avisos: string[] = [];
  if (!product.isActive) avisos.push("Saint lo dio de baja");
  if (product.stockQuantity <= 0) avisos.push("Sin stock");
  else if (product.stockQuantity < quantity) avisos.push(`Solo hay ${product.stockQuantity}`);
  if (linea.unitPriceUsd === null) {
    // `estado` depende solo del peso y la tarifa cuando no hay tarifa: la tasa no entra.
    const estandar = linea.item.priceKind === "estandar" ? standardPriceDisplay(product, 0) : null;
    if (estandar && estandar.estado !== "ok") {
      avisos.push(`Sin precio estándar: ${motivoSinEstandar(estandar.estado)}`);
    } else {
      avisos.push("Sin precio (falta la tasa)");
    }
  }
  return avisos;
}

/**
 * El texto para pegar en WhatsApp: el resumen del carrito de una conversación
 * (`cartSummaryText`, mismo formato que ya conocen los clientes, con el total
 * en bolívares incluido) y, si hay plan, el financiamiento Cashea con las
 * mismas líneas que la calculadora (`lineaInicial`/`lineaResto`). Sin saludo:
 * el asesor lo escribe él. `null` con carrito vacío o con algún renglón sin
 * precio que una casilla encendida necesite.
 *
 * 21/10/2026: `opciones` son las casillas de «qué incluir al copiar»
 * (`copia-carrito.ts`). El total en bolívares ya no se agrega acá —viene de
 * `cartSummaryText`— y el plan Cashea sale solo con `planCashea` encendida.
 * `totales.cashea` ya es `null` cuando algún renglón no tiene precio, así que
 * el plan nunca se agrega sobre un total falso.
 */
export function textoCarritoParaCliente(
  totales: TotalesCarritoInventario,
  opciones: OpcionesCopia = OPCIONES_COPIA_INICIALES,
): string | null {
  const base = cartSummaryText(
    totales.lineas,
    { usd: totales.usd, bs: totales.bs, unpricedCount: totales.unpricedCount },
    opciones,
  );
  if (base === null) return null;

  let texto = base;
  if (opciones.planCashea && totales.cashea) {
    const plan = totales.cashea;
    texto += `\n\nFinanciado con Cashea (nivel ${plan.nivel}):\n${lineaInicial(plan)}\n${lineaResto(plan)}`;
  }
  return texto;
}
