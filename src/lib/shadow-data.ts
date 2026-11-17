import type { SupabaseClient } from "@supabase/supabase-js";
import {
  shadowDraftFromRow,
  shadowReviewFromRow,
  type ShadowDraft,
  type ShadowReview,
} from "@/lib/shadow";

// ---------------------------------------------------------------------------
// Lecturas del panel «Sombra» y de la sugerencia de copiloto (entrega 3 del
// rework de Seba, 17/11/2026). Corren en el NAVEGADOR con la sesión del agente:
// la RLS de `agent_shadow_drafts` deja leer todo al supervisor/admin y solo los
// de `copiloto` a un asesor; `shadow_reviews` es solo de supervisor/admin. Por
// eso este archivo no importa `lib/log.ts` (los fallos van a `console.error`).
//
// Se piden columnas explícitas y NO `*`: `estado_antes`, `estado_despues` y
// `contexto` son jsonb grandes que ninguna pantalla pinta todavía.
// ---------------------------------------------------------------------------

const DRAFT_COLUMNS =
  "id, conversation_id, modo, trigger_message_id, rafaga, mensajes, herramientas, productos, escalaria, motivo, area, nota, guardas, model, input_tokens, output_tokens, llamadas, duration_ms, sugerencia_estado, sugerencia_resuelta_por, sugerencia_resuelta_at, created_at";

/** Cuántos ids viajan en un `in.(…)`: 100 uuids son ~4 KB de URL, bajo el tope de cualquier proxy. */
const REVIEW_IDS_PER_REQUEST = 100;

/** Los últimos borradores del período, del más nuevo al más viejo. */
export async function fetchShadowDrafts(
  supabase: SupabaseClient,
  options: { desde: string; hasta?: string; limit?: number }
): Promise<ShadowDraft[]> {
  let query = supabase.from("agent_shadow_drafts").select(DRAFT_COLUMNS).gte("created_at", options.desde);
  if (options.hasta) query = query.lt("created_at", options.hasta);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(options.limit ?? 200);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(shadowDraftFromRow);
}

/** Las revisiones de esos borradores (a lo sumo una por borrador). */
export async function fetchShadowReviews(supabase: SupabaseClient, draftIds: string[]): Promise<ShadowReview[]> {
  if (draftIds.length === 0) return [];

  const lotes: string[][] = [];
  for (let i = 0; i < draftIds.length; i += REVIEW_IDS_PER_REQUEST) {
    lotes.push(draftIds.slice(i, i + REVIEW_IDS_PER_REQUEST));
  }

  const resultados = await Promise.all(
    lotes.map(async (ids) => {
      const { data, error } = await supabase.from("shadow_reviews").select("*").in("draft_id", ids);
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map(shadowReviewFromRow);
    })
  );
  return resultados.flat();
}

export interface AdvisorFollowupMessage {
  id: string;
  content: string | null;
  messageType: string;
  createdAt: string;
}

export interface AdvisorFollowups {
  messages: AdvisorFollowupMessage[];
  /** Minutos entre el borrador y el primer mensaje del asesor; `null` si todavía no contestó. */
  minutesToFirst: number | null;
}

/**
 * Lo que de verdad contestó el asesor: sus TRES mensajes siguientes al borrador
 * (salientes de un asesor, sin notas internas). Los envíos de la IA no cuentan:
 * `sender_type = 'agent'` es solo de personas.
 */
export async function fetchAdvisorFollowups(
  supabase: SupabaseClient,
  conversationId: string,
  afterIso: string
): Promise<AdvisorFollowups> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, content, message_type, created_at")
    .eq("conversation_id", conversationId)
    .eq("sender_type", "agent")
    .eq("direction", "outbound")
    .eq("is_internal_note", false)
    .gt("created_at", afterIso)
    .order("created_at", { ascending: true })
    .limit(3);
  if (error) throw error;

  const messages = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    content: typeof row.content === "string" ? row.content : null,
    messageType: typeof row.message_type === "string" ? row.message_type : "text",
    createdAt: String(row.created_at),
  }));

  const first = messages[0];
  const minutesToFirst = first
    ? (new Date(first.createdAt).getTime() - new Date(afterIso).getTime()) / 60_000
    : null;
  return { messages, minutesToFirst };
}

/**
 * Gasto de la sombra y el copiloto de HOY (USD, hora de Caracas). `null` si la
 * RPC falla o falta la migración: el panel pinta «—», nunca un cero que parezca
 * un gasto medido.
 */
export async function fetchShadowSpendToday(supabase: SupabaseClient): Promise<number | null> {
  const { data, error } = await supabase.rpc("shadow_spend_today");
  if (error) {
    console.error("No se pudo leer el gasto de la sombra de hoy:", error);
    return null;
  }
  if (data === null || data === undefined) return null;
  const value = Number(data);
  return Number.isFinite(value) ? value : null;
}

/** El último borrador de COPILOTO de la conversación, en cualquier estado: quien lo pide decide si se ve. */
export async function fetchPendingSuggestion(
  supabase: SupabaseClient,
  conversationId: string
): Promise<ShadowDraft | null> {
  const { data, error } = await supabase
    .from("agent_shadow_drafts")
    .select(DRAFT_COLUMNS)
    .eq("conversation_id", conversationId)
    .eq("modo", "copiloto")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = ((data ?? []) as Record<string, unknown>[])[0];
  return row ? shadowDraftFromRow(row) : null;
}
