import { cartTotals, priceCartLines, type PricedCartLine } from "@/lib/conversation-cart";
import { standardPriceAmounts } from "@/lib/inventory";
import { formatQuote } from "@/lib/ai/precio";
import type { PaymentMethodConfig } from "@/lib/payment-methods";
import type { CartPriceKind, Product } from "@/lib/types";
import type { Entrega } from "./tipos";
import {
  ENCABEZADO_PEDIDO,
  ETIQUETA_TOTAL,
  ETIQUETA_TOTAL_CON_ENVIO,
  LINEA_ASESOR_BINANCE,
  LINEA_ENVIO_GRATIS_CASHEA,
  LINEA_PEDIR_COMPROBANTE,
} from "./textos";

/**
 * El pedido de Seba v2 (S5, entrega 3 del rework, 17/11/2026): el CÓDIGO arma el
 * total y decide si le entrega al cliente los datos de pago o le pasa el caso a
 * ventas. El modelo no escribe ni una cifra.
 *
 * Los montos salen de las MISMAS funciones que usa el carrito del asesor
 * (`priceCartLines` + `cartTotals`, y detrás de ellas `usdFromBs` y
 * `standardPriceAmounts`): lo que Seba cobra tiene que coincidir con lo que el
 * asesor ve en el panel al verificar el pedido. Por eso este archivo no
 * convierte, no redondea ni recarga nada por su cuenta; los productos llegan YA
 * con el recargo del 6/11/2026 aplicado por `mapProduct` (`fetchProductsByIds`).
 *
 * Decisiones del operador que gobiernan las reglas (17/11/2026):
 * - D1: con Cashea no se calcula inicial ni cuotas ni se manda enlace; se manda
 *   el resumen, se piden los datos del titular con un texto fijo y el caso pasa
 *   a ventas.
 * - D3: de contado Seba entrega total y datos; si la forma no la entrega Seba
 *   (Binance) el caso pasa a ventas SIN monto, porque el precio en divisa lo
 *   dice un asesor.
 * - D5: en un envío de contado el flete va DENTRO del precio («precio
 *   estándar»); con Cashea el envío es gratis y rige el precio de promoción; sin
 *   peso no hay precio estándar y el caso pasa a ventas.
 *
 * Módulo PURO: sin `server-only`, sin Supabase. Productos, tasa y formas de pago
 * llegan por parámetro.
 */

export interface RenglonDePedido {
  product: Product;
  cantidad: number;
}

export type RazonDePase =
  | "binance_divisa"
  | "sin_precio_estandar"
  | "sin_precio"
  | "sin_tasa"
  | "metodo_no_entregable";

export type RazonDeRechazo =
  | "producto_no_buscado"
  | "sin_existencia"
  | "pedido_vacio"
  | "forma_inactiva"
  | "falta_ciudad"
  | "cantidad_invalida";

export type ResultadoPedido =
  | { tipo: "datos_de_pago"; mensaje: string; totalUsd: number; totalBs: number; priceKind: CartPriceKind }
  | {
      tipo: "cashea";
      mensaje: string;
      totalUsd: number;
      totalBs: number | null;
      faltaParaMinimoUsd: number | null;
      faltaParaSeisCuotasUsd: number | null;
    }
  | { tipo: "pasar_a_ventas"; razon: RazonDePase; mensaje: string; detalle: string }
  | { tipo: "rechazado"; razon: RazonDeRechazo; detalle: string };

export interface EntradaDePedido {
  lineas: RenglonDePedido[];
  /** `"cashea"` o la key de una forma de contado. */
  forma: string;
  entrega: Entrega;
  ciudad: string | null;
  bcvRate: number | null;
  metodos: PaymentMethodConfig[];
  /** Ids que ya se le cotizaron al cliente en esta conversación. */
  yaCotizados: ReadonlySet<string>;
  casheaDatosText: string;
  casheaMinimoUsd: number;
  casheaSeisCuotasDesdeUsd: number;
}

/**
 * Línea neutra de los pases sin monto que no son de Binance (sin tasa, sin peso,
 * sin precio): no promete una cifra ni una hora. Vive aquí y no en `textos.ts`
 * porque esa tarea es de otra mano; si se unifican los textos, se mueve allí.
 */
export const LINEA_ASESOR_CONFIRMA_TOTAL = "Un asesor te confirma el total por este mismo chat.";

const CANTIDAD_MIN = 1;
const CANTIDAD_MAX = 20;

/** Los precios llevan dos decimales: restar sin redondear deja colas de coma flotante. */
function round2(valor: number): number {
  return Number(valor.toFixed(2));
}

/**
 * «$12,50»: los dólares con el MISMO formato venezolano de `formatQuote`, sin la
 * parte de bolívares. Se saca de `formatQuote` (en vez de repetir el `Intl`) para
 * que un renglón y su total jamás se formateen distinto.
 */
