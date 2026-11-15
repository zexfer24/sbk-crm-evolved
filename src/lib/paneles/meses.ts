/**
 * La regla compartida de «Mes a mes» (plan "Paneles", 15/11/2026): Analíticas y
 * el Tablero de ingresos del Dashboard parten del primer mes con algún envío.
 *
 * Los envíos a SAINT se registran desde el 26/10/2026: enero a septiembre no
 * tienen registro y pintados como $0,00 parecían «no vendimos nada». Un mes
 * vacío DESPUÉS del primero con envíos sí se conserva (ahí hay registro y el
 * cero es verdad). Sin ningún envío en el año, lista vacía. Vivía en
 * `analiticas/datos.ts`; se movió aquí para que el Dashboard la reuse.
 */
export function mesesDesdeElPrimerEnvio<T extends { online: number; tienda: number; envios: number }>(meses: T[]): T[] {
  const primero = meses.findIndex((m) => m.envios > 0 || m.online > 0 || m.tienda > 0);
  return primero === -1 ? [] : meses.slice(primero);
}
