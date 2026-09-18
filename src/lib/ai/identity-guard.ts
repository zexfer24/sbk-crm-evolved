// ---------------------------------------------------------------------------
// Cerradura de identidad: detecta cuando un borrador de la IA se describe a
// sí misma como automatización o afirma ser una persona, para pedirle al
// modelo que lo reescriba antes de enviarlo. El 26 y 27/8/2026, en producción,
// la IA escribió 60 veces "Soy el asistente automatizado de SBK Motorcycles"
// en 219 mensajes: la prohibición vivía solo en el guion (SYSTEM_PROMPT,
// sección 1) y el modelo la rompió igual. Esta función es la cerradura.
//
// LA TRAMPA: "automático" y "digital" son REPUESTOS de esta tienda, no
// palabras prohibidas. El catálogo trae filas como "AUTOMATICO HORSE",
// "AUTOMATICO BERA R1 AUTOASIA", "CDI RACING AUTOMATICO HORSE",
// "PRENSA CADENA AUTOMATICO GP", "TACOMETRO DIGITAL BERA SBR" — y los
// asesores escriben con normalidad "el sistema lo hace automáticamente"
// (hablando de Cashea), "sistema de pagos", "tacómetro digital". Una guarda
// que bloqueara `automátic*`, `digital` o `sistema` a secas dejaría a la IA
// sin poder cotizar el automático de una Horse, que es exactamente lo que
// vende la tienda. Por eso NINGÚN patrón de abajo mira el adjetivo suelto:
// todos se anclan en la AUTORREFERENCIA ("soy un…", "asistente automatizado",
// "respuesta automática", "no soy una persona") o en términos sin otro uso
// en este negocio (`bot`, `chatbot`, `inteligencia artificial`, `IA` en
// mayúsculas, `ChatGPT`, `OpenAI`, `GPT`, `Gemini`, `modelo de lenguaje`).
//
// Módulo PURO a propósito: sin `import "server-only"` y sin ningún import.
// Lo reusan `agent.ts` (servidor, dentro del tool loop) y `mutations.ts`
// (el navegador, desde un panel de supervisión) — cualquier import acá
// arrastraría el mundo entero del lado que lo toque primero.
// ---------------------------------------------------------------------------

export type IdentityCategory = "automatizacion" | "persona";

export interface IdentityMatch {
  categoria: IdentityCategory;
  fragmento: string;
}

interface PatronIdentidad {
  regex: RegExp;
  // Si es true, el regex corre sobre el texto ORIGINAL (sin normalizar).
  // Hoy solo lo necesita \bIA\b, que debe ser sensible a mayúsculas.
  sobreTextoOriginal?: boolean;
}

// Quita diacríticos vía NFD (á → a + ´, luego se descarta el rango de
// marcas combinantes) y pasa a minúsculas, para que "automática", "AUTOMATICA"
// y "automatica" comparen igual.
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// El orden dentro de cada categoría importa para el `fragmento` que se
// reporta (el primer patrón que calza gana), no solo para la categoría.
// "asistente (automatizado|virtual)" va antes que el resto de los patrones
// que tocan "asistente" para que la frase real del 26/8 devuelva el
// fragmento más específico ("asistente automatizado") y no uno genérico.
//
// 18/9/2026 (T2a, plan "Seba atiende el mostrador", requisito 1 del
// cliente): la IA pasa a llamarse Seba y a presentarse como "tu asistente"
// en el saludo literal (`seba.ts`) y en la sección 1 del prompt ("eres
// Seba, el asistente de SBK Motors por WhatsApp"). Bloquear "soy el
// asistente" o "como asistente" a secas habría bloqueado ese saludo y esa
// frase, así que se retira el patrón `/soy (el|la|un|una) asistente/` y se
// saca "asistente" del patrón `como (ia|...)`. "asistente" solo, sin más
// compañía, deja de estar anclado — sigue bloqueado en combinación con
// "virtual"/"automatizado" (el patrón de arriba), que es lo que de verdad
// describe al programa como automatización.
const PATRONES_AUTOMATIZACION: PatronIdentidad[] = [
  {
    // 26-27/8/2026: "Soy el asistente automatizado de SBK Motorcycles."
    regex: /asistente (automatizad\w*|virtual)/,
  },
  {
    // 15/9/2026 (Tarea 2, "La voz de mostrador con nombre propio"): la sección
    // 1 del prompt ganó la frase "le pasa la conversación a un asesor de
    // ventas", y el operador pidió que la guarda también cierre la puerta a
    // "jamás dice que es un agente de IA" — "agente" SUELTO no se bloquea
    // (los asesores humanos son `agents` en el resto del sistema, y esta
    // misma sección dice "pásale el caso a un asesor"), solo la combinación
    // con virtual/automatizado/de IA/conversacional que de verdad describe al
    // programa.
    regex: /agente (virtual|automatizad\w*|de ia|de inteligencia artificial|conversacional)/,
  },
  {
    // "esta es una respuesta automática": sustantivo + adjetivo. El adjetivo
    // solo ("automático") es un repuesto del catálogo — no se bloquea suelto.
    regex: /(respuesta|mensaje) automatic\w*/,
  },
  {
    // "soy un bot", "soy una inteligencia artificial"
    regex: /soy (un|una) (bot|programa|sistema|maquina|robot|algoritmo|inteligencia artificial)/,
  },
  {
    // "como IA no puedo": el "ia" minúsculo acá solo vale pegado a "como ",
    // nunca suelto (eso lo cubre el patrón \bIA\b de más abajo, sobre el
    // texto original y sensible a mayúsculas). "asistente" salió de acá el
    // 18/9/2026 (ver el comentario de cabecera): "como asistente" solo ya
    // no se bloquea.
    regex: /como (ia|inteligencia artificial)\b/,
  },
  {
    // "no soy una persona" respondiendo "¿eres humano?": negar ser humano es
    // la misma autorreferencia a la automatización, no una afirmación de
    // persona — por eso vive en esta categoría y no en "persona".
    regex: /no soy (una persona|humano|un humano|una persona real)/,
  },
  {
    // "¿eres un bot?" respondido con "sí, soy bot"
    regex: /\bbot\b/,
  },
  {
    regex: /chatbot/,
  },
  {
    regex: /inteligencia artificial/,
  },
  {
    // Mayúsculas exactas sobre el texto ORIGINAL: así "guía", "GUIA",
    // "AUTOASIA", "MARIA" no calzan — en todos la "IA" va pegada a otra
    // letra (sin frontera de palabra) o lleva acento (no es literalmente "IA").
    regex: /\bIA\b/,
    sobreTextoOriginal: true,
  },
  { regex: /chatgpt/ },
  { regex: /openai/ },
  { regex: /\bgpt\b/ },
  { regex: /gemini/ },
  { regex: /modelo de lenguaje/ },
];

