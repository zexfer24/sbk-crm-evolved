// ---------------------------------------------------------------------------
// Tarea 4, plan "La voz cercana y la espera visible" (14/9/2026, decisión 4);
// reescrito el 15/9/2026 en la corrida "La voz de mostrador con nombre
// propio" (Tarea 4): se retiró la pregunta que miraba si el mensaje del
// CLIENTE era solo un saludo — sin llamadores tras el cambio de abajo.
//
// Dos preguntas puras sobre la FORMA de un texto, sin nada de Supabase ni del
// SDK de IA — igual que identity-guard.ts y history-line.ts:
//
//   - `isCourtesyOnly`: el mensaje del cliente es SOLO cortesía de cierre
//     ("gracias", "ok", "perfecto"...). Tras la devolución masiva del
//     13/9/2026, un "Ok, muchas gracias" reencolado recibió la despedida
//     fija de escalada ("¡Gracias por preferirnos!") mientras el cliente
//     esperaba a que un asesor le escribiera — una respuesta más, y ninguna
//     de un humano. La usa la guarda de cortesía de `runTurnPhases`
//     (agent.ts).
//   - `isGreetingPlaybook`: el texto YA REDACTADO de un escenario del panel
//     (no lo que escribió el cliente) empieza saludando. La usaba
//     `matchPlaybook` (playbooks.ts) SOLO cuando el cliente saludaba Y
//     preguntaba en el mismo mensaje ("Buenas tardes, tienen tanque de EK
//     Xpress"): el escenario de saludo calzaba igual porque su disparador no
//     exige que el mensaje sea nada MÁS que un saludo. Desde el 15/9/2026 se
//     aplica SIEMPRE: el saludo lo pone `buildInstructions` (prompt.ts), una
//     sola vez por conversación y calculado con la hora de Barinas —así que
//     ningún escenario del panel tiene que volver a saludar, lo haya
//     preguntado el cliente pelado o con algo más. La función en sí no
//     cambió, solo cuándo se llama: sigue fallando ABIERTO (`false` ante
//     duda) para que un escenario que no se reconoce como saludo se quede en
//     la lista de candidatos en vez de perderse en silencio. Hermana de la
//     función retirada en esta misma corrida que miraba el mismo tipo de
//     texto para acotarlo a una franja horaria — trabajo que ya no hace
//     falta porque ningún escenario necesita saludar.
//
// `isCourtesyOnly` falla hacia `false` ante cualquier palabra que no esté en
// su lista de palabras permitidas: es mejor tratar un mensaje ambiguo como
// "hay algo más que atender" (se clasifica normal) que tragarse una pregunta
// real dentro de lo que parecía una cortesía.
// ---------------------------------------------------------------------------

/** Tope de palabras: pasado esto, ya no es "solo un saludo/cortesía", es una oración. */
const TOPE_PALABRAS = 6;

/**
 * Quita acentos (NFD + descarte del rango de marcas combinantes) y pasa a
 * minúsculas, igual que `identity-guard.ts`: así "Días", "dias" y "DÍAS"
 * comparan igual.
 */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Las palabras del texto, sin puntuación ni emojis — esos son decoración
 * ("¡Hola!", "gracias 🙏"), no parte del saludo o la cortesía en sí. Un
 * emoji se descarta acá igual que una coma: lo que cuenta para el tope de
 * palabras y para el cotejo contra la lista permitida es solo lo alfabético.
 */
function palabras(texto: string): string[] {
  return normalizar(texto)
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** ¿Todas las palabras del texto están en el conjunto permitido, y no son demasiadas? */
function esSoloPalabrasDe(texto: string, permitidas: Set<string>): boolean {
  const tokens = palabras(texto);
  if (tokens.length === 0 || tokens.length > TOPE_PALABRAS) return false;
  return tokens.every((palabra) => permitidas.has(palabra));
}

// "de acuerdo" y "esta bien" viven en su propio conjunto, aparte de las
// palabras del saludo puro del cliente: esa lista y la función que la usaba
// se retiraron el 15/9/2026 sin dejar llamadores.
const PALABRAS_CORTESIA = new Set([
  "gracias",
  "muchas",
  "ok",
  "okey",
  "vale",
  "listo",
  "perfecto",
  "dale",
  "de",
  "acuerdo",
  "esta",
  "bien",
  "amigo",
  "amiga",
  "amigos",
]);

/**
 * Emojis de cierre que por sí solos son "solo cortesía", sin nada más que
 * agregar: pulgar arriba, manos en oración, aplauso, corazón. Se comparan
 * contra el texto ORIGINAL (no contra `palabras`, que ya los descarta) y se
 * les quita el selector de variación (U+FE0F) y el unión de ancho cero
 * (U+200D) que WhatsApp a veces pega al emoji.
 */
const EMOJIS_CORTESIA = ["👍", "🙏", "🙌", "❤️", "❤"];

/** true si, quitando los emojis de cortesía conocidos, no queda nada más. */
function esSoloEmojisDeCortesia(text: string): boolean {
  const recortado = text.trim();
  if (!recortado) return false;
  let resto = recortado;
  for (const emoji of EMOJIS_CORTESIA) {
    resto = resto.split(emoji).join("");
  }
  resto = resto.replace(/[‍️\s]/g, "");
  return resto.length === 0;
}

/**
 * true si, normalizado, el texto es SOLO cortesía de cierre: "gracias",
 * "muchas gracias", "ok", "okey", "vale", "listo", "perfecto", "dale", "de
 * acuerdo", "está bien", "gracias amigo", o solo emojis 👍🙏🙌❤️ (solos o
 * combinados). Cualquier palabra fuera de esa lista —o más de seis palabras
 * en total— lo tira a `false`: así "gracias, y ¿tienen rines 17?" sigue
 * siendo un turno normal, no una despedida.
 */
export function isCourtesyOnly(text: string): boolean {
  return esSoloEmojisDeCortesia(text) || esSoloPalabrasDe(text, PALABRAS_CORTESIA);
}

/**
 * ¿El texto YA REDACTADO de un escenario empieza saludando? Se usa para
 * sacar de los candidatos de fase 0 TODOS los escenarios de saludo
 * (`matchPlaybook`, playbooks.ts) — desde el 15/9/2026 se aplica SIEMPRE, sin
 * mirar lo que escribió el cliente: el saludo lo pone `buildInstructions`
 * (prompt.ts), una sola vez por conversación, así que ningún escenario del
 * panel tiene que volver a saludar.
 *
 * Falla ABIERTO (`false` ante duda): un escenario que no se reconoce como
 * saludo se queda en la lista de candidatos en vez de perderse en silencio.
 */
export function isGreetingPlaybook(responseText: string): boolean {
  const texto = normalizar(responseText).replace(/^[^\p{L}]+/u, "");
  return /^(hola|buenas|buenos|buena|buen\s*dia|bienvenid)/.test(texto);
}
