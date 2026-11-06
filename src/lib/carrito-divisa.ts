import type { PriceableCartItem, PricedCartLine } from "@/lib/conversation-cart";

/**
 * Carrito en «precio divisa» (6/11/2026, pedido del cliente).
 *
 * En los dos carritos (el del chat y el del Inventario) hay un interruptor
 * «BCV | Divisa». En Divisa, cada renglón y el total pasan a precio divisa y
 * Copiar / Al chat mandan el texto en divisa. Es SOLO vista + texto copiado:
 * lo que se COBRA y se GUARDA (presupuesto, cierre de venta, SAINT, Seba) sigue
 * en BCV, por eso este módulo no toca `priceCartLines` ni `cartTotals`.
 *
 * Reglas:
 * - La divisa es `product.precioDivisaUsd` (PrecioI3 de SAINT) y YA trae el
 *   recargo del 16 % desde `mapProduct`: aquí no se recarga otra vez. Es precio
 *   válido solo si es finito y > 0 (mismo criterio que `precioDivisaDisplay`).
 * - Renglón estándar = divisa + tarifa MRW (`shippingFeeUsd`, que no pasa por
 *   la tasa ni lleva recargo). Sin divisa o sin tarifa queda SIN precio: nunca
 *   un número incompleto.
 * - No hay bolívares en divisa (`unitPriceBs`/`subtotalBs` en null) ni aviso
 *   «cotizado vs hoy» (`priceChange` null): ese aviso compara contra BCV.
 * - SIN TOTAL PARCIAL (la regla la aplica la UI): `cartTotals(lineasEnDivisa(l))`
 *   da el `usd` de los renglones con divisa, `bs: null` y `unpricedCount` = los
 *   renglones sin divisa; con `unpricedCount > 0` la UI muestra «Falta divisa
 *   (N)» en vez del número, y Copiar / Al chat quedan deshabilitados con
 *   `MOTIVO_COPIA_SIN_DIVISA`.
 *
 * Los imports desde `conversation-cart.ts` son solo de tipos, en los dos
 * sentidos, para no crear un ciclo en runtime.
 */
export type MonedaCarrito = "bcv" | "divisa";

/** Motivo para Copiar/Al chat deshabilitados y para la vista previa en divisa. */
export const MOTIVO_COPIA_SIN_DIVISA = "Hay productos sin precio divisa";

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/** Precio divisa por unidad del renglón, o `null` si falta la divisa (o la tarifa, en estándar). */
export function precioDivisaRenglon(item: PriceableCartItem): number | null {
  const v = item.product.precioDivisaUsd;
  if (v === null || !Number.isFinite(v) || v <= 0) return null;
  if (item.priceKind === "estandar") {
    const tarifa = item.product.shippingFeeUsd;
    return tarifa === null ? null : round2(v + tarifa);
  }
  return round2(v);
}

/** Las mismas líneas repreciadas a divisa. No muta la entrada. */
export function lineasEnDivisa<T extends PriceableCartItem>(lines: PricedCartLine<T>[]): PricedCartLine<T>[] {
  return lines.map((line) => {
    const unitPriceUsd = precioDivisaRenglon(line.item);
    return {
      item: line.item,
      quotedPriceUsd: line.quotedPriceUsd,
      unitPriceUsd,
      subtotalUsd: unitPriceUsd === null ? null : round2(unitPriceUsd * line.item.quantity),
      unitPriceBs: null,
      subtotalBs: null,
      priceChange: null,
    };
  });
}
