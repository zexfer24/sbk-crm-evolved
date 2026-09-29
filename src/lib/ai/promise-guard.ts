// ---------------------------------------------------------------------------
// Guarda de promesa falsa: detecta si el texto que Seba está por mandar
// AFIRMA que una persona ya tiene, revisa o va a atender el caso (T3b, plan
// "Seba encuentra, no insiste, y el mostrador no deja a nadie esperando",
// 28/9/2026).
//
// Caso real del estudio del VPS (1.027 turnos, 25/9 → 28/9/2026): el modelo
// escribió "un asesor ya tiene tu caso" en turnos donde NUNCA llamó a
// `escalarAAsesor` — no había traspaso, no había dueño, y el cliente se
// quedó esperando a alguien que nadie sabía que lo esperaba (la invariante
// "ningún lead invisible" de CLAUDE.md, rota por una frase). El prompt ya
// prohíbe decirlo sin escalar (T4), pero una prohibición en el prompt no es
// una garantía: `agent.ts` usa este módulo para, si el texto lo afirma y el
// turno no escaló ni hay asesor asignado, ESCALAR con `seguimiento` — así la
// frase se vuelve verdad en vez de censurarse.
//
// Solo decide si el texto AFIRMA. Lo condicional ("si quieres, te paso con un
// asesor"), lo informativo ("los asesores atienden de lunes a viernes") y las
// preguntas ("¿te paso con un asesor?") NO son promesas: ofrecer no compromete
// a nadie. Se evalúa frase por frase; basta UNA frase afirmativa.
//
// Módulo PURO a propósito, mismo patrón que `identity-guard.ts` y
// `price-guard.ts`: sin `server-only` y sin imports.
// ---------------------------------------------------------------------------

/** Minúsculas y sin acentos: los patrones de abajo se escriben una sola vez. */
function plano(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Quién atiende: "un asesor", "una asesora", "el equipo", "alguien del equipo"… */
const QUIEN = String.raw`(?:(?:un|una|el|la|nuestro|nuestra|mi)\s+(?:asesor(?:a)?|equipo)|alguien del equipo|una persona del equipo)`;

/** "te" + verbo: lo que esa persona hace con el cliente. */
const ACCION_HACIA_TI = String.raw`te\s+(?:va a|escribe|escribira|contacta|contactara|llama|llamara|responde|respondera|contesta|contestara|atiende|atendera|confirma|confirmara|ayuda|ayudara|revisa|revisara|verifica|verificara)`;

const PATRONES_AFIRMATIVOS: readonly RegExp[] = [
  // "Un asesor ya tiene tu caso", "el asesor te escribirá", "un asesor revisa tu pedido".
  new RegExp(
    String.raw`${QUIEN}\s+(?:ya\s+)?(?:(?:lo|la)\s+)?(?:tiene|tendra|revisa|revisara|atiende|atendera|verifica|verificara|confirma|confirmara|contactara|llamara|escribe|escribira|respondera|contestara|va a|se comunicara|se pondra|(?:esta|estara)\s+(?:revisando|atendiendo|verificando|pendiente|al tanto)|${ACCION_HACIA_TI})`
  ),
  // "Te paso con un asesor", "ya te paso con el equipo", "te pasaré de una vez con una asesora".
  new RegExp(
    String.raw`\bte\s+(?:paso|pasare|voy a pasar|estoy pasando|transfiero|transferire|conecto|conectare|comunico|comunicare|derivo|derivare|escalo|escalare)\s+(?:ya\s+|ahora\s+|ahorita\s+|enseguida\s+|de una vez\s+|de una\s+)?con\s+${QUIEN}`
  ),
  // "Ya escalé tu caso", "ya le avisé a un asesor", "ya pasé tu caso".
  new RegExp(
    String.raw`\bya\s+(?:le\s+)?(?:avise|notifique|escale|derive|pase|transferi)\s+(?:a\s+(?:un|una|el|la)\s+(?:asesor(?:a)?|equipo)|(?:tu|el)\s+(?:caso|consulta|solicitud|pedido))`
  ),
  // "Tu caso ya está con un asesor", "tu consulta fue escalada".
  new RegExp(
    String.raw`\b(?:tu|el)\s+(?:caso|consulta|solicitud|pedido)\s+(?:ya\s+)?(?:esta|fue|queda|quedo)\s+(?:con\s+(?:un|una|el|la)\s+|en manos de|escalad|derivad|en revision|siendo\s+(?:revisad|atendid))`
  ),
  // "…para que un asesor lo revise" (la despedida sin asesor), "para que el asesor te escriba".
  new RegExp(
    String.raw`\bpara que\s+${QUIEN}\s+(?:lo|la|te)\s+(?:revise|confirme|atienda|escriba|contacte|llame|responda|verifique)`
  ),
];

/**
 * Una frase que solo OFRECE, pregunta o depende de algo no compromete a nadie:
 * "si quieres, te paso con un asesor", "¿te paso con un asesor?", "puedo
 * pasarte con un asesor", "en caso de dudas…". Se mira ANTES de los patrones
 * afirmativos, sobre la misma frase.
 */
const PATRONES_CONDICIONALES: readonly RegExp[] = [
  /^\W*si\b/,
  /\bsi\s+(?:quieres|quiere|deseas|desea|prefieres|prefiere|gustas|gusta|necesitas|necesita|lo\s+(?:necesitas|prefieres|deseas|quieres))\b/,
  /\b(?:quieres|quiere|deseas|desea|prefieres|prefiere|gustas|necesitas)\s+que\b/,
  /\b(?:puedo|podria|podrias|podemos|podre)\b/,
  /^\W*(?:en caso de|de ser necesario|de necesitar|de requerirlo)\b/,
  /\bpuede\b/,
];

/**
 * La primera frase de `texto` que afirma que un asesor (o el equipo) ya tiene,
 * revisa, va a atender o va a escribir al cliente, o `null` si ninguna lo
 * hace. Se devuelve la frase original (recortada) para dejarla en el registro.
 */
export function afirmaPromesaDeAsesor(texto: string): string | null {
  const frases = texto.split(/[.!\n;]+/);
  for (const original of frases) {
    const frase = plano(original);
    if (!frase.trim()) continue;
    // Una pregunta ofrece, no afirma: el "¿" o el "?" quedan en la misma frase al partir solo por punto.
    if (/[?¿]/.test(original)) continue;
    if (PATRONES_CONDICIONALES.some((patron) => patron.test(frase))) continue;
    if (PATRONES_AFIRMATIVOS.some((patron) => patron.test(frase))) return original.trim();
  }
  return null;
}
