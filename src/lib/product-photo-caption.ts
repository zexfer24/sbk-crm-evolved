import type { Product } from "@/lib/types";
import { formatQuote } from "@/lib/ai/precio";
import { priceInBs } from "@/lib/inventory";
import { usdFromBs } from "@/lib/usd-price";

/**
 * Pie de la foto que el asesor manda desde el buscador del chat (30/10/2026,
 * plan «Cada repuesto con su foto», T6, D2): «NOMBRE — $14,10 BCV (Bs. …)», el
 * mismo formato (`formatQuote`) con el que cotiza Seba, para que el cliente
 * lea lo mismo venga de quien venga.
 *
 * El precio es el de PROMOCIÓN, calculado igual que la columna «Promoción» del
 * buscador (`priceDisplay`, `inventory.ts`): un producto en bolívares conserva
 * su precio en Bs y el dólar sale de `usdFromBs` (redondeo hacia arriba a
 * $0,10, a favor del negocio); uno en dólares conserva su precio y los
 * bolívares salen de `priceInBs`. No se inventa otra fórmula.
 *
 * NUNCA dice «envío»: el precio de promoción no lo incluye, y el único precio
 * que lo suma (el estándar MRW) tampoco lo anuncia hacia el cliente (trampa de
 * `cartSummaryText`, CLAUDE.md). Sin tasa (≤ 0) no hay con qué armar el par
 * dólar/bolívar, así que va solo el nombre: mejor un pie corto que una cifra
 * incompleta.
 */
export function productPhotoCaption(product: Product, bcvRate: number): string {
  if (!Number.isFinite(bcvRate) || bcvRate <= 0) return product.name;

  const bs = priceInBs(product, bcvRate);
  const usd = product.currency === "VES" ? usdFromBs(product.price, bcvRate) : product.price;
  if (bs === null || usd === null) return product.name;

  return `${product.name} — ${formatQuote(usd, bs)}`;
}
