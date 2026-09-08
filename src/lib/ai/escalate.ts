import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, TablesUpdate } from "@/lib/supabase/database.types";
import { claimNextAvailableAgent } from "@/lib/ai/claim-agent";
import { recordHandoff } from "@/lib/ai/handoffs";
import { businessStatus, DEFAULT_BUSINESS_HOURS, type BusinessHours, type BusinessStatus } from "@/lib/business-hours";

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
  /**
   * Solo cuando `unassigned` es true: el horario calculado UNA vez acá con el
   * `now`/`businessHours` de este llamado (Frente B4, "El reloj dice la
   * verdad", 5/9/2026). `buildEscalateTool` (`tools.ts`) lo usa para armar la
   * despedida sin volver a calcular `businessStatus` con un reloj distinto.
   */
  businessStatus?: BusinessStatus;
}

export async function escalateConversation(
  supabase: SupabaseClient<Database>,
  params: {
    conversationId: string;
    contactId: string;
    motivo: EscalationMotivo;
    resumen: string;
    categoriaReclamo?: ReclamoCategory;
    /** Default: horario de lunes a viernes 8 am–6 pm (`DEFAULT_BUSINESS_HOURS`). */
    businessHours?: BusinessHours;
    /** Inyectable en tests; en producción es el reloj real. */
    now?: Date;
  }
): Promise<EscalateResult> {
  const {
    conversationId,
    contactId,
    motivo,
    resumen,
    categoriaReclamo,
    businessHours = DEFAULT_BUSINESS_HOURS,
    now = new Date(),
  } = params;

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
    // T2 (8/9/2026): cualquier escalación cierra una oferta de pase a ventas
    // pendiente, sea esta la puerta que la confirmó (`buildEscalateTool` con
    // motivo "intencion_compra" y el segundo "sí") o cualquiera de las otras
    // tres (devolución, queja, un escenario con afterSend = "escalate") que
    // pasan por acá SIN pasar por la reconfirmación. Limpiarlo acá, en el
    // único lugar donde toda escalación converge, evita tener que acordarse
    // de hacerlo en cada puerta por separado.
    handoff_confirmation_pending_at: null,
  };
  if (motivo === "intencion_compra") conversationUpdate.deal_status = "in_progress";

  await supabase.from("conversations").update(conversationUpdate).eq("id", conversationId);

  // Se calcula una sola vez, con el reloj y el horario de ESTE llamado, para
  // que el sufijo del evento y la instrucción que arma `buildEscalateTool`
  // cuenten la misma hora (Frente B4, "El reloj dice la verdad", 5/9/2026).
  const estadoHorario = businessStatus(now, businessHours);

  await supabase.from("messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "system",
    message_type: "system_event",
    is_internal_note: true,
    content: candidate
      ? `IA escaló a ${candidate.displayName}. Motivo: ${motivo}. ${resumen}`
      : `IA escaló sin asesores disponibles: nadie tiene asignada esta conversación todavía. Motivo: ${motivo}. ${resumen} (${estadoHorario.open ? "en horario" : "fuera de horario"})`,
  });

  // T0.3: el escalamiento es una salida silenciosa más de la IA (la
  // conversación deja de correr por el turno), así que también le toca su
  // fila de traspaso. Va DESPUÉS del update y de la nota — mismo orden que
  // ya tenían los tres pasos de esta función — para que la bitácora quede
  // detrás de un estado que ya es consistente, no a mitad de escribirlo.
  await recordHandoff(
    supabase,
    candidate
      ? { conversationId, toKind: "human", toId: candidate.id, reason: "escalada" }
      : { conversationId, toKind: "unassigned", reason: "escalada_sin_asesor" }
  );

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
        businessStatus: estadoHorario,
      };
}
