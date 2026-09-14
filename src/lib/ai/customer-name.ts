// ---------------------------------------------------------------------------
// Primer nombre del cliente, para que la IA lo use con naturalidad en el
// turno (Decisión 2 del plan "La voz cercana y la espera visible",
// 14/9/2026). Meta manda el `profile_name` de WhatsApp en cada webhook —lo
// que el cliente puso en su propio perfil, no siempre un nombre real—; un
// asesor puede corregirlo a mano en `contacts.display_name` cuando lo conoce
// mejor. Por eso se prefiere `display_name` sobre `profile_name`.
//
// Módulo PURO (sin `server-only`, sin imports): lo consume `agent.ts` desde
// el servidor, y no hay motivo para que arrastre nada del lado del cliente
// ni de la base — es aritmética de texto, no una consulta.
//
// Decisión (no la traía el plan, se elige la más simple): si `display_name`
// existe pero NO parece un nombre de persona (por ejemplo, un asesor dejó
// ahí el número de teléfono o un apodo raro), se prueba con `profile_name`
// en vez de rendirse — un nombre real de Meta es mejor que ninguno.
// ---------------------------------------------------------------------------

/**
 * Letras del alfabeto español, con acentos y sin dígitos ni símbolos.
 * El rango Unicode À-ÖØ-öø-ÿ es el truco estándar para "letra acentuada
 * Latin-1" sin listar cada vocal: excluye × (U+00D7) y ÷ (U+00F7), que caen
 * justo en los huecos entre los tres tramos.
 */
const NOMBRE_VALIDO = /^[a-zA-ZÀ-ÖØ-öø-ÿ]{2,20}$/;

/** El primer token de `nombre`, o `null` si no parece un nombre de persona. */
function primerTokenValido(nombre: string): string | null {
  const token = nombre.trim().split(/\s+/)[0] ?? "";
  return NOMBRE_VALIDO.test(token) ? token : null;
}

/** "JOSE" → "Jose", "maría" → "María". */
function capitalizar(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * El primer nombre del cliente, listo para el prompt, o `null` si lo que hay
 * guardado no parece un nombre de persona: un teléfono, puros símbolos o
 * emojis, o una sola letra. Prefiere `displayName` sobre `profileName` —ver
 * el comentario de arriba—.
 */
export function customerFirstName(displayName: string | null, profileName: string | null): string | null {
  for (const candidato of [displayName, profileName]) {
    if (!candidato) continue;
    const token = primerTokenValido(candidato);
    if (token) return capitalizar(token);
  }
  return null;
}
