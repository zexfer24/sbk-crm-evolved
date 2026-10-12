import type { Product } from "@/lib/types";
import {
  cartSummaryText,
  cartTotals,
  priceCartLines,
  type PricedCartLine,
} from "@/lib/conversation-cart";
import {
  bsDeCents,
  calcularCashea,
  formatBs,
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
 * localStorage se guarda SOLO `[{productId, quantity}]`. El precio no se
 * guarda nunca; sale de `products` + tasa BCV en el momento de mirar, así que
 * una cotización armada ayer se ve al precio de hoy. Por eso `quotedPriceUsd`
 * es siempre `null` aquí: existe solo para cumplir `PriceableCartItem` y
 * reutilizar `priceCartLines`/`cartTotals`/`cartSummaryText` sin copiarlos.
 */

export interface LineaCarritoInventario {
  product: Product;
  quantity: number;
  quotedPriceUsd: null;
}

export type AccionCarrito =
  | { tipo: "agregar"; product: Product }
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
      const existe = estado.some((l) => l.product.id === accion.product.id);
      if (!existe) return [...estado, { product: accion.product, quantity: 1, quotedPriceUsd: null }];
      // Se refresca `product` con el recibido: la fila de Inventario que el
      // asesor acaba de tocar es más nueva que la copia que guardó el carrito.
      return estado.map((l) =>
        l.product.id === accion.product.id ? { ...l, product: accion.product, quantity: l.quantity + 1 } : l,
      );
    }
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
}

export function serializarCarrito(lineas: LineaCarritoInventario[]): string {
  const guardado: GuardadoCarrito[] = lineas.map((l) => ({ productId: l.product.id, quantity: l.quantity }));
  return JSON.stringify(guardado);
}

/**
 * Lo que dejó localStorage, sin fiarse de nada: el valor lo pudo escribir una
 * versión vieja, otra pestaña o el propio navegador. Nunca lanza. Una entrada
 * mala se descarta sola; los ids repetidos se fusionan sumando cantidades.
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
    const { productId, quantity } = entrada as Record<string, unknown>;
    if (typeof productId !== "string" || productId === "") continue;
    if (!esCantidadValida(quantity)) continue;
    const previa = porId.get(productId);
    if (previa) previa.quantity += quantity;
    else porId.set(productId, { productId, quantity });
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

/** Avisos de un renglón, en este orden: baja de Saint, sin stock, stock insuficiente, sin precio. */
export function avisosRenglon(linea: PricedCartLine<LineaCarritoInventario>): string[] {
  const { product, quantity } = linea.item;
  const avisos: string[] = [];
  if (!product.isActive) avisos.push("Saint lo dio de baja");
  if (product.stockQuantity <= 0) avisos.push("Sin stock");
  else if (product.stockQuantity < quantity) avisos.push(`Solo hay ${product.stockQuantity}`);
  if (linea.unitPriceUsd === null) avisos.push("Sin precio (falta la tasa)");
  return avisos;
}

/**
 * El texto para pegar en WhatsApp: el resumen del carrito de una conversación
 * (`cartSummaryText`, mismo formato que ya conocen los clientes) más el total
 * en bolívares y, si hay plan, el financiamiento Cashea con las mismas líneas
 * que la calculadora (`lineaInicial`/`lineaResto`). Sin saludo: el asesor lo
 * escribe él. `null` con carrito vacío o con algún renglón sin precio.
 */
export function textoCarritoParaCliente(totales: TotalesCarritoInventario): string | null {
  const base = cartSummaryText(totales.lineas, {
    usd: totales.usd,
    bs: totales.bs,
    unpricedCount: totales.unpricedCount,
  });
  if (base === null) return null;

  let texto = base;
  if (totales.bs !== null) texto += `\nTotal en bolívares: ${formatBs(totales.bs)}`;
  if (totales.cashea) {
    const plan = totales.cashea;
    texto += `\n\nFinanciado con Cashea (nivel ${plan.nivel}):\n${lineaInicial(plan)}\n${lineaResto(plan)}`;
  }
  return texto;
}