export function formatoUsd(usd: number): string {
  return formatQuote(usd, 0).replace(/ BCV.*$/, "");
}

/**
 * A qué precio se cobra: estándar (promoción + envío MRW) solo con una forma de
 * contado y un envío (D5); en cualquier otro caso, promoción. Con Cashea el
 * envío es gratis, y retiro/delivery no llevan flete.
 */
export function tipoDePrecio(forma: string, entrega: Entrega): CartPriceKind {
  return forma !== "cashea" && entrega === "envio" ? "estandar" : "promocion";
}

function rechazo(razon: RazonDeRechazo, detalle: string): ResultadoPedido {
  return { tipo: "rechazado", razon, detalle };
}

function nombres(renglones: readonly RenglonDePedido[]): string {
  return renglones.map((r) => r.product.name).join(", ");
}

/** Los renglones repetidos del mismo producto se suman; conserva el orden de aparición. */
function fusionar(lineas: readonly RenglonDePedido[]): RenglonDePedido[] {
  const porId = new Map<string, RenglonDePedido>();
  for (const linea of lineas) {
    const previa = porId.get(linea.product.id);
    if (previa) previa.cantidad += linea.cantidad;
    else porId.set(linea.product.id, { product: linea.product, cantidad: linea.cantidad });
  }
  return [...porId.values()];
}

function esCantidadValida(cantidad: number): boolean {
  return Number.isInteger(cantidad) && cantidad >= CANTIDAD_MIN && cantidad <= CANTIDAD_MAX;
}

/** «N × NOMBRE EXACTO», con el precio unitario a continuación si se conoce. */
function renglonesDeMensaje(
  renglones: readonly RenglonDePedido[],
  precios: readonly PricedCartLine<{ product: Product; quantity: number; quotedPriceUsd: null }>[] | null,
): string[] {
  return renglones.map((r, indice) => {
    const base = `${r.cantidad} × ${r.product.name}`;
    const unitario = precios?.[indice]?.unitPriceUsd;
    return unitario === null || unitario === undefined ? base : `${base} — ${formatoUsd(unitario)} BCV`;
  });
}

/** Resumen SIN montos + una línea de cierre: lo que sale cuando el caso pasa a ventas sin cifras. */
function resumenSinMontos(renglones: readonly RenglonDePedido[], cierre: string): string {
  return [ENCABEZADO_PEDIDO, ...renglonesDeMensaje(renglones, null)].join("\n") + `\n\n${cierre}`;
}

function pasarAVentas(
  razon: RazonDePase,
  renglones: readonly RenglonDePedido[],
  cierre: string,
  detalle: string,
): ResultadoPedido {
  return { tipo: "pasar_a_ventas", razon, mensaje: resumenSinMontos(renglones, cierre), detalle };
}

