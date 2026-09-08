// ---------------------------------------------------------------------------
// Inserción de texto en el caret del compositor (T3b, "Seis frentes del
// buzón", 8/9/2026).
//
// Módulo PURO a propósito, igual que sticker-image.ts: sin DOM, sin
// `textareaRef` de por medio. El emoji picker no sabe nada del cuadro de
// texto del CRM — solo entrega el carácter elegido — y es el compositor
// quien decide dónde cae dentro de lo que el asesor ya escribió. Separarlo
// del componente deja probar la aritmética de índices sin levantar un
// textarea de verdad.
// ---------------------------------------------------------------------------

export interface CaretInsertResult {
  /** El texto completo después de insertar. */
  text: string;
  /** Dónde queda el cursor: justo después de lo insertado. */
  caret: number;
}

/**
 * Inserta `insertion` en el caret de `text`, o la pone en lugar de lo
 * seleccionado si `selectionStart !== selectionEnd`.
 *
 * Los índices se acotan a los límites reales del texto: un `selectionEnd`
 * viejo que sobrevivió a un cambio de contenido (o un caret que nunca se
 * movió, en 0) no debe tirar el compositor ni cortar el texto a la mitad.
 */
export function insertAtCaret(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  insertion: string
): CaretInsertResult {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const nextText = `${text.slice(0, start)}${insertion}${text.slice(end)}`;
  return { text: nextText, caret: start + insertion.length };
}
