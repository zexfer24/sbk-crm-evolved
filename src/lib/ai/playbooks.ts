import "server-only";
import { generateObject, type LanguageModelUsage, type ModelMessage } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Playbook, PlaybookAfterSend, PlaybookAttachmentType } from "@/lib/types";
import { getAgentModel } from "@/lib/ai/model";

// ---------------------------------------------------------------------------
// Reconocimiento de escenario: fase 0 del turno. Elige cuál respuesta
// predeterminada aplica, entre las que el supervisor tenga cargadas. Es solo
// una clasificación — el texto que se le envía al cliente sale tal cual de la
// base de datos, sin pasar por el modelo (ver runPlaybook en agent.ts).
// ---------------------------------------------------------------------------

/** Valor del enum que el modelo elige cuando ningún escenario aplica. */
const NO_MATCH = "ninguno";

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

export async function fetchActivePlaybooks(supabase: SupabaseClient<Database>): Promise<Playbook[]> {
  const { data, error } = await supabase
    .from("ai_playbooks")
    .select("id, name, trigger_description, response_text, attachment_url, attachment_type, after_send, is_active")
    .eq("is_active", true)
    .order("name");

  if (error) {
    console.error("No se pudieron leer los escenarios de la IA, el turno sigue por el flujo genérico:", error);
    return [];
  }

  // Los CHECK de la tabla no viajan al tipo generado (llegan como `text`),
  // pero garantizan que estos dos valores están dentro de la unión.
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    triggerDescription: row.trigger_description,
    responseText: row.response_text,
    attachmentUrl: row.attachment_url,
    attachmentType: row.attachment_type as PlaybookAttachmentType | null,
    afterSend: row.after_send as PlaybookAfterSend,
    isActive: row.is_active,
  }));
}

function buildPrompt(playbooks: Playbook[]): string {
  const catalog = playbooks.map((p) => `- ${p.name}: ${p.triggerDescription}`).join("\n");

  return `Eres el clasificador de una repuestera de motos en Venezuela que atiende por WhatsApp. Tienes respuestas ya redactadas para ciertas situaciones. Tu única tarea es decidir cuál de ellas corresponde al ÚLTIMO mensaje del cliente, tomando en cuenta todo el contexto previo de la conversación.

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
export async function matchPlaybook(history: ModelMessage[], playbooks: Playbook[]): Promise<PlaybookMatch> {
  // Sin escenarios cargados no hay nada que elegir: se ahorra la llamada.
  if (playbooks.length === 0) return { playbook: null, usage: ZERO_USAGE };

  const { model, providerOptions } = getAgentModel("low");

  try {
    const { object, usage } = await generateObject({
      model,
      providerOptions,
      output: "enum",
      enum: [...playbooks.map((p) => p.name), NO_MATCH],
      system: buildPrompt(playbooks),
      messages: history,
    });

    return { playbook: playbooks.find((p) => p.name === object) ?? null, usage };
  } catch (err) {
    console.error("Falló el reconocimiento de escenario, el turno sigue por el flujo genérico:", err);
    return { playbook: null, usage: ZERO_USAGE };
  }
}
