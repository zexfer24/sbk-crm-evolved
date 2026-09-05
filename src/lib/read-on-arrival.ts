/**
 * Un chat abierto en una pestaña oculta no puede dar por leído lo que llega:
 * el asesor no lo está mirando, aunque el canal de tiempo real siga corriendo
 * de fondo. Antes del 4/9/2026 (T1.1, "La bandeja que no pierde") el INSERT
 * de `messages` marcaba leído sin preguntar nada — con dos pestañas abiertas
 * (una al frente, esta de fondo con el mismo chat) un mensaje nuevo apagaba
 * la píldora "No leídas" en la pestaña de atrás aunque nadie lo hubiera visto
 * todavía; F5 en la pestaña de adelante lo delataba porque ahí la píldora sí
 * seguía encendida.
 *
 * Las dos señales del navegador que hacen falta para decidir "lo está
 * viendo": `document.visibilityState` (pestaña al frente o no, la que ya usa
 * `use-live-refresh.ts` para no refrescar de fondo) y si la ventana tiene el
 * foco. No alcanza con una sola: una pestaña visible en una ventana sin foco
 * (el asesor mirando otra aplicación con el CRM de fondo, sin haber cambiado
 * de pestaña) tampoco es "lo vio".
 */
export type Presence = {
  visibilityState: DocumentVisibilityState;
  hasFocus: boolean;
};

/**
 * "mark": el mensaje que acaba de llegar se puede dar por leído ya mismo.
 * "defer": hay que anotarlo pendiente y esperar a que el asesor vuelva.
 */
export function decideReadOnArrival({ visibilityState, hasFocus }: Presence): "mark" | "defer" {
  return visibilityState === "visible" && hasFocus ? "mark" : "defer";
}

/**
 * Si conviene soltar ahora lo que quedó pendiente. Solo la visibilidad
 * importa acá: el propio evento que dispara la revisión (`visibilitychange`
 * o `focus`) ya confirma que el foco volvió, no hace falta repreguntarlo.
 */
export function shouldFlushDeferred(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === "visible";
}