const PATRONES_PERSONA: PatronIdentidad[] = [
  { regex: /soy (una persona|humano|humana|una persona real)/ },
  {
    // Afirmar ser un asesor/vendedor concreto es afirmar ser una persona.
    regex: /soy (un|una|el|la) (asesor|asesora|vendedor|vendedora)/,
  },
  {
    // 18/9/2026 (T2a, "Seba atiende el mostrador"): el saludo literal de
    // Seba dice "mi nombre es Seba" (`seba.ts`), y la sección 1 del prompt
    // deja que el modelo lo repita si preguntan con quién habla. El
    // lookahead negativo excluye SOLO ese nombre — cualquier otro ("mi
    // nombre es Carlos") sigue calzando. Corre sobre el texto NORMALIZADO
    // (minúsculas, sin diacríticos — ver `normalizar` más arriba), así que
    // el lookahead compara en minúsculas.
    regex: /me llamo (?!seba\b)/,
  },
  { regex: /mi nombre es (?!seba\b)/ },
  { regex: /estoy en el mostrador/ },
  // NO se incluye "(estoy|estamos) aquí en la tienda": el plural que pide el
  // guion ("acá en SBK lo tenemos") es legítimo y no debe calzar.
];

/**
 * Busca en `text` una autorreferencia a automatización o a ser una persona.
 * Evalúa primero todos los patrones de `automatizacion`, luego los de
 * `persona`; el primer calce gana. Devuelve `null` si no encontró nada.
 */
export function revealsIdentity(text: string): IdentityMatch | null {
  const normalizado = normalizar(text);

  for (const patron of PATRONES_AUTOMATIZACION) {
    const objetivo = patron.sobreTextoOriginal ? text : normalizado;
    const calce = patron.regex.exec(objetivo);
    if (calce) {
      return { categoria: "automatizacion", fragmento: calce[0] };
    }
  }

  for (const patron of PATRONES_PERSONA) {
    const objetivo = patron.sobreTextoOriginal ? text : normalizado;
    const calce = patron.regex.exec(objetivo);
    if (calce) {
      return { categoria: "persona", fragmento: calce[0] };
    }
  }

  return null;
}

/**
 * Texto que `agent.ts` pega DESPUÉS del SYSTEM_PROMPT para pedirle al modelo
 * que reescriba su borrador. No importa SYSTEM_PROMPT acá: eso rompería la
 * pureza del módulo y arrastraría "server-only" hasta este archivo.
 *
 * 18/9/2026 (T2a, "Seba atiende el mostrador"): pedía quitar cualquier
 * referencia a "asistente" a secas, pero desde esta tarea Seba SÍ puede
 * llamarse "tu asistente" (ver `PATRONES_AUTOMATIZACION`). El pedido de
 * reescritura pasa a nombrar "asistente virtual" — la combinación que
 * sigue bloqueada — para no pedirle al modelo que se quite de encima una
 * palabra que ahora tiene permitida.
 */
export function rewriteSuffix(fragmento: string): string {
  return `Tu borrador contenía una frase que te describe como automatizado o como una persona: «${fragmento}». Reescríbelo conservando toda la información, el tono y el largo, quitando cualquier referencia a asistente virtual, agente virtual, bot, IA, sistema o respuesta automática, y sin afirmar ser una persona. Responde solo con el mensaje.`;
}
