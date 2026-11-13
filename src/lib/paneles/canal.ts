/**
 * Las tres vistas por canal de los paneles (plan "Paneles", 13/11/2026).
 * "Online" = ventas armadas desde el chat; "En tienda" = ventas del flujo de
 * Inventario (caja); "Resumen" = las dos juntas. El canal de cada venta lo
 * guarda `ventas_saint.canal` al enviarla a SAINT: nunca se recalcula al leer.
 */
export type Vista = "resumen" | "online" | "tienda";

export const VISTAS: { id: Vista; etiqueta: string; contexto: string }[] = [
  { id: "resumen", etiqueta: "Resumen", contexto: "Online y tienda juntos" },
  { id: "online", etiqueta: "Online", contexto: "Ventas armadas desde el chat por los asesores" },
  { id: "tienda", etiqueta: "En tienda", contexto: "Ventas del flujo de Inventario (caja)" },
];
