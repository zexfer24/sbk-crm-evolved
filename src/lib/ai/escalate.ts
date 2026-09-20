import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, TablesUpdate } from "@/lib/supabase/database.types";
import { claimNextAvailableAgent } from "@/lib/ai/claim-agent";
import { recordHandoff } from "@/lib/ai/handoffs";
import { businessStatus, DEFAULT_BUSINESS_HOURS, type BusinessHours, type BusinessStatus } from "@/lib/business-hours";
import { log } from "@/lib/log";

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
/**
 * T3, "Seba atiende el mostrador" (18/9/2026, requisitos 2/3/4 del cliente):
 * suman `confirmar_inventario` (repuesto encontrado con existencia),
 * `sin_stock` (el catálogo marca cero) y `no_identificado` (no se encontró
 * nada, o no quedó claro cuál repuesto es) — los tres motivos con los que
 * `buildCatalogTool` (tools.ts) le dice al modelo que escale tras cotizar, y
 * con los que la red de seguridad de `agent.ts` escala en código si el
 * modelo se queda sin pasos antes de hacerlo. No hay `consulta_generica`: el
 * caso genérico (sin marca ni modelo de moto) pide UNA pregunta de filtro y
 * a propósito NO escala en ese turno (requisito 5, la única pregunta).
 * `motivo` no tiene CHECK en la base (viaja solo en el texto del
 * `system_event` y en `agent_turns.summary`, hallazgo 7 del plan): sumar un
 * valor acá no exige migración.
 */
export type EscalationMotivo =
  | "devolucion"
  | "queja"
  | "intencion_compra"
  | "seguimiento"
  | "confirmar_inventario"
  | "sin_stock"
  | "no_identificado";

/**
 * E (20/9/2026, "El resguardo antes del push", C3): la rama `yaAsignado` de
 * `escalateConversation` retornaba ANTES de este bloque — con la IA
 * encendida tras escalar (D2, "Seba atiende el mostrador", 18/9/2026), una
 * queja sobre un chat YA asignado (segunda o siguiente consulta del mismo
 * cliente) no recibía la etiqueta "Reclamo · …" y por lo tanto no aparecía
 * en la cola de Reclamos (`dashboard.ts`, que la arma solo con etiquetas
 * que empiezan por "Reclamo"). Se extrae a un helper para llamarlo desde
 * las DOS ramas sin duplicar la consulta.
 */
async function tagAsReclamoIfNeeded(
  supabase: SupabaseClient<Database>,
  motivo: EscalationMotivo,
  categoriaReclamo: ReclamoCategory | undefined,
  contactId: string
) {
  if (motivo !== "queja") return;
  const label = `Reclamo · ${categoriaReclamo ?? "Atención"}`;
  const { data: tag } = await supabase.from("tags").select("id").eq("label", label).maybeSingle();
  if (tag) {
    await supabase.from("contact_tags").upsert({ contact_id: contactId, tag_id: tag.id });
  }
}

export interface EscalateResult {
  /** El caso salió de manos de la IA. Es true aunque no haya habido a quién asignárselo. */
  escalated: boolean;
  /** Null cuando no había ningún asesor activo. */
  assignedAgentName?: string | null;
  /** El caso quedó esperando a que alguien entre a trabajar. */
  unassigned?: boolean;
  reason?: string;
  /**
   * El horario calculado UNA vez acá con el `now`/`businessHours` de este
   * llamado (Frente B4, "El reloj dice la verdad", 5/9/2026). Hasta el
   * 14/9/2026 solo viajaba cuando `unassigned` era true —la despedida SIN
   * asesor era la única que necesitaba decir cuándo—, pero la Tarea 5 ("La
   * voz cercana y la espera visible") encontró la misma falla del lado CON
   * asesor: 170 promesas "ya te paso con un asesor" en 72 h, 23 de ellas con
   * la tienda ya cerrada y sin decir cuándo volvía a abrir. Como ya se
   * calculaba siempre (`businessStatus(now, businessHours)`, dos líneas más
   * abajo), devolverlo siempre —con asesor o sin él— no cuesta nada extra:
   * `escalationInstruction`/`despedidaConAsesor` (`tools.ts`/`agent.ts`) lo
   * usan para armar la despedida sin volver a calcular `businessStatus` con
   * un reloj distinto.
   */
  businessStatus?: BusinessStatus;
  /**
   * T4, "Seba atiende el mostrador" (18/9/2026, decisión D2/D3, hallazgo 3
   * del plan): `true` cuando el chat YA tenía asesor asignado al entrar a
   * esta función — no se reclamó a nadie nuevo. Con la IA encendida tras
   * escalar (ver más abajo), el modelo puede volver a llamar a esta misma
   * herramienta en cada consulta de inventario (las reglas 3/4 del prompt
   * escalan con o sin existencia); sin esta rama cada pregunta del cliente
   * reasignaría el chat por round-robin a OTRO asesor, quitándoselo al que
   * ya lo tenía. `assignedAgentName` sigue trayendo el nombre de quien ya
   * lo tenía, para que la despedida no cambie de forma entre la primera
   * escalada y las siguientes.
   */
  alreadyAssigned?: boolean;
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

