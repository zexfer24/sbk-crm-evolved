import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, TablesUpdate } from "@/lib/supabase/database.types";
import { claimNextAvailableAgent } from "@/lib/ai/claim-agent";

// ---------------------------------------------------------------------------
// Lógica compartida de escalamiento: la usa la herramienta que el modelo
// puede invocar (src/lib/ai/tools.ts) y la red de seguridad del orquestador
// (src/lib/ai/agent.ts) cuando el turno se queda sin pasos sin haber
// escalado en un motivo que lo exige. Vive aparte para no duplicar el
// reparto por turno ni la lógica de etiquetado de reclamos.
// ---------------------------------------------------------------------------

export const RECLAMO_CATEGORIES = ["Envío", "Pago", "Producto", "Atención", "Garantía"] as const;
export type ReclamoCategory = (typeof RECLAMO_CATEGORIES)[number];
/** `seguimiento`: postventa y logística — lo usan los escenarios predeterminados que piden un dato y pasan el caso a un humano. */
export type EscalationMotivo = "devolucion" | "queja" | "intencion_compra" | "seguimiento";

export interface EscalateResult {
  /** El caso salió de manos de la IA. Es true aunque no haya habido a quién asignárselo. */
  escalated: boolean;
  /** Null cuando no había ningún asesor activo. */
  assignedAgentName?: string | null;
  /** El caso quedó esperando a que alguien entre a trabajar. */
  unassigned?: boolean;
  reason?: string;
}

export async function escalateConversation(
  supabase: SupabaseClient<Database>,
  params: {
    conversationId: string;
    contactId: string;
    motivo: EscalationMotivo;
    resumen: string;
    categoriaReclamo?: ReclamoCategory;
  }
): Promise<EscalateResult> {
  const { conversationId, contactId, motivo, resumen, categoriaReclamo } = params;

  const candidate = await claimNextAvailableAgent(supabase);

  // Sin asesores la IA se pausa IGUAL. Dejarla encendida era peor por los dos
  // lados: cada mensaje del cliente disparaba otro turno completo que volvía
  // a intentar escalar y volvía a fallar —gasto puro— y el caso seguía sin
  // aparecer en ningún lado. Pausada y en 'assigned' queda esperando en la
  // bandeja a que alguien entre a trabajar.
  const conversationUpdate: TablesUpdate<"conversations"> = {
    ai_enabled: false,
    assigned_agent_id: candidate?.id ?? null,
    journey_stage: "assigned",
  };
  if (motivo === "intencion_compra") conversationUpdate.deal_status = "in_progress";

  await supabase.from("conversations").update(conversationUpdate).eq("id", conversationId);

  await supabase.from("messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "system",
    message_type: "system_event",
    is_internal_note: true,
    content: candidate
      ? `IA escaló a ${candidate.displayName}. Motivo: ${motivo}. ${resumen}`
      : `IA escaló sin asesores disponibles: nadie tiene asignada esta conversación todavía. Motivo: ${motivo}. ${resumen}`,
  });

  if (motivo === "queja") {
    const label = `Reclamo · ${categoriaReclamo ?? "Atención"}`;
    const { data: tag } = await supabase.from("tags").select("id").eq("label", label).maybeSingle();
    if (tag) {
      await supabase.from("contact_tags").upsert({ contact_id: contactId, tag_id: tag.id });
    }
  }

  return candidate
    ? { escalated: true, assignedAgentName: candidate.displayName }
    : {
        escalated: true,
        assignedAgentName: null,
        unassigned: true,
        reason: "No había asesores activos: la conversación quedó esperando en la bandeja.",
      };
}
