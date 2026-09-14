// ---------------------------------------------------------------------------
// Tarea 4, plan "La voz cercana y la espera visible" (14/9/2026), decisión 4.
//
// Dos preguntas puras sobre la FORMA de un texto, sin nada de Supabase ni del
// SDK de IA — igual que identity-guard.ts y history-line.ts, para que
// `matchPlaybook` (playbooks.ts) y `runTurnPhases` (agent.ts) las usen sin
// arrastrar el mundo del servidor:
//
//   - `isPureGreeting`: el mensaje del cliente es SOLO un saludo, sin nada
//     más. 53 veces en 72 h el cliente saludó y preguntó en el mismo mensaje
//     ("Buenas tardes, tienen tanque de EK Xpress") y recibió solo "¿En qué
//     podemos ayudarle?" — el escenario de saludo calzaba porque el
//     clasificador comparaba el mensaje CONTRA el disparador de saludo, y ese
//     disparador no exige que el mensaje sea nada MÁS que un saludo. Esta
//     función es la que sí lo exige.
//   - `isCourtesyOnly`: el mensaje es SOLO cortesía de cierre ("gracias",
//     "ok", "perfecto"...). Tras la devolución masiva del 13/9/2026, un "Ok,
//     muchas gracias" reencolado recibió la despedida fija de escalada
//     ("¡Gracias por preferirnos!") mientras el cliente esperaba a que un
//     asesor le escribiera — una respuesta más, y ninguna de un humano.
//
// Las dos fallan hacia `false` ante cualquier palabra que no esté en su lista
// de palabras permitidas: es mejor tratar un mensaje ambiguo como "hay algo
// más que atender" (se clasifica normal) que tragarse una pregunta real
// dentro de lo que parecía un saludo o una cortesía.
//
// `isGreetingPlaybook` es la tercera pregunta, sobre el TEXTO YA REDACTADO de
// un escenario (no sobre lo que escribió el cliente) — hermana de
// `greetingWindow` en greeting-window.ts, que mira la misma clase de texto
// para decidir la franja horaria. Falla ABIERTO a propósito, como esa: un
// escenario que no se reconoce como saludo se queda en la lista de
// candidatos en vez de perderse.
// ---------------------------------------------------------------------------

/** Tope de palabras: pasado esto, ya no es "solo un saludo/cortesía", es una oración. */
const TOPE_PALABRAS = 6;

/**
 * Quita acentos (NFD + descarte del rango de marcas combinantes) y pasa a
 * minúsculas, igual que `identity-guard.ts` y `greeting-window.ts`: así
 * "Días", "dias" y "DÍAS" comparan igual.
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

// "buen"/"buenos"/"buenas"/"buena" + "dia(s)"/"tarde(s)"/"noche(s)"; "hola",
// "hey", "saludos", "que tal"; "como estan/estas/esta" como coletilla de
// saludo ("hola, ¿cómo están?"); "amigo/amiga/amigos" como forma de dirigirse
// a alguien dentro del saludo ("buenas tardes amigo").
const PALABRAS_SALUDO = new Set([
  "hola",
  "buenas",
  "buenos",
  "buena",
  "buen",
  "dias",
  "dia",
  "tardes",
  "tarde",
  "noches",
  "noche",
  "hey",
  "ey",
  "saludos",
  "que",
  "tal",
  "como",
  "estan",
  "estas",
  "esta",
  "amigo",
  "amiga",
  "amigos",
]);

/**
 * true si, normalizado, el texto es SOLO un saludo: "hola", "buenas",
 * "buenos días", "buenas tardes", "buenas noches", "buen día", "hey",
 * "saludos", "qué tal", "hola buenas", "buenas tardes, ¿cómo están?",
 * "buenas tardes amigo". Cualquier palabra fuera de esa lista —o más de seis
 * palabras en total— lo tira a `false`: así "buenas, tienen tanque de EK
 * Xpress" no cuenta como saludo puro.
 */
export function isPureGreeting(text: string): boolean {
  return esSoloPalabrasDe(text, PALABRAS_SALUDO);
}

// "de acuerdo" y "esta bien" comparten palabras con otros usos ("de", "esta",
// "bien"), pero acá viven en su propio conjunto: no se mezclan con
// PALABRAS_SALUDO, cada función mira la lista que le corresponde.
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
 * sacar de los candidatos de fase 0 los escenarios de saludo cuando el
 * cliente preguntó algo además de saludar (`matchPlaybook`, playbooks.ts).
 *
 * Falla ABIERTO (`false` ante duda), mismo criterio que `greetingWindow` en
 * greeting-window.ts: un escenario que no se reconoce como saludo se queda
 * en la lista de candidatos en vez de perderse en silencio.
 */
export function isGreetingPlaybook(responseText: string): boolean {
  const texto = normalizar(responseText).replace(/^[^\p{L}]+/u, "");
  return /^(hola|buenas|buenos|buena|buen\s*dia|bienvenid)/.test(texto);
}
