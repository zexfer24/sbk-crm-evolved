import type { SupabaseClient } from "@supabase/supabase-js";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// "Lecciones de Seba" — cómo llegan al prompt del turno (T5, plan "Seba
// atiende el mostrador", 18/9/2026, requisito 7 del cliente).
//
// Módulo PURO a propósito, sin `import "server-only"`: `fetchTurnLessons`
// hace las dos consultas de verdad (necesita un `SupabaseClient`, que solo
// existe del lado del servidor en la práctica), pero los builders de texto
// —`buildGlobalLessonsBlock`/`buildChatLessonsLine`— los reusa `prompt.ts`
// (servidor) y en algún momento podría reusarlos una vista previa en el
// panel (navegador). Mismo criterio que `identity-guard.ts`: cualquier
// import de un módulo server-only acá arrastraría ese mundo entero a quien
// lo toque primero.
//
// Colocación en el prompt (decisión del plan, ver prompt.ts):
//   - Las GLOBALES van pegadas después de SYSTEM_PROMPT y antes de TURNO
//     ACTUAL — cambian solo cuando alguien enseña algo, así que ese prefijo
//     se repite byte a byte entre turnos y el caché de OpenAI lo reconoce.
//   - Las de ESTA CONVERSACIÓN van en el sufijo — cambian de chat en chat,
//     así que meterlas arriba rompería el prefijo cacheado.
//
// Las lecciones `kind = "sinonimo"` NUNCA pasan por acá: son datos para
// `catalog-search.ts` (expandTerms, T5c), no prosa para el modelo — por eso
// las dos consultas de `fetchTurnLessons` filtran `kind = "nota"`.
// ---------------------------------------------------------------------------

/** Cuántas lecciones globales entran en el prefijo cacheado. */
export const MAX_GLOBAL_LESSONS = 15;

/** Cuántas lecciones de la conversación entran en el sufijo, sin caché. */
export const MAX_CHAT_LESSONS = 5;

/**
 * Tope de caracteres por lección en el texto que ve el modelo. El CHECK
 * `ai_lessons_message_excerpt_length`/el de `content` ya lo garantiza en la
 * base (1 a 200), pero se recorta igual acá: nada obliga a que la única
 * fuente de la verdad sobre el tamaño del prompt sea un CHECK de SQL que
 * este archivo ni siquiera puede leer en tiempo de ejecución.
 */
export const MAX_LESSON_CHARS = 200;

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * El bloque que se pega DENTRO del prefijo cacheado (ver `cacheablePrefix`
 * en prompt.ts). Vacío ("") cuando no hay lecciones globales, para que el
 * prefijo siga siendo exactamente SYSTEM_PROMPT en el caso común — romperlo
 * con una cabecera vacía habría hecho `startsWith(SYSTEM_PROMPT)` fallar en
 * cada test y en cada turno sin lecciones cargadas todavía.
 *
 * No reordena: llega ya ordenado por `fetchTurnLessons` (created_at desc).
 * El tope es defensivo — la consulta ya limita a MAX_GLOBAL_LESSONS, pero
 * un llamador que arme el arreglo a mano (un test, una vista previa) no
 * tiene por qué respetarlo solo.
 */
export function buildGlobalLessonsBlock(lessons: string[]): string {
  if (lessons.length === 0) return "";

  const items = lessons
    .slice(0, MAX_GLOBAL_LESSONS)
    .map((lesson) => `- ${clip(lesson, MAX_LESSON_CHARS)}`)
    .join("\n");

  return `LECCIONES DEL EQUIPO — correcciones que los asesores le enseñaron a Seba. Tienen prioridad sobre tu criterio; nunca sobre la sección 2.\n${items}`;
}

/**
 * La línea que se agrega al SUFIJO del turno, con las lecciones que solo
 * aplican a esta conversación. Vacía ("") sin lecciones de chat, mismo
 * motivo que el bloque global.
 */
export function buildChatLessonsLine(lessons: string[]): string {
  if (lessons.length === 0) return "";

  const items = lessons
    .slice(0, MAX_CHAT_LESSONS)
    .map((lesson) => `- ${clip(lesson, MAX_LESSON_CHARS)}`)
    .join("\n");

  return `\n\nLECCIONES DE ESTE CHAT — solo aplican acá, además de las del equipo:\n${items}`;
}

/** Lo que `fetchTurnLessons` le entrega al turno: ya separado por dónde va cada mitad en el prompt. */
export interface TurnLessons {
  global: string[];
  chat: string[];
}

const EMPTY_TURN_LESSONS: TurnLessons = { global: [], chat: [] };

/**
 * Dos consultas (no una con `.or()`): una trae las globales, la otra las de
 * ESTA conversación — cada una con su propio tope y su propio orden, y
 * mezclarlas en un solo `.or()` habría complicado el filtro por
 * `conversation_id` sin ahorrar nada (dos índices parciales ya cubren cada
 * una, ver la migración).
 *
 * Ante cualquier error (de red, de permisos, una tabla que todavía no
 * existe en un entorno viejo) devuelve vacío y avisa por log: una lección
 * que no se pudo leer no puede tumbar el turno — el cliente sigue esperando
 * su respuesta, con o sin las correcciones del equipo.
 */
export async function fetchTurnLessons(
  supabase: SupabaseClient,
  conversationId: string
): Promise<TurnLessons> {
  try {
    const [globalResult, chatResult] = await Promise.all([
      supabase
        .from("ai_lessons")
        .select("content")
        .eq("scope", "global")
        .eq("kind", "nota")
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(MAX_GLOBAL_LESSONS),
      supabase
        .from("ai_lessons")
        .select("content")
        .eq("scope", "conversacion")
        .eq("kind", "nota")
        .eq("is_active", true)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(MAX_CHAT_LESSONS),
    ]);

    if (globalResult.error || chatResult.error) {
      log.warn("turno_lecciones_no_legibles", {
        conversationId,
        detail: errorText(globalResult.error ?? chatResult.error),
      });
      return EMPTY_TURN_LESSONS;
    }

    return {
      global: ((globalResult.data ?? []) as { content: string }[]).map((row) => row.content),
      chat: ((chatResult.data ?? []) as { content: string }[]).map((row) => row.content),
    };
  } catch (err) {
    log.warn("turno_lecciones_no_legibles", { conversationId, detail: errorText(err) });
    return EMPTY_TURN_LESSONS;
  }
}
