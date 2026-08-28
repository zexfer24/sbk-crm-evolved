import "server-only";
import { generateObject, type LanguageModelUsage, type ModelMessage } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Playbook, PlaybookAfterSend, PlaybookAttachmentType, Tag, TagColor } from "@/lib/types";
import { getClassifierModel } from "@/lib/ai/model";
import { playbooksAtTime } from "@/lib/ai/greeting-window";
import { formatCrmDateTime } from "@/lib/time-zone";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Reconocimiento de escenario: fase 0 del turno. Elige cuál respuesta
// predeterminada aplica, entre las que el supervisor tenga cargadas. Es solo
// una clasificación — el texto que se le envía al cliente sale tal cual de la
// base de datos, sin pasar por el modelo (ver runPlaybook en agent.ts).
// ---------------------------------------------------------------------------

/** Valor del enum que el modelo elige cuando ningún escenario aplica. */
const NO_MATCH = "ninguno";

/**
 * Cuánto tiene que pasar para que un escenario pueda repetirse en el mismo
 * chat.
 *
 * El 27 de agosto de 2026 un cliente recibió el MISMO mensaje cinco veces en
 * 68 minutos. El emparejador no falló: el disparador que el equipo escribió
 * ("pregunta por cascos, modelos disponibles o tallas") captura también las
 * preguntas de seguimiento, y el cliente dijo "talla" en los cinco mensajes.
 * En 24 h eso fueron 25 repeticiones exactas sobre 202 mensajes: un 12 %.
 *
 * Esto no arregla el disparador —eso lo escribe el dueño desde el panel— ni lo
 * intenta: es la red que hace que una regla mal escrita no pueda convertirse
 * en un cliente recibiendo lo mismo cinco veces.
 *
 * Seis horas y no una: el escenario frenado no deja al cliente en silencio,
 * el turno cae al flujo genérico y le contesta con lo que sepa. O sea que
 * pasarse de largo cuesta poco —una respuesta redactada en vez del texto
 * oficial— y quedarse corto cuesta lo del incidente. Lo único que se pierde
 * de verdad es el adjunto, que solo viaja con el escenario; por eso no es
 * "una vez por conversación": el que vuelve mañana a pedir el catálogo lo
 * recibe.
 */
const PLAYBOOK_COOLDOWN_HOURS = 6;

/**
 * ¿Este escenario ya salió en este chat hace poco?
 *
 * Se pregunta contra `agent_turns`, que es donde queda registrado cada
 * escenario que se envió, con su `playbook_id`. El índice
 * `agent_turns_conversation_id_idx` es (conversation_id, created_at desc), así
 * que la consulta toca solo las filas de esta conversación.
 *
 * Falla CERRADO: si no se puede preguntar, se da por repetido. Cuesta barato
 * equivocarse hacia ese lado —el turno sigue por el flujo genérico y el
 * cliente igual recibe una respuesta—, y equivocarse hacia el otro es
 * exactamente el incidente.
 */
export async function playbookSentRecently(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  playbookId: string,
  now: number = Date.now()
): Promise<boolean> {
  const desde = new Date(now - PLAYBOOK_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("agent_turns")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("playbook_id", playbookId)
    .gt("created_at", desde)
    .limit(1);

  if (error) {
    log.error("escenario_repeticion_no_consultable", { conversationId, detail: error.message });
    return true;
  }

  return (data ?? []).length > 0;
}

const ZERO_USAGE: LanguageModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

export interface PlaybookMatch {
  playbook: Playbook | null;
  usage: LanguageModelUsage;
}

/** Fila de `ai_playbook_tags` con su etiqueta embebida, tal como llega de PostgREST. */
interface RawPlaybookTag {
  tag: { id: string; label: string; color: string } | null;
}

/**
 * Las etiquetas viajan embebidas y no en una segunda consulta porque acá son
 * unas pocas decenas de filas en total —los escenarios se cuentan con los
 * dedos— y esto corre una vez por turno. El caso que obliga a separar (el
 * lateral por fila sobre cientos de filas, ver CONVERSATION_BOARD_SELECT en
 * src/lib/data.ts) no es este.
 */
export async function fetchActivePlaybooks(supabase: SupabaseClient<Database>): Promise<Playbook[]> {
  const { data, error } = await supabase
    .from("ai_playbooks")
    .select(
      "id, name, trigger_description, response_text, attachment_url, attachment_type, after_send, is_active, ai_playbook_tags(tag:tags(id, label, color))"
    )
    .eq("is_active", true)
    .order("name");

  if (error) {
    console.error("No se pudieron leer los escenarios de la IA, el turno sigue por el flujo genérico:", error);
    return [];
  }

  // Los CHECK de la tabla no viajan al tipo generado (llegan como `text`),
  // pero garantizan que estos valores están dentro de la unión.
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    triggerDescription: row.trigger_description,
    responseText: row.response_text,
    attachmentUrl: row.attachment_url,
    attachmentType: row.attachment_type as PlaybookAttachmentType | null,
    afterSend: row.after_send as PlaybookAfterSend,
    isActive: row.is_active,
    tags: playbookTags(row as unknown as { ai_playbook_tags: RawPlaybookTag[] | null }),
  }));
}

