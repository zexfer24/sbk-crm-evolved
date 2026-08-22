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
