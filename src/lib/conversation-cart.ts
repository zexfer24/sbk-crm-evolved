import type { CartPriceKind, ConversationCartItem } from "@/lib/types";
import type { SaleLineItem } from "@/lib/mutations";
import { priceInBs, standardPriceAmounts } from "@/lib/inventory";
import { productPriceUsd } from "@/lib/sale-cart";
import { formatBs } from "@/lib/cashea";
import { OPCIONES_COPIA_INICIALES, type OpcionesCopia } from "@/lib/copia-carrito";

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
 * 14/10/2026: cada renglón se cobra a PRECIO DE PROMOCIÓN o ESTÁNDAR
 * (promoción + envío MRW por peso), a elección del asesor (`priceKind`). El
 * estándar sigue la misma regla D6: no se guarda ningún monto, se calcula al
 * mirar y al facturar con `standardPriceAmounts` (`inventory.ts`, la única
 * aritmética de la suma). Un renglón estándar cuyo producto no tiene tarifa
 * MRW queda SIN precio —nunca un número incompleto— y por eso bloquea el
 * cierre igual que uno sin tasa. El aviso «cotizado vs hoy» es solo de
 * promoción: Seba cotiza el precio de promoción, comparar contra el estándar
 * mostraría una "diferencia" que es el envío.
 *
 * NO redondea nada por su cuenta. La conversión de bolívares a dólares vive
 * en UNA sola función, `usdFromBs` (`usd-price.ts`), y llega acá a través de
 * `productPriceUsd`; el total en dólares SUMA los dólares ya redondeados por
 * renglón (es lo que termina en `order_items.unit_price`), nunca convierte el
 * total en bolívares — ver `cartTotals`. Todo son funciones puras.
 */

/**
 * Lo mínimo que las reglas de precio necesitan de un renglón. El carrito de
 * una conversación (`ConversationCartItem`) lo cumple, y también el carrito
 * del Inventario (12/10/2026, sin conversación), que usa las mismas reglas
 * sin tener id de conversación ni de renglón.
 */
export type PriceableCartItem = Pick<ConversationCartItem, "product" | "quantity" | "quotedPriceUsd"> & {
  /**
   * Opcional a propósito: el carrito del Inventario (sin conversación) no
   * elige precio y cobra siempre la promoción; ausente = `"promocion"`.
   */
  priceKind?: CartPriceKind;
};

export interface PricedCartLine<T extends PriceableCartItem = ConversationCartItem> {
  item: T;
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

export function priceCartLines<T extends PriceableCartItem>(items: T[], bcvRate: number): PricedCartLine<T>[] {
  return items.map((item) => {
    const estandar = item.priceKind === "estandar";
    // Estándar sin tarifa: `standardPriceAmounts` da null y el renglón queda sin precio.
    const standard = estandar ? standardPriceAmounts(item.product, bcvRate) : null;
    const unitPriceUsd = estandar ? (standard?.usd ?? null) : productPriceUsd(item.product, bcvRate);
    const unitPriceBs = estandar ? (standard?.bs ?? null) : priceInBs(item.product, bcvRate);
    const quotedPriceUsd = item.quotedPriceUsd;

    const priceChange =
      !estandar && quotedPriceUsd !== null && unitPriceUsd !== null && Math.abs(quotedPriceUsd - unitPriceUsd) >= 0.005
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

export function cartTotals(lines: PricedCartLine<PriceableCartItem>[]): CartTotals {
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
export function quoteComparisonLabel(line: PricedCartLine<PriceableCartItem>): string | null {
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
 * 21/10/2026 ("Presupuestos y mensajes rápidos", T3): el rótulo es SIEMPRE
 * «Precio». Hasta esa fecha un renglón de precio estándar decía «Precio
 * (incluye envío)»; el cliente pidió que esa frase no le llegue al comprador
 * (el envío ya va dentro del número, no hace falta nombrarlo). Además cada
 * parte se puede apagar con `opciones` (las casillas de «qué incluir al
 * copiar», `copia-carrito.ts`): código, cantidad, precio unitario, subtotal,
 * total en dólares y total en bolívares. Con todas encendidas el texto es el
 * de siempre más la línea «Total en bolívares», que ahora sale por defecto
 * también desde el chat (antes solo la agregaba el carrito del Inventario).
 * El nombre del producto siempre va.
 *
 * Devuelve `null` si el carrito está vacío o si alguna casilla que depende
 * del precio (unitario, subtotal, total $, total Bs) está encendida y algún
 * renglón no tiene precio en dólares (falta la tasa BCV o la tarifa MRW): un
 * resumen sin ese renglón daría un total falso y uno con «Sin tasa» escrito
 * no es algo que se le mande a un cliente. Con las cuatro apagadas la lista
 * de nombres sale aunque falte algún precio: no se está diciendo ninguno. Los
 * montos son los VIGENTES (`priceCartLines`, D6), ya redondeados por
 * `usdFromBs`: aquí no se recalcula ni se redondea nada.
 */
export function cartSummaryText(
  lines: PricedCartLine<PriceableCartItem>[],
  totals: CartTotals,
  opciones: OpcionesCopia = OPCIONES_COPIA_INICIALES
): string | null {
  if (lines.length === 0) return null;
  const dependeDelPrecio =
    opciones.precioUnitario || opciones.subtotal || opciones.totalUsd || opciones.totalBs;
  if (dependeDelPrecio && lines.some((line) => line.unitPriceUsd === null || line.subtotalUsd === null)) {
    return null;
  }

  const blocks = lines.map((line) => {
    const { product, quantity } = line.item;
    const name = opciones.cantidad && quantity > 1 ? `${product.name} (x${quantity})` : product.name;
    const rows = [name];
    if (opciones.codigo) rows.push(`SKU: ${product.saintCode ?? "sin código"}`);

    // Si una casilla de precio está encendida, los `null` ya se descartaron
    // arriba; el `?? 0` solo calma al tipo.
    const parts: string[] = [];
    if (opciones.precioUnitario) {
      const unit = formatUsd(line.unitPriceUsd ?? 0);
      parts.push(quantity > 1 ? `${unit} c/u` : unit);
    }
    if (opciones.subtotal && (quantity > 1 || !opciones.precioUnitario)) {
      parts.push(formatUsd(line.subtotalUsd ?? 0));
    }
    if (parts.length > 0) rows.push(`Precio: ${parts.join(" · ")}`);
    return rows.join("\n");
  });

  const footer: string[] = [];
  if (opciones.totalUsd) footer.push(`Total: ${formatUsd(totals.usd)}`);
  if (opciones.totalBs && totals.bs !== null) footer.push(`Total en bolívares: ${formatBs(totals.bs)}`);

  const body = blocks.join("\n\n");
  return footer.length > 0 ? `${body}\n\n${footer.join("\n")}` : body;
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
      // Lo que queda en la orden y la factura tiene que decir a qué precio se cobró.
      description:
        line.item.priceKind === "estandar"
          ? `${line.item.product.name} (precio estándar, incluye envío MRW)`
          : line.item.product.name,
      unitPrice: line.unitPriceUsd,
      quantity: line.item.quantity,
    });
  }
  return sale;
}