  // Se calcula una sola vez, con el reloj y el horario de ESTE llamado, para
  // que el sufijo del evento y la instrucción que arma `buildEscalateTool`
  // cuenten la misma hora (Frente B4, "El reloj dice la verdad", 5/9/2026).
  const estadoHorario = businessStatus(now, businessHours);

  // T4, "Seba atiende el mostrador" (18/9/2026, D2/D3, hallazgo 3 del plan):
  // antes de reclamar a nadie, mirar si el chat YA tiene asesor. Con la IA
  // encendida tras escalar (ver más abajo: el UPDATE ya no toca
  // `ai_enabled`), el modelo puede volver a llamar a esta misma función en
  // cada consulta de inventario del cliente —las reglas 3/4 del prompt
  // escalan con existencia o sin ella—, y `claimNextAvailableAgent` reparte
  // por round-robin: sin esta lectura, cada pregunta nueva le quitaría el
  // chat al asesor que ya lo tenía para dárselo a otro. `ai_enabled` viaja
  // en el mismo `select` porque en teoría podría haberse apagado en la
  // misma fracción de segundo (un asesor que escribe justo cuando el modelo
  // ya decidió llamar a esta herramienta) — no cambia ninguna rama de acá
  // abajo (el turno que sigue en vuelo ya tiene sus propias guardas contra
  // esa carrera en `deliver()`), pero si ocurriera de todos modos queda
  // dicho en el registro en vez de pasar inadvertido.
  const { data: current, error: currentError } = await supabase
    .from("conversations")
    .select("assigned_agent_id, ai_enabled, assigned_agent:agents!conversations_assigned_agent_id_fkey(id, display_name)")
    .eq("id", conversationId)
    .maybeSingle();

  if (currentError) {
    log.error("escalada_estado_previo_no_legible", { conversationId, detail: currentError.message });
  }

  const yaAsignado =
    current?.assigned_agent_id != null
      ? { id: current.assigned_agent_id, displayName: current.assigned_agent?.display_name ?? "un asesor" }
      : null;

  if (yaAsignado) {
    if (current?.ai_enabled === false) {
      // No debería darse: si la IA ya estaba apagada en este chat, el turno
      // que llegó hasta acá tendría que haberse cortado en la guarda de
      // apertura de `runAgentTurn` antes de invocar ninguna herramienta.
      // Queda dicho por si una carrera lo produce de todos modos.
      log.warn("escalada_repetida_con_ia_silenciada", { conversationId });
    }

    if (motivo === "intencion_compra") {
      await supabase.from("conversations").update({ deal_status: "in_progress" }).eq("id", conversationId);
    }

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      direction: "outbound",
      sender_type: "system",
      message_type: "system_event",
      is_internal_note: true,
      content: `IA reiteró la escalada a ${yaAsignado.displayName}. Motivo: ${motivo}. ${resumen}`,
    });

    // E (20/9/2026): la queja SÍ se etiqueta también en esta rama — ver el
    // comentario de `tagAsReclamoIfNeeded` más arriba.
    await tagAsReclamoIfNeeded(supabase, motivo, categoriaReclamo, contactId);

    // Sin `recordHandoff`: reasignar el MISMO asesor no es un traspaso — el
    // aviso de asignación (`assignment-notice.ts`) solo dispara con la razón
    // `escalada`, y volver a escribirla en cada pregunta lo haría saltar de
    // nuevo sin que nada haya cambiado de dueño de verdad.
    return { escalated: true, assignedAgentName: yaAsignado.displayName, alreadyAssigned: true, businessStatus: estadoHorario };
  }

  const candidate = await claimNextAvailableAgent(supabase);

  // D2 (18/9/2026, "Seba atiende el mostrador", requisito 6 del cliente): el
  // UPDATE deja de tocar `ai_enabled`. Hasta esta corrida se apagaba acá
  // mismo ("Sin asesores la IA se pausa IGUAL" — dejarla encendida sin
  // asesor volvía a intentar escalar en cada mensaje). Ahora la IA sigue
  // contestando DESPUÉS de escalar, con o sin asesor (P1: de noche o un
  // domingo sin nadie conectado, Seba sigue vendiendo) — lo que apaga
  // `ai_enabled` es el asesor mandando su primer mensaje REAL
  // (`handle_agent_message_silences_ai`, migración 20260917010000) o la
  // pausa manual, nunca esta función. El freno contra el bucle de
  // reescalar en cada mensaje sin asesor ya no es `ai_enabled=false`: es el
  // predicado nuevo del reconciliador (hallazgo 2 del plan, `reconciler.ts`)
  // y la rama `yaAsignado` de arriba (hallazgo 3).
  const conversationUpdate: TablesUpdate<"conversations"> = {
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

  await tagAsReclamoIfNeeded(supabase, motivo, categoriaReclamo, contactId);

  return candidate
    ? { escalated: true, assignedAgentName: candidate.displayName, businessStatus: estadoHorario }
    : {
        escalated: true,
        assignedAgentName: null,
        unassigned: true,
        reason: "No había asesores activos: la conversación quedó esperando en la bandeja.",
        businessStatus: estadoHorario,
      };
}
