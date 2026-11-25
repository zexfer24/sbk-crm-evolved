/**
 * D1 (21/11/2026): desde el 11/11 ningún envío de mostrador pasa por «Enviar a
 * SAINT» (los 44 envíos desde el 16/11 son del carrito del chat), así que el
 * canal «tienda» solo puede dar $0. Mientras el mostrador no pase por el CRM,
 * los paneles no lo pintan; volver a mostrarlo es poner `true`, sin migración.
 * Vive en su propio módulo para que los tests puedan fijarlo con `vi.mock`.
 */
export const CANAL_TIENDA_VISIBLE = false;
