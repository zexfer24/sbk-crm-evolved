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
