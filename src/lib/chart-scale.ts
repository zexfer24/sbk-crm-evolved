/**
 * Valores donde van las líneas de referencia de un gráfico: base, mitad y
 * tope.
 *
 * La mitad se redondea porque las etiquetas del eje no muestran decimales, y
 * el resultado se deduplica: con picos muy chicos —el caso de un gráfico sin
 * datos, donde el pico cae a 1— la mitad redondeada coincide con el tope y
 * el eje terminaba mostrando la misma etiqueta dos veces.
 */
export function gridValuesFor(peak: number): number[] {
  return [...new Set([0, Math.round(peak / 2), peak])];
}

/**
 * Ancho aproximado de un carácter de los rótulos de los ejes: fuente mono
 * (Geist Mono) de 11 px, 0,6 em de avance = 6,6 px, más un margen de seguridad.
 */
const ANCHO_CARACTER_EJE = 6.8;

/**
 * Ancho estimado en píxeles de un rótulo de eje (15/11/2026). Los gráficos
 * dibujan en píxeles reales y no pueden medir el texto en el servidor ni en
 * jsdom: como la fuente es monoespaciada, contar caracteres alcanza.
 */
export function anchoDeEtiqueta(texto: string): number {
  return texto.length * ANCHO_CARACTER_EJE;
}

/**
 * Cada cuántos puntos va un rótulo del eje X para que no se encimen: la
 * `separacion` es la distancia en píxeles entre dos puntos (o bandas)
 * consecutivos y `anchoEtiqueta` el del rótulo más ancho. Con la separación
 * inválida (0, negativa, NaN) devuelve 1: mejor mostrar todos que ninguno.
 */
export function pasoDeEtiquetas(separacion: number, anchoEtiqueta: number, hueco = 10): number {
  if (!Number.isFinite(separacion) || separacion <= 0) return 1;
  return Math.max(1, Math.ceil((anchoEtiqueta + hueco) / separacion));
}
