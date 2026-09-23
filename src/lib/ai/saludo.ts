// ---------------------------------------------------------------------------
// Tarea 4, plan "La voz cercana y la espera visible" (14/9/2026, decisión 4);
// reescrito el 15/9/2026 en la corrida "La voz de mostrador con nombre
// propio" (Tarea 4): se retiró la pregunta que miraba si el mensaje del
// CLIENTE era solo un saludo — sin llamadores tras el cambio de abajo.
// Vuelve el 18/9/2026 (T2a, plan "Seba atiende el mostrador") como
// `isGreetingOnly`, con un llamador real: el turno necesita distinguir "el
// cliente solo saludó" de "el cliente saludó Y preguntó algo" para decidir
// si el saludo de Seba (`seba.ts`) es la respuesta completa del turno o si
// además hace falta redactar (`agent.ts`, tarea T2b).
//
// Tres preguntas puras sobre la FORMA de un texto, sin nada de Supabase ni
// del SDK de IA — igual que identity-guard.ts y history-line.ts:
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
//   - `isGreetingOnly`: el mensaje del CLIENTE es SOLO un saludo ("hola",
//     "buenas tardes!", "hola que tal"), sin nada más que atender. La usa el
//     turno (`agent.ts`, T2b): si el cliente solo saludó, el saludo de Seba
//     (`sebaGreeting`, `seba.ts`) ya es la respuesta completa y el turno no
//     gasta fase 0, fase 1 ni tool loop en redactar nada más. Misma mecánica
//     que `isCourtesyOnly` (tope de 6 palabras, normalización), lista de
//     palabras propia.
//
// `isCourtesyOnly` falla hacia `false` ante cualquier palabra que no esté en
// su lista de palabras permitidas: es mejor tratar un mensaje ambiguo como
// "hay algo más que atender" (se clasifica normal) que tragarse una pregunta
// real dentro de lo que parecía una cortesía.
//
//   - `isFarewellPlaybook`: el texto YA REDACTADO de un escenario del panel
//     ¿es una despedida? T5, plan "Seba no habla de más mientras el cliente
//     espera al asesor" (22-23/9/2026, opción (b), "un solo acuse por
//     espera"): con una escalada abierta, Seba deja de correr el tool loop y
//     solo puede contestar con un escenario ya redactado del panel -- un
//     escenario de despedida ahí sería Seba despidiéndose OTRA VEZ de
//     alguien que sigue esperando a una persona, la respuesta hueca que
//     medida el 22/9/2026 en producción (27 % de los mensajes de Seba con
//     una escalada abierta, hasta 6 en una misma espera, la mayoría
//     "el asesor ya tiene tu caso"). La usa `runTurnPhases` (agent.ts) para
//     sacar los escenarios de despedida de los candidatos ANTES de llamar a
//     `matchPlaybook` -- mismo patrón que `isGreetingPlaybook`, más abajo.
//     Falla ABIERTO igual que las otras dos preguntas de este módulo: un
//     falso POSITIVO (un escenario informativo que por casualidad calza el
//     patrón) solo deja ese escenario afuera y el turno cae a la nota
//     interna -- un mensaje de más para el asesor, no uno de más para el
//     cliente; un falso NEGATIVO (una despedida que no se reconoce como tal)
//     es justo el bug que esta función existe para evitar, así que la lista
//     de patrones prefiere sobrar antes que faltar.
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
 * Palabras que arman un saludo puro del cliente: "hola", "buenas [tardes]",
 * "qué tal", "hey"... — no incluye "gracias" ni el resto de la cortesía de
 * cierre, que vive en `PALABRAS_CORTESIA` (son dos situaciones distintas: una
 * abre la conversación, la otra la cierra).
 */
const PALABRAS_SALUDO = new Set([
  "hola",
  "buenas",
  "buenos",
  "buen",
  "dia",
  "dias",
  "tarde",
  "tardes",
  "noche",
  "noches",
  "saludos",
  "hey",
  "que",
  "tal",
  "hi",
]);

/**
 * true si, normalizado, el mensaje del CLIENTE es SOLO un saludo: "hola",
 * "buenas tardes!", "hola que tal". Más de seis palabras, o cualquier
 * palabra fuera de la lista ("hola tienen pastillas"), lo tira a `false` —
 * mismo criterio que `isCourtesyOnly`: mejor tratar un mensaje ambiguo como
 * "hay algo más que atender" que tragarse una pregunta real.
 *
 * 18/9/2026 (T2a, "Seba atiende el mostrador"): la usa el turno para decidir
 * si, tras mandar el saludo de Seba, hace falta seguir redactando o si el
 * saludo ya fue la respuesta completa (`agent.ts`, T2b).
 */
export function isGreetingOnly(text: string): boolean {
  return esSoloPalabrasDe(text, PALABRAS_SALUDO);
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

/**
 * ¿El texto YA REDACTADO de un escenario es una DESPEDIDA? T5, plan "Seba no
 * habla de más mientras el cliente espera al asesor" (22-23/9/2026). Se
 * normaliza igual que el resto del módulo (sin acentos, minúsculas) y se
 * compara contra frases sueltas en cualquier parte del texto -- a diferencia
 * de `isGreetingPlaybook`, que ancla al INICIO (un saludo abre el mensaje),
 * una despedida puede venir después de otra frase ("¡Fue un placer
 * ayudarte! Que tengas un buen día.").
 *
 * Reconoce, como mínimo, el texto real del escenario "Gracias" del panel
 * ("¡Muchas gracias por preferirnos!🥰 Esperamos poder servirte
 * nuevamente.🎊") y las variantes que pidió el plan: "gracias por
 * preferirnos", "esperamos (poder) servirte", "fue un placer", "hasta
 * pronto", "vuelve pronto", "que tengas un buen/feliz día".
 */
export function isFarewellPlaybook(responseText: string): boolean {
  const texto = normalizar(responseText);
  return /(gracias por preferirnos|esperamos (poder )?servirte|fue un placer|hasta pronto|vuelve pronto|que tengas un (buen|feliz) dia)/.test(
    texto
  );
}
