import type { ConversationQuote, Product, SaleCartItem } from "@/lib/types";
import type { SaleLineItem } from "@/lib/mutations";

/**
 * "Lo que lleva el cliente" mientras el asesor arma la venta.
 *
 * Antes la venta solo podía contener lo que la IA hubiera cotizado en el
 * chat: si el cliente agregaba algo al final —o si nunca pasó por el
 * catálogo— no había forma de cerrarla. Este carrito acepta las dos
 * procedencias, pero mantiene la regla que ya tenía el módulo: **el precio
 * sale siempre del catálogo, nunca se escribe a mano**. Lo que el asesor
 * decide es qué lleva y cuántas unidades.
 *
 * Todo son funciones puras sobre un arreglo: el modal guarda el carrito en
 * estado de React y estas funciones devuelven el siguiente.
 */

/** Dos renglones son el mismo si apuntan al mismo producto del catálogo. */
function sameProduct(item: SaleCartItem, productId: string | null): boolean {
  // Sin producto asociado no hay forma de saber si es el mismo repuesto
  // (son ventas viejas o repuestos descontinuados): se dejan separados.
  return productId !== null && item.productId === productId;
}

function bumpQuantity(cart: SaleCartItem[], index: number): SaleCartItem[] {
  return cart.map((item, i) => (i === index ? { ...item, quantity: item.quantity + 1 } : item));
}

/**
 * Agrega una cotización de la IA.
 *
 * La IA vuelve a cotizar el mismo repuesto cada vez que el cliente pregunta,
 * así que `conversation_quotes` trae varias filas del mismo producto con
 * ids distintos. Sumar unidades es lo correcto; duplicar el renglón sería
 * cobrarle dos veces por preguntar dos veces.
 */
export function addQuoteToCart(cart: SaleCartItem[], quote: ConversationQuote): SaleCartItem[] {
  const existing = cart.findIndex(
    (item) => item.id === quote.id || sameProduct(item, quote.productId)
  );
  if (existing >= 0) return bumpQuantity(cart, existing);

  return [
    ...cart,
    {
      id: quote.id,
      origin: "quote",
      productId: quote.productId,
      description: quote.productName,
      unitPriceUsd: quote.priceUsd,
      quantity: 1,
    },
  ];
}

/**
 * Precio del repuesto en dólares, que es la moneda en la que se guarda la
 * venta. Null si el precio está en bolívares y todavía no hay tasa: meter un
 * cero en la venta sería peor que no dejar agregarlo.
 */
export function productPriceUsd(product: Product, bcvRate: number): number | null {
  if (product.currency === "USD") return product.price;
  if (!bcvRate || bcvRate <= 0) return null;
  return Number((product.price / bcvRate).toFixed(2));
}

/** Agrega un repuesto del inventario que la IA no cotizó. */
export function addProductToCart(cart: SaleCartItem[], product: Product, bcvRate: number): SaleCartItem[] {
  const existing = cart.findIndex((item) => sameProduct(item, product.id));
  // Si ya estaba como cotización, el renglón conserva el precio que se le
  // dijo al cliente: cambiarlo por el de hoy sería cobrarle otra cosa.
  if (existing >= 0) return bumpQuantity(cart, existing);

  const unitPriceUsd = productPriceUsd(product, bcvRate);
  if (unitPriceUsd === null) return cart;

  return [
    ...cart,
    {
      id: product.id,
      origin: "inventory",
      productId: product.id,
      description: product.name,
      unitPriceUsd,
      quantity: 1,
    },
  ];
}

export function removeFromCart(cart: SaleCartItem[], id: string): SaleCartItem[] {
  return cart.filter((item) => item.id !== id);
}

export function setCartQuantity(cart: SaleCartItem[], id: string, quantity: number): SaleCartItem[] {
  return cart.map((item) =>
    item.id === id ? { ...item, quantity: Math.max(1, Math.round(quantity)) } : item
  );
}

export function cartTotalUsd(cart: SaleCartItem[]): number {
  const total = cart.reduce((sum, item) => sum + item.unitPriceUsd * item.quantity, 0);
  // Los precios llevan dos decimales; sumarlos sin redondear deja colas de
  // coma flotante (0.1 * 3 = 0.30000000000000004) que terminan en la orden.
  return Number(total.toFixed(2));
}

export function cartToLineItems(cart: SaleCartItem[]): SaleLineItem[] {
  return cart.map((item) => ({
    id: item.id,
    origin: item.origin,
    productId: item.productId,
    description: item.description,
    unitPrice: item.unitPriceUsd,
    quantity: item.quantity,
  }));
}