/**
 * `tag` puede llegar en null si la etiqueta se borró entre la consulta y la
 * respuesta. La clave foránea con cascada hace que esa fila desaparezca sola,
 * así que es una carrera, no un estado guardado — se descarta y ya.
 */
function playbookTags(row: { ai_playbook_tags: RawPlaybookTag[] | null }): Tag[] {
  return (row.ai_playbook_tags ?? [])
    .map((link) => link.tag)
    .filter((tag): tag is NonNullable<RawPlaybookTag["tag"]> => tag !== null)
    .map((tag) => ({ id: tag.id, label: tag.label, color: tag.color as TagColor }));
}

function buildPrompt(playbooks: Playbook[], now: Date): string {
  const catalog = playbooks.map((p) => `- ${p.name}: ${p.triggerDescription}`).join("\n");

  return `Eres el clasificador de una repuestera de motos en Venezuela que atiende por WhatsApp. Tienes respuestas ya redactadas para ciertas situaciones. Tu única tarea es decidir cuál de ellas corresponde al ÚLTIMO mensaje del cliente, tomando en cuenta todo el contexto previo de la conversación.

Fecha y hora local: ${formatCrmDateTime(now)} (Venezuela). Varios disparadores están escritos como franjas horarias: compruébalos contra ESA hora, no contra las palabras del cliente. Alguien puede escribir "buenas noches" a las once de la mañana.

Escenarios disponibles:
${catalog}

Responde "${NO_MATCH}" si ninguno calza con claridad.

Ante la duda, responde "${NO_MATCH}". Equivocarse de escenario le manda al cliente un mensaje que no tiene nada que ver con lo que preguntó; responder "${NO_MATCH}" solo hace que otro agente atienda el caso con normalidad. Prefiere siempre el segundo error.

Responde solo con el nombre exacto del escenario, o con "${NO_MATCH}".`;
}

/**
 * Fase 0 del turno. Devuelve el escenario que aplica, o null.
 *
 * Nunca lanza: un fallo del proveedor no puede tumbar el turno, solo hace
 * que la conversación siga por el flujo genérico, que es el comportamiento
 * que había antes de que existieran los escenarios.
 */
export async function matchPlaybook(
  history: ModelMessage[],
  playbooks: Playbook[],
  now: Date = new Date()
): Promise<PlaybookMatch> {
  // La hora se decide acá y no se le pregunta al modelo. De 14 saludos del 27
  // de agosto de 2026, 4 salieron con el saludo equivocado —"¡Buenos días!" a
  // las diez de la noche— porque esta función no sabía qué hora era: los tres
  // saludos entraban juntos al enum y el único cuyo disparador describe la
  // FORMA del mensaje ("solo con hola o cualquier saludo") calzaba a toda
  // hora. Filtrar antes le quita la opción imposible en vez de corregirle la
  // respuesta después. Ver greeting-window.ts.
  const candidatos = playbooksAtTime(playbooks, now);

  // Sin escenarios que puedan salir ahora no hay nada que elegir: se ahorra la
  // llamada y el turno sigue por el flujo genérico, que redacta con la hora
  // correcta (va en TURNO ACTUAL, ver prompt.ts).
  if (candidatos.length === 0) return { playbook: null, usage: ZERO_USAGE };

  const { model, providerOptions } = getClassifierModel("escenario");

  try {
    const { object, usage } = await generateObject({
      model,
      providerOptions,
      // Ver classify.ts: el reintento lo hace el control de ritmo, no el SDK.
      maxRetries: 0,
      output: "enum",
      enum: [...candidatos.map((p) => p.name), NO_MATCH],
      system: buildPrompt(candidatos, now),
      messages: history,
    });

    return { playbook: candidatos.find((p) => p.name === object) ?? null, usage };
  } catch (err) {
    // Registro estructurado y no console.error: este catch se traga
    // CUALQUIER fallo del proveedor, rate limit incluido, y el turno
    // sigue como si no hubiera escenarios. Enterrado en texto suelto,
    // un 429 acá era invisible: solo se veía cuando volvía a pegar en la
    // fase siguiente, que es la que sí aborta el turno.
    log.error("escenario_reconocimiento_fallido", { detail: errorText(err) });
    return { playbook: null, usage: ZERO_USAGE };
  }
}
