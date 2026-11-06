/**
 * Recargo del 16 % sobre todo precio de producto.
 *
 * Pedido del cliente (6/11/2026, hotfix urgente): sumar 16 % a TODOS los
 * precios de producto -- el precio en bolívares de Saint (`products.price`,
 * Precio3), todo lo que se deriva de él ($ BCV, precio estándar, carrito,
 * presupuestos, cotización de Seba, cierre de venta y factura) y el «Precio
 * divisa» (`products.precio_divisa_usd`, PrecioI3, el que usa Cashea).
 *
 * Por qué vive en CÓDIGO y no en `saint.sync_products()`: Saint sigue siendo
 * el dueño del dato y la base sigue siendo igual a Saint (sin migración, y si
 * el cliente da marcha atrás basta con poner la constante en 0). Tocar la
 * sincronización haría que `products.price` dejara de coincidir con Saint y
 * obligaría a un backfill de miles de filas.
 *
 * Hay DOS únicos puntos de entrada por donde el precio de un producto llega a
 * la app, y los dos pasan por acá: `mapProduct` (`inventory-data.ts`, todo lo
 * que ve el asesor) y `cotizar` (`ai/tools.ts`, lo que cotiza Seba desde la
 * RPC `buscar_productos`). Un precio nuevo que entre por otro camino tiene
 * que pasar por estas funciones, o el asesor y Seba volverían a cotizar
 * números distintos.
 *
 * NO lleva recargo la tarifa de envío MRW (`tarifa_envio_usd`): el precio
 * estándar es (producto recargado -> USD) + tarifa tal cual. Y es INVISIBLE:
 * ningún texto de la interfaz, del prompt de Seba ni de la descripción de una
 * herramienta menciona IVA, 16 % ni recargo (mismo criterio que el redondeo de
 * `usd-price.ts`). La factura de Saint no lo trae: el cliente lo sabe.
 */

export const RECARGO_PRECIO = 0.16;

/**
 * Bolívares con el recargo, al céntimo más cercano. Un valor no finito se
 * devuelve tal cual (no se inventa un precio). El `+ 1e-9` absorbe el ruido
 * de coma flotante (1,005 x 1,16 no debe caer un céntimo por 1,1657999...).
 */
export function bsConRecargo(bs: number): number {
  if (!Number.isFinite(bs)) return bs;
  return Math.round(bs * (1 + RECARGO_PRECIO) * 100 + 1e-9) / 100;
}

/**
 * Dólares con el recargo, redondeado HACIA ARRIBA al siguiente múltiplo de
 * $0,10 (la misma regla y el mismo epsilon que `usdFromBs`, `usd-price.ts`: un
 * exacto como 5,00 -> 5,80 no sube). Un valor <= 0 o no finito se devuelve tal
 * cual: la interfaz lee <= 0 como «Sin precio en SAINT» y no hay que
 * convertirlo en un precio.
 */
export function usdConRecargo(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return usd;

  const EPSILON = 1e-9;
  const redondeado = Math.ceil(usd * (1 + RECARGO_PRECIO) * 10 - EPSILON) / 10;
  return Number(redondeado.toFixed(2));
}
