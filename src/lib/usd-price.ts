/**
 * Conversión de bolívares a dólares, redondeada a favor del negocio.
 *
 * Pedido del cliente (27/9/2026, plan "El mostrador busca sin salir del
 * chat", D1): hasta esta fecha la conversión Bs -> USD se hacía con
 * `Number((bs / rate).toFixed(2))` en TRES sitios distintos (la pantalla de
 * Inventario, el carrito del cierre de venta y la herramienta de catálogo de
 * Seba), y `toFixed` redondea al centavo más CERCANO -- a veces para abajo,
 * regalando centavos en cada venta convertida. La regla nueva redondea
 * SIEMPRE hacia ARRIBA, al siguiente múltiplo de $0,10: nunca se le menciona
 * al cliente, es una decisión comercial, no una corrección de un error.
 *
 * D2 acota dónde aplica: solo a un precio que se está CONVIRTIENDO de
 * bolívares (el precio real, el de Saint) a dólares con la tasa BCV. Un
 * producto cuya moneda ya es USD en `products` se muestra tal cual, sin
 * pasar por acá. El precio en bolívares tampoco se toca nunca.
 *
 * D3: una sola función para los tres consumidores (`inventory.ts`,
 * `sale-cart.ts`, `ai/tools.ts`) para que "a favor del negocio" sea UNA
 * decisión, no tres copias que puedan divergir.
 */

/**
 * `bs / rate` redondeado hacia arriba al siguiente múltiplo de $0,10.
 *
 * `null` si no hay tasa con la que convertir (`rate <= 0` o no finita) o si
 * `bs` no es un número finito -- nunca se inventa un precio.
 *
 * El redondeo se hace en DÉCIMAS (`Math.ceil(x * 10 - EPSILON) / 10`) para
 * protegerlo del ruido de coma flotante: un valor que matemáticamente es
 * exacto (2,10 / 1,40 = 1,5) puede guardarse como 1,5000000000000002 por
 * cómo la máquina representa los decimales, y sin el epsilon ese ruido
 * empujaría el resultado al siguiente múltiplo (1,60) aunque no debería
 * subir. El epsilon es chico a propósito -- alcanza para absorber el ruido
 * de doble precisión sin perdonarle nada a una diferencia real (2,601 sí
 * sube a 2,70).
 */
export function usdFromBs(bs: number, rate: number): number | null {
  if (!Number.isFinite(bs) || !Number.isFinite(rate) || rate <= 0) return null;

  const EPSILON = 1e-9;
  const sinRedondear = bs / rate;
  const redondeado = Math.ceil(sinRedondear * 10 - EPSILON) / 10;
  return Number(redondeado.toFixed(2));
}
