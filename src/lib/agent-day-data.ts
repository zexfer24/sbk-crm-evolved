import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// "Los números del día" (T3, 10/9/2026): lo que pinta el panel de inicio del
// asesor — su resumen del día (`fetchAgentDaySummary`, RPC `agent_day_summary`
// de la migración 20260910010000) y lo último que la IA le pasó
// (`fetchAiAssignmentsToday`, `conversation_handoffs`).
//
// Archivo aparte de `data.ts` (mismo patrón que `customers-data.ts`/
// `invoices-data.ts`/`stickers-data.ts`): son consultas de un panel concreto,
// no de la bandeja/chat.
// ---------------------------------------------------------------------------

/**
 * El resumen del día de un asesor: cuántas conversaciones le asignaron,
 * cuántas respondió y cuánto vendió, en el rango que le manda el llamador.
 */
export interface AgentDaySummary {
  asignadas: number;
  respondidas: number;
  ventas: number;
  montoUsd: number;
}

/** Fila cruda del RPC `agent_day_summary`: Postgres devuelve `bigint`/`numeric` como texto por PostgREST. */
interface RawAgentDaySummary {
  asignadas: string | number;
  respondidas: string | number;
  ventas: string | number;
  monto: string | number;
}

/**
 * El resumen del día de QUIEN LLAMA (`auth.uid()` decide adentro del RPC, no
 * un parámetro): asignadas, respondidas, ventas y monto en `[range.from,
 * range.to)`.
 *
 * El rango lo manda el cliente —típicamente `dayRangeFrom(useInboxDay(...))`
 * más abajo en este archivo— para que la medianoche del día tenga una sola
 * fuente, el mismo criterio que ya usa `since` en `fetchInboxCounts`/
 * `FetchConversationsOptions` (`data.ts`) y `message_activity_by_hour`:
 * recalcular la medianoche en un segundo sitio es lo que hace que dos
 * paneles no coincidan por un milisegundo.
 *
 * `agent_day_summary` siempre devuelve exactamente una fila (son subconsultas
 * escalares con `count(*)`/`coalesce(sum(...), 0)`, nunca un `group by` que
 * pueda quedar vacío) — el chequeo de "sin fila" de acá abajo es defensivo,
 * para no reventar el panel si algún día eso cambiara.
 */
export async function fetchAgentDaySummary(
  supabase: SupabaseClient,
  range: { from: string; to: string }
): Promise<AgentDaySummary | null> {
  const { data, error } = await supabase.rpc("agent_day_summary", {
    p_from: range.from,
    p_to: range.to,
  });
  if (error) throw error;

  const row = ((data ?? []) as RawAgentDaySummary[])[0];
  if (!row) {
    return { asignadas: 0, respondidas: 0, ventas: 0, montoUsd: 0 };
  }

  // Postgres devuelve numeric/bigint como texto para no perder precisión
  // (mismo motivo que `Number(row.monto_hoy)` en `fetchAgentMetrics`, data.ts).
  return {
    asignadas: Number(row.asignadas),
    respondidas: Number(row.respondidas),
    ventas: Number(row.ventas),
    montoUsd: Number(row.monto),
  };
}

/** Un traspaso de "la IA te acaba de asignar esto", ya resuelto para pintar una fila. */
export interface AiAssignment {
  handoffId: string;
  conversationId: string;
  contactName: string;
  createdAt: string;
}

interface RawAiAssignmentContact {
  display_name: string | null;
  profile_name: string | null;
  phone_number: string;
}

interface RawAiAssignmentConversation {
  contact: RawAiAssignmentContact | null;
}

interface RawAiAssignment {
  id: string;
  conversation_id: string;
  created_at: string;
  conversation: RawAiAssignmentConversation | null;
}

/**
 * Las últimas conversaciones que la IA le pasó a `agentId` hoy: filas de
 * `conversation_handoffs` con `to_kind = 'human'`, `to_id = agentId` y
 * `reason = 'escalada'`.
 *
 * `reason = 'escalada'` es el ÚNICO traspaso que significa "la IA ACABA de
 * entregarte esto" — ver el comentario de `isAssignmentNotice`
 * (`src/lib/assignment-notice.ts`): `asignada` (`lib/ai/agent.ts`) se escribe
 * CADA VEZ que llega un mensaje del cliente a una conversación que YA tiene
 * dueño (es la misma asignación de siempre reafirmándose, no una nueva), así
 * que filtrar solo por `to_kind`/`to_id` inflaría esta lista con conversación
 * viejas que el asesor ya viene atendiendo desde antes de hoy.
 *
 * `since` es el mismo string de "habló hoy" (`useInboxDay`/`currentDayRange`,
 * vía `dayRangeFrom` más abajo): una sola fuente para la medianoche, igual
 * que el resto del CRM.
 */
export async function fetchAiAssignmentsToday(
  supabase: SupabaseClient,
  agentId: string,
  since: string,
  limit = 5
): Promise<AiAssignment[]> {
  const { data, error } = await supabase
    .from("conversation_handoffs")
    .select(
      "id, conversation_id, created_at, conversation:conversations(contact:contacts(display_name, profile_name, phone_number))"
    )
    .eq("to_kind", "human")
    .eq("to_id", agentId)
    .eq("reason", "escalada")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return ((data ?? []) as unknown as RawAiAssignment[]).map((row) => {
    const contact = row.conversation?.contact ?? null;
    return {
      handoffId: row.id,
      conversationId: row.conversation_id,
      // Mismo orden que `mapContactName` (data.ts): nombre puesto por el
      // asesor, si no el que trae WhatsApp, si no el teléfono crudo.
      contactName: contact?.display_name ?? contact?.profile_name ?? contact?.phone_number ?? "",
      createdAt: row.created_at,
    };
  });
}

/**
 * De un `dayStart` en ISO (el mismo string que produce `useInboxDay`, la
 * ÚNICA fuente de la medianoche del día — ver su comentario) arma el rango
 * `[from, to)` que pide `agent_day_summary`: `to = from + 24 h`.
 *
 * `from` viaja tal cual llegó, sin volver a pasar por `Date`/`toISOString`:
 * reformatearlo no cambia el instante, pero si `dayStart` ya es la fuente
 * única, repetir el string es más simple que reconstruirlo.
 */
export function dayRangeFrom(dayStart: string): { from: string; to: string } {
  const to = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();
  return { from: dayStart, to };
}
