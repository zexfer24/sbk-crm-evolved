import type { ConversationCartItem } from "@/lib/types";
import type { SaleLineItem } from "@/lib/mutations";
import { priceInBs } from "@/lib/inventory";
import { productPriceUsd } from "@/lib/sale-cart";

/**
 * Precios y totales del carrito persistente de una conversación (T8, plan
 * "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando",
 * 28/9/2026).
 *
 * D6 (decisión del operador): PRECIO VIGENTE AL FACTURAR. El carrito guarda
 * `product_id` y cantidad; el precio sale de `products` + tasa BCV en el
 * momento de mirarlo y de facturar. Antes (`sale-cart.ts`, el carrito en
 * memoria del modal) una cotización de Seba conservaba "el precio que se le
 * dijo al cliente": eso deja de valer — una cotización de hace tres días se
 * factura al precio de HOY. El precio cotizado sobrevive solo como dato para
 * avisar («cotizado $X · hoy $Y», `quoteComparisonLabel`): informa, no cobra.
 *
 * NO redondea nada por su cuenta. La conversión de bolívares a dólares vive
 * en UNA sola función, `usdFromBs` (`usd-price.ts`), y llega acá a través de
 * `productPriceUsd`; el total en dólares SUMA los dólares ya redondeados por
 * renglón (es lo que termina en `order_items.unit_price`), nunca convierte el
 * total en bolívares — ver `cartTotals`. Todo son funciones puras.
 */

export interface PricedCartLine {
  item: ConversationCartItem;
  /** Precio vigente por unidad, en dólares. `null` si es un producto en bolívares y no hay tasa. */
  unitPriceUsd: number | null;
  /** Precio vigente por unidad, en bolívares. `null` si es un producto en dólares y no hay tasa. */
  unitPriceBs: number | null;
  subtotalUsd: number | null;
  subtotalBs: number | null;
  /** Lo que Seba cotizó (`conversation_quotes.price_usd`), si el renglón vino de una cotización. */
  quotedPriceUsd: number | null;
  /** Solo si el precio cotizado difiere del vigente; `null` si coinciden o no hay con qué comparar. */
  priceChange: { quotedUsd: number; todayUsd: number } | null;
}

export interface CartTotals {
  /** Suma de los subtotales en dólares de los renglones con precio. */
  usd: number;
  /** Suma en bolívares; `null` si algún renglón no se puede expresar en bolívares (falta la tasa). */
  bs: number | null;
  /** Renglones sin precio en dólares: no entran al total y el cierre de venta no debe permitirse con ellos. */
  unpricedCount: number;
}

/** Los precios llevan dos decimales: sumarlos sin redondear deja colas de coma flotante (0.1 * 3). */
function round2(value: number): number {
  return Number(value.toFixed(2));
}

export function priceCartLines(items: ConversationCartItem[], bcvRate: number): PricedCartLine[] {
  return items.map((item) => {
    const unitPriceUsd = productPriceUsd(item.product, bcvRate);
    const unitPriceBs = priceInBs(item.product, bcvRate);
    const quotedPriceUsd = item.quotedPriceUsd;

    const priceChange =
      quotedPriceUsd !== null && unitPriceUsd !== null && Math.abs(quotedPriceUsd - unitPriceUsd) >= 0.005
        ? { quotedUsd: quotedPriceUsd, todayUsd: unitPriceUsd }
        : null;

    return {
      item,
      unitPriceUsd,
      unitPriceBs,
      subtotalUsd: unitPriceUsd === null ? null : round2(unitPriceUsd * item.quantity),
      subtotalBs: unitPriceBs === null ? null : round2(unitPriceBs * item.quantity),
      quotedPriceUsd,
      priceChange,
    };
  });
}

export function cartTotals(lines: PricedCartLine[]): CartTotals {
  let usd = 0;
  let bs: number | null = 0;
  let unpricedCount = 0;

  for (const line of lines) {
    if (line.subtotalUsd === null) unpricedCount += 1;
    else usd += line.subtotalUsd;

    if (line.subtotalBs === null) bs = null;
    else if (bs !== null) bs += line.subtotalBs;
  }

  return { usd: round2(usd), bs: bs === null ? null : round2(bs), unpricedCount };
}

/** «cotizado $18.00 · hoy $20.00» — solo si el precio de hoy no es el que cotizó Seba. */
export function quoteComparisonLabel(line: PricedCartLine): string | null {
  if (!line.priceChange) return null;
  return `cotizado $${line.priceChange.quotedUsd.toFixed(2)} · hoy $${line.priceChange.todayUsd.toFixed(2)}`;
}

/** Dólares con dos decimales y punto, igual que `cart-lines.tsx` los pinta en el panel. */
function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * El resumen del carrito para mandárselo al cliente (T4, plan "Ronda del
 * cliente", 30/9/2026): un bloque por producto —nombre, SKU y precio— y el
 * total al final. Con cantidad mayor que 1 el nombre lleva «(x2)» y el precio
 * dice «$40.00 c/u · $80.00». El SKU es `products.saint_code` (no existe otra
 * columna de código); sin él, «sin código».
 *
 * Devuelve `null` si el carrito está vacío o algún renglón no tiene precio en
 * dólares (falta la tasa BCV): un resumen sin ese renglón daría un total falso
 * y uno con «Sin tasa» escrito no es algo que se le mande a un cliente. Los
 * montos son los VIGENTES (`priceCartLines`, D6), ya redondeados por
 * `usdFromBs`: aquí no se recalcula ni se redondea nada.
 */
export function cartSummaryText(lines: PricedCartLine[], totals: CartTotals): string | null {
  if (lines.length === 0) return null;
  if (lines.some((line) => line.unitPriceUsd === null || line.subtotalUsd === null)) return null;

  const blocks = lines.map((line) => {
    const { product, quantity } = line.item;
    // Los `null` ya se descartaron arriba; el `?? 0` solo calma al tipo.
    const unit = line.unitPriceUsd ?? 0;
    const subtotal = line.subtotalUsd ?? 0;
    const name = quantity > 1 ? `${product.name} (x${quantity})` : product.name;
    const price =
      quantity > 1
        ? `Precio: ${formatUsd(unit)} c/u · ${formatUsd(subtotal)}`
        : `Precio: ${formatUsd(unit)}`;
    return [name, `SKU: ${product.saintCode ?? "sin código"}`, price].join("\n");
  });

  return `${blocks.join("\n\n")}\n\nTotal: ${formatUsd(totals.usd)}`;
}

/**
 * Los renglones de la venta para `closeSaleWithContactInfo`: precio vigente y
 * vínculo con el catálogo por `product_id`. Los renglones sin precio en
 * dólares se dejan fuera — quien llama decide si eso impide cerrar (mira
 * `cartTotals().unpricedCount`); meter un cero en la venta sería peor.
 */
export function cartToSaleLines(lines: PricedCartLine[]): SaleLineItem[] {
  const sale: SaleLineItem[] = [];
  for (const line of lines) {
    if (line.unitPriceUsd === null) continue;
    sale.push({
      id: line.item.id,
      origin: line.item.origin,
      productId: line.item.productId,
      description: line.item.product.name,
      unitPrice: line.unitPriceUsd,
      quantity: line.item.quantity,
    });
  }
  return sale;
}