export function armarPedido(i: EntradaDePedido): ResultadoPedido {
  // 1. Lo que el modelo pide tiene que ser un pedido real.
  if (i.lineas.length === 0) return rechazo("pedido_vacio", "El pedido no tiene productos.");
  if (i.lineas.some((l) => !esCantidadValida(l.cantidad))) {
    return rechazo("cantidad_invalida", `Cada cantidad debe ser un entero de ${CANTIDAD_MIN} a ${CANTIDAD_MAX}.`);
  }
  const renglones = fusionar(i.lineas);
  if (renglones.some((r) => !esCantidadValida(r.cantidad))) {
    return rechazo("cantidad_invalida", `Un mismo producto no puede pasar de ${CANTIDAD_MAX} unidades.`);
  }
  const noBuscados = renglones.filter((r) => !i.yaCotizados.has(r.product.id));
  if (noBuscados.length > 0) return rechazo("producto_no_buscado", nombres(noBuscados));

  // 2. Sin existencia no se vende.
  const agotados = renglones.filter((r) => r.product.stockQuantity <= 0);
  if (agotados.length > 0) return rechazo("sin_existencia", nombres(agotados));

  // 3. Una forma de contado tiene que existir y estar activa; Cashea no es de contado.
  const metodo = i.forma === "cashea" ? null : (i.metodos.find((m) => m.key === i.forma && m.isActive) ?? null);
  if (i.forma !== "cashea" && metodo === null) return rechazo("forma_inactiva", i.forma);

  // 4. Un envío necesita ciudad.
  if (i.entrega === "envio" && (i.ciudad ?? "").trim() === "") {
    return rechazo("falta_ciudad", "El envío necesita la ciudad de destino.");
  }

  // 5-6. Precios: nada se calcula sin tasa, y un renglón sin precio nunca da un total incompleto.
  const priceKind = tipoDePrecio(i.forma, i.entrega);
  const tasa = i.bcvRate;
  if (tasa === null || !(tasa > 0)) {
    return pasarAVentas("sin_tasa", renglones, LINEA_ASESOR_CONFIRMA_TOTAL, "No hay tasa BCV vigente.");
  }

  const comoItems = (kind: CartPriceKind) =>
    renglones.map((r) => ({ product: r.product, quantity: r.cantidad, quotedPriceUsd: null, priceKind: kind }));

  const promocion = priceCartLines(comoItems("promocion"), tasa);
  const sinPrecio = renglones.filter((_, n) => {
    const unitario = promocion[n].unitPriceUsd;
    return unitario === null || !(unitario > 0);
  });
  if (sinPrecio.length > 0) {
    return pasarAVentas("sin_precio", renglones, LINEA_ASESOR_CONFIRMA_TOTAL, nombres(sinPrecio));
  }

  if (priceKind === "estandar") {
    const sinEstandar = renglones.filter((r) => standardPriceAmounts(r.product, tasa) === null);
    if (sinEstandar.length > 0) {
      return pasarAVentas("sin_precio_estandar", renglones, LINEA_ASESOR_CONFIRMA_TOTAL, nombres(sinEstandar));
    }
  }

  const precios = priceKind === "estandar" ? priceCartLines(comoItems("estandar"), tasa) : promocion;
  const totales = cartTotals(precios);
  if (totales.unpricedCount > 0) {
    // Defensivo: tras los chequeos de arriba no debería ocurrir; si ocurre, nunca un total parcial.
    return pasarAVentas("sin_precio", renglones, LINEA_ASESOR_CONFIRMA_TOTAL, "Un renglón quedó sin precio.");
  }
  const lineasDeRenglones = renglonesDeMensaje(renglones, precios);

  // 7. Cashea (D1): resumen a precio de promoción y los datos del titular. Sin inicial, cuotas ni enlace.
  if (i.forma === "cashea") {
    const faltaMinimo = round2(i.casheaMinimoUsd - totales.usd);
    const faltaSeis = round2(i.casheaSeisCuotasDesdeUsd - totales.usd);
    const mensaje = [
      [ENCABEZADO_PEDIDO, ...lineasDeRenglones].join("\n"),
      `${ETIQUETA_TOTAL}: ${formatoUsd(totales.usd)} BCV · ${LINEA_ENVIO_GRATIS_CASHEA}`,
    ].join("\n");
    return {
      tipo: "cashea",
      mensaje: `${mensaje}\n\n${i.casheaDatosText}`,
      totalUsd: totales.usd,
      totalBs: totales.bs,
      faltaParaMinimoUsd: faltaMinimo > 0 ? faltaMinimo : null,
      faltaParaSeisCuotasUsd: faltaSeis > 0 ? faltaSeis : null,
    };
  }

  // 8. Forma de contado que Seba no entrega (Binance, D3): el asesor da el monto en divisa.
  const forma = metodo as PaymentMethodConfig;
  if (!forma.sebaEntrega) {
    return pasarAVentas("binance_divisa", renglones, LINEA_ASESOR_BINANCE, `Pago por ${forma.label}: el asesor da el monto en divisa y los datos.`);
  }

  // 9. Forma de contado que Seba entrega: resumen, total y los datos tal cual están en la base.
  if (forma.instructions.trim() === "") {
    return pasarAVentas("metodo_no_entregable", renglones, LINEA_ASESOR_CONFIRMA_TOTAL, `La forma ${forma.label} no tiene datos cargados.`);
  }
  if (totales.bs === null) {
    return pasarAVentas("sin_tasa", renglones, LINEA_ASESOR_CONFIRMA_TOTAL, "No se pudo expresar el total en bolívares.");
  }
  const etiqueta = priceKind === "estandar" ? ETIQUETA_TOTAL_CON_ENVIO : ETIQUETA_TOTAL;
  const cuerpo = [
    [ENCABEZADO_PEDIDO, ...lineasDeRenglones].join("\n"),
    `${etiqueta}: ${formatQuote(totales.usd, totales.bs)}`,
  ].join("\n");
  return {
    tipo: "datos_de_pago",
    mensaje: `${cuerpo}\n\n${forma.instructions}\n\n${LINEA_PEDIR_COMPROBANTE}`,
    totalUsd: totales.usd,
    totalBs: totales.bs,
    priceKind,
  };
}

/** «N × NOMBRE EXACTO (SAINT código)» para la nota del asesor; sin código, solo «N × NOMBRE». */
export function renglonesParaNota(lineas: RenglonDePedido[]): string[] {
  return fusionar(lineas).map((r) => {
    const codigo = r.product.saintCode?.trim();
    return codigo ? `${r.cantidad} × ${r.product.name} (SAINT ${codigo})` : `${r.cantidad} × ${r.product.name}`;
  });
}
