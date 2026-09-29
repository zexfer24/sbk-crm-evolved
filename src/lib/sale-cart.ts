import type { Product } from "@/lib/types";
import { usdFromBs } from "@/lib/usd-price";

/**
 * Precio de un repuesto para la venta.
 *
 * Hasta el 28/9/2026 este módulo era el carrito en memoria del modal «Cerrar
 * venta» (`addQuoteToCart`, `addProductToCart`, `setCartQuantity`,
 * `cartTotalUsd`…): una cotización conservaba «el precio que se le dijo al
 * cliente». T8 (plan "Seba encuentra, no insiste, y el mostrador no deja a
 * nadie esperando") movió el carrito a la base (`conversation_cart_items`,
 * `conversation-cart.ts`) y D6 decidió PRECIO VIGENTE AL FACTURAR, así que
 * todo eso se borró — quedaba código muerto que enseñaba la regla contraria.
 * Lo único que sobrevive es `productPriceUsd`, la conversión que el carrito
 * persistente y el buscador siguen usando.
 */

/**
 * Precio del repuesto en dólares, que es la moneda en la que se guarda la
 * venta. Null si el precio está en bolívares y todavía no hay tasa: meter un
 * cero en la venta sería peor que no dejar agregarlo.
 *
 * La conversión de un producto en VES pasa por `usdFromBs` (27/9/2026, plan
 * "El mostrador busca sin salir del chat", D1/D3): redondeada hacia arriba a
 * favor del negocio, igual que en Inventario y en la herramienta de catálogo
 * de Seba, para que la venta cerrada cobre lo mismo que se cotizó en pantalla.
 */
export function productPriceUsd(product: Product, bcvRate: number): number | null {
  if (product.currency === "USD") return product.price;
  return usdFromBs(product.price, bcvRate);
}
