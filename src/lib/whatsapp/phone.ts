// ---------------------------------------------------------------------------
// Qué cuenta como un número al que se le puede escribir.
//
// El CRM da por sentado en todas partes que un contacto es un teléfono de
// WhatsApp. El webhook lo daba por sentado más fuerte todavía:
//
//     const phoneNumber = `+${message.from}`;
//
// Sin `from`, eso produce la cadena '+undefined' y la guarda como si fuera un
// número. Es exactamente lo que hay hoy en la ficha de un contacto de los
// 1.197: un chat que se ve, que se puede abrir y al que es imposible
// entregarle nada, porque `toWaId` le quita todo lo que no es dígito y Meta
// recibe un destinatario vacío.
//
// El fallo no fue asumir que el remitente es un teléfono: es una suposición
// razonable. Fue no comprobarlo, y que la plantilla de cadena convirtiera un
// `undefined` en un dato con pinta de válido en vez de en un error.
// ---------------------------------------------------------------------------

/**
 * E.164: un `+` y entre 7 y 15 dígitos.
 *
 * El techo son los 15 del estándar. El piso es deliberadamente bajo — no es
 * trabajo de esto validar planes de numeración nacionales, sino separar un
 * teléfono de 'undefined' y de 'CO.1550555583222997'.
 */
const E164 = /^\+\d{7,15}$/;

/** Sólo dígitos, que es como la Cloud API identifica a un remitente. */
const SOLO_DIGITOS = /^\d{7,15}$/;

/**
 * ¿A este número se le puede entregar algo por WhatsApp?
 *
 * Se pregunta antes de escribir, no después de que Meta rechace: un envío que
 * nace condenado deja una fila en `messages` y un triángulo rojo que el asesor
 * va a reintentar.
 */
export function isDeliverablePhoneNumber(value: string | null | undefined): boolean {
  return typeof value === "string" && E164.test(value);
}

/**
 * El número del CRM a partir del identificador del remitente que manda Meta,
 * o null si ese identificador no es un teléfono.
 *
 * Devuelve null y no una cadena a propósito: quien llama tiene que decidir qué
 * hacer con un remitente que no se puede identificar, y esa decisión no puede
 * tomarse sola dentro de una plantilla de cadena.
 */
export function phoneNumberFromWaId(from: string | null | undefined): string | null {
  const limpio = from?.trim();
  if (!limpio || !SOLO_DIGITOS.test(limpio)) return null;
  return `+${limpio}`;
}

/**
 * El teléfono que un asesor escribe a mano al agregar un contacto nuevo
 * desde la bandeja (T6, 8/9/2026), convertido a E.164 — nunca es un `wa_id`
 * que ya llegó limpio de Meta, sino lo que alguien tipea con guiones,
 * espacios y el prefijo que le salga natural. En Venezuela eso es casi
 * siempre un móvil `04xx-xxxxxxx` sin el código de país, así que los cuatro
 * prefijos que se resuelven acá (`0`, `00<código>`, el código sin `+`, y `+`
 * ya puesto) cubren lo que un venezolano escribe sin pensarlo dos veces.
 *
 * Termina pasando SIEMPRE por `isDeliverablePhoneNumber`: mejor devolver
 * `null` que un E.164 con la forma correcta pero un número que Meta va a
 * rechazar de todas formas (por ejemplo, "123" con el código pegado
 * adelante sigue siendo demasiado corto).
 */
export function normalizePhoneInput(
  raw: string | null | undefined,
  defaultCountryCode = "58"
): string | null {
  const sinFormato = raw?.replace(/[\s\-.()]/g, "") ?? "";
  if (sinFormato === "") return null;

  let candidato: string;
  if (sinFormato.startsWith("+")) {
    candidato = sinFormato;
  } else if (sinFormato.startsWith("00")) {
    candidato = `+${sinFormato.slice(2)}`;
  } else if (sinFormato.startsWith("0")) {
    // "0414-1234567": el 0 es el prefijo de marcado nacional, no parte del
    // número — se cambia por el código de país.
    candidato = `+${defaultCountryCode}${sinFormato.slice(1)}`;
  } else if (sinFormato.startsWith(defaultCountryCode)) {
    candidato = `+${sinFormato}`;
  } else {
    // Sin ningún prefijo reconocible: se asume número nacional sin el 0
    // inicial (p. ej. "4141234567").
    candidato = `+${defaultCountryCode}${sinFormato}`;
  }

  return isDeliverablePhoneNumber(candidato) ? candidato : null;
}
