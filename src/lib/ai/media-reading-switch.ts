/**
 * Interruptor de emergencia de la lectura de fotos y audios (plan "Seba lee
 * fotos y audios", 16/11/2026).
 *
 * `AI_MEDIA_READING=off` apaga la lectura entera: el webhook no escribe filas
 * en `message_readings` ni llama al proveedor, y el turno no espera lecturas
 * que nunca van a llegar. Cualquier otro valor (o la variable ausente) la deja
 * encendida.
 *
 * Vive en un archivo propio, sin imports, porque lo consultan dos caminos que
 * no deben arrastrarse entre sí: el webhook (`media-reading-store.ts`) y el
 * turno del agente (`wait-readings.ts`).
 *
 * NO depende de `ai_globally_enabled`, a propósito (decisión D-M1): la lectura
 * también le sirve al asesor en el panel, con Seba apagada.
 */
export function lecturaDeMediaActiva(): boolean {
  return process.env.AI_MEDIA_READING?.trim().toLowerCase() !== "off";
}
