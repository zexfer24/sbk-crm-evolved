import { CANAL_TIENDA_VISIBLE } from "./canal-config";
import type { CanalId } from "./parse";

/**
 * Las vistas por canal de los paneles (plan "Paneles", 13/11/2026).
 * "Online" = ventas armadas desde el chat; "En tienda" = ventas del flujo de
 * Inventario (caja); "Resumen" = las dos juntas. El canal de cada venta lo
 * guarda `ventas_saint.canal` al enviarla a SAINT: nunca se recalcula al leer.
 *
 * Desde el 21/11/2026 (D1) el canal "tienda" está oculto mientras el mostrador
 * no pase por el CRM (`CANAL_TIENDA_VISIBLE`, `canal-config.ts`). Con la tienda
 * oculta, "Resumen" sigue siendo el TOTAL de los dos canales —no se pierde
 * ninguna venta— pintado como una sola cifra, sin desglose. Los componentes
 * NUNCA comparan contra la constante por su cuenta: usan las funciones de aquí.
 */
export type Vista = "resumen" | "online" | "tienda";

export { CANAL_TIENDA_VISIBLE };

/** ¿Se pinta el canal «tienda»? Una sola fuente para todos los paneles. */
export function tiendaVisible(): boolean {
  return CANAL_TIENDA_VISIBLE;
}

/** Los canales que se pintan, en orden. */
export function canalesVisibles(): CanalId[] {
  return CANAL_TIENDA_VISIBLE ? ["online", "tienda"] : ["online"];
}

const TODAS_LAS_VISTAS: { id: Vista; etiqueta: string; contexto: string }[] = [
  { id: "resumen", etiqueta: "Resumen", contexto: "Online y tienda juntos" },
  { id: "online", etiqueta: "Online", contexto: "Ventas armadas desde el chat por los asesores" },
  { id: "tienda", etiqueta: "En tienda", contexto: "Ventas del flujo de Inventario (caja)" },
];

const CONTEXTO_RESUMEN_SIN_TIENDA = "Ventas armadas desde el chat (el mostrador no pasa por el CRM)";

/** Las vistas que se ofrecen: las tres, o solo Resumen y Online con la tienda oculta. */
export const VISTAS: { id: Vista; etiqueta: string; contexto: string }[] = CANAL_TIENDA_VISIBLE
  ? TODAS_LAS_VISTAS
  : [{ ...TODAS_LAS_VISTAS[0], contexto: CONTEXTO_RESUMEN_SIN_TIENDA }, TODAS_LAS_VISTAS[1]];

/**
 * La vista que viene en `?vista=`; cualquier valor desconocido es "resumen" (y
 * `tienda` también mientras el canal está oculto).
 */
export function vistaDesdeParam(valor: string | undefined): Vista {
  return VISTAS.find((v) => v.id === valor)?.id ?? "resumen";
}

/**
 * Cuántos envíos de tienda hay que avisar que el total ya incluye: con el
 * canal oculto, los que trae el período; con el canal visible, ninguno (se ven
 * en su propio desglose).
 */
export function enviosDeTiendaOcultos(envios: number): number {
  return CANAL_TIENDA_VISIBLE ? 0 : envios;
}

/** El texto del chip de alerta de envíos de tienda dentro del total. */
export function textoTiendaOculta(n: number): string {
  return n === 1
    ? "1 envío de tienda incluido en el total (el canal está oculto)"
    : `${n} envíos de tienda incluidos en el total (el canal está oculto)`;
}
