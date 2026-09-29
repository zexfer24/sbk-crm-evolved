import "server-only";
import { parseBusinessHours } from "@/lib/business-hours";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchTurnCatalogLinks } from "@/lib/ai/catalog-links";
import { fetchTurnLessons } from "@/lib/ai/lessons";
import { isConversationBusy, withConversationTurnLock } from "@/lib/ai/conversation-lock";
import {
  asesorEscribioDespuesDe,
  newDemoraTurno,
  newTurnTiming,
  runTurnPhases,
} from "@/lib/ai/agent";
import { buildTurnTarget, type AgentConversation, type TurnTarget } from "@/lib/ai/turn-target";
import { newTurnDelivery } from "@/lib/ai/turn-delivery";
import { conTelemetriaDeTurno } from "@/lib/ai/turn-telemetry";
import { withinFreeformWindow } from "@/lib/dashboard";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// "Nadie sin atender" (T10b-3, Entrega B del plan "Seba encuentra, no insiste,
// y el mostrador no deja a nadie esperando", 29/9/2026, D1/D2 del operador): el
// turno de Seba POR DEMORA.
//
// Cuando `evaluarDemora` (`demora.ts`) decide `responder` -- el cliente lleva
// 10 min sin que una persona le escriba --, el cron (`demora-cron.ts`) reclama
// el episodio en `conversation_delay_episodes` y llama a esta función. Es un
// camino PROPIO, fuera de la cola de turnos: la cola no distingue "tipo de
// turno" (el ZSET guarda solo el `conversationId`) y sus guardas de apertura
// (`ai_enabled`, `humanHasWritten`) son justo las que este turno se salta.
//
// Qué respeta y qué se salta, contra `runAgentTurn`:
//   - RESPETA `agent_can_run()` (interruptor global y tope de gasto de la IA),
//     al abrir y otra vez justo antes de enviar. Un ERROR de la RPC lanza
//     (infraestructura), igual que en el turno normal: solo un `false` real es
//     una decisión.
//   - RESPETA el lock por conversación: si otro turno la tiene, devuelve
//     `turno_en_curso` en vez de correr dos a la vez.
//   - RESPETA la ventana de 24 h de Meta.
//   - SE SALTA `ai_enabled` (D2: responde con la IA pausada) y la gracia de
//     `humanHasWritten` (un asesor que escribió hace 20 min y dejó al cliente
//     esperando no impide que Seba conteste). Su ÚNICA puerta de envío es
//     "un asesor escribió DESPUÉS del último mensaje del cliente"
//     (`asesor_ya_respondio`), al abrir y otra vez justo antes de enviar.
//   - NO cambia `ai_enabled`, no reactiva la IA y no toca
//     `conversation_delay_episodes`: el episodio ya lo reclamó el cron.
//
// El resto -- sin escalada por ningún camino, sin saludo, escenarios solo
// `disponibleEnEspera`, sufijo del prompt con los límites -- vive en
// `runTurnPhases` (agent.ts), donde `modo demora` se activa con el
// `DemoraTurno` que arma esta función.
//
// Contrato con el cron (no cambiarlo sin avisarle a T10b-4): NUNCA lanza por un
// "no corresponde" -- devuelve `{ enviado: false, motivo }` --; SÍ lanza ante un
// error de infraestructura (RPC de `agent_can_run` o lectura de la
// conversación que fallan, consulta del asesor que falla), y en ese caso NO se
// envió nada, así que reintentar es seguro.
// ---------------------------------------------------------------------------

export interface DelayTurnOptions {
  /** El `episode_at` del episodio (la clave del candado del cron). Solo va al log. */
  episodeAt: Date;
  /** Minutos que el cliente lleva esperando: van a la nota interna y al prompt. */
  esperaMinutos: number;
  /** El instante del turno. Se inyecta en las pruebas; en producción es ahora. */
  now?: Date;
}

export interface DelayTurnResult {
  /** `true` si el mensaje de Seba SALIÓ (o Meta lo aceptó). */
  enviado: boolean;
  /**
   * Cuando `enviado`: `respuesta_del_modelo`, `escenario` o `texto_fijo`.
   * Cuando no: `conversacion_inexistente`, `agente_no_puede_correr`,
   * `sin_mensaje_del_cliente`, `fuera_de_ventana`, `asesor_ya_respondio`,
   * `turno_en_curso`, `identidad_no_verificable`, `lock_perdido`,
   * `sin_contenido_legible`, `sin_mensaje_pendiente` o `envio_fallido`.
   */
  motivo: string;
}

export function runDelayTurn(conversationId: string, opts: DelayTurnOptions): Promise<DelayTurnResult> {
  // Igual que `runAgentTurn`: el registro de llamadas al proveedor de ESTE
  // turno se abre antes de tocar nada, así `agent_turn_calls` lo recoge.
  return conTelemetriaDeTurno(() => runDelayTurnBody(conversationId, opts));
}

async function runDelayTurnBody(conversationId: string, opts: DelayTurnOptions): Promise<DelayTurnResult> {
  const supabase = createAdminClient();
  const now = opts.now ?? new Date();

  const [
    { data: canRun, error: canRunError },
    { data: conversation, error: conversationError },
    { data: settingsRow, error: settingsError },
    lessons,
    links,
  ] = await Promise.all([
    supabase.rpc("agent_can_run"),
    // Las mismas columnas que la apertura del turno normal: `runTurnPhases`
    // las lee todas del `convo`.
    supabase
      .from("conversations")
      .select(
        "id, contact_id, ai_enabled, assigned_agent_id, welcome_sent_at, last_customer_message_at, ai_resume_cutoff_at, deal_status, contact:contacts(phone_number, display_name, profile_name), channel:whatsapp_channels(phone_number_id, status)"
      )
      .eq("id", conversationId)
      .maybeSingle(),
    supabase.from("agent_settings").select("business_hours").eq("id", true).maybeSingle(),
    fetchTurnLessons(supabase, conversationId),
    fetchTurnCatalogLinks(supabase, conversationId),
  ]);

  // Un ERROR de la RPC no es un "no": lanza (la cola hace lo mismo en el turno
  // normal, `turno_interruptor_no_consultable`). El cron decide si reintenta.
  if (canRunError) {
    log.error("turno_interruptor_no_consultable", { conversationId, detail: errorText(canRunError), modo: "demora" });
    throw new Error(`agent_can_run no consultable: ${errorText(canRunError)}`, { cause: canRunError });
  }
  if (conversationError) {
    log.error("turno_conversacion_no_consultable", {
      conversationId,
      detail: errorText(conversationError),
      modo: "demora",
    });
    throw new Error(`conversación no consultable: ${errorText(conversationError)}`, { cause: conversationError });
  }
  if (settingsError) {
    log.warn("turno_horario_no_legible", { conversationId, detail: settingsError.message });
  }
  const businessHours = parseBusinessHours(settingsRow?.business_hours ?? undefined);

  const convo = conversation as unknown as AgentConversation | null;
  if (!convo) return noEnviado(conversationId, "conversacion_inexistente");

  // Ningún traspaso en estas salidas: el dueño de la conversación no cambió, y
  // `evaluarDemora` + la fila del episodio ya son el rastro. Un traspaso a
  // "sin dueño" sacaría de "Tuyas" un chat que sigue teniendo asesor.
  if (!canRun) return noEnviado(conversationId, "agente_no_puede_correr");

  const lcma = convo.last_customer_message_at;
  if (lcma === null) return noEnviado(conversationId, "sin_mensaje_del_cliente");

  // Pasadas 24 h del último mensaje del cliente, Meta rechaza el texto libre.
  if (!withinFreeformWindow(lcma, now.getTime())) return noEnviado(conversationId, "fuera_de_ventana");

  // La puerta de envío, mirada YA para no gastar clasificación ni redacción en
  // un mensaje que no va a salir. `deliver` (agent.ts) la vuelve a mirar justo
  // antes de enviar. Lanza si la consulta falla (infraestructura).
  if (await asesorEscribioDespuesDe(supabase, conversationId, lcma)) {
    return noEnviado(conversationId, "asesor_ya_respondio");
  }

  let target: TurnTarget;
  try {
    target = buildTurnTarget(conversationId, convo);
  } catch (err) {
    log.error("turno_identidad_no_verificable", { conversationId, detail: errorText(err), modo: "demora" });
    return noEnviado(conversationId, "identidad_no_verificable");
  }

  const demora = newDemoraTurno(opts.esperaMinutos, now);
  const entrega = newTurnDelivery();
  const tiempos = newTurnTiming(lcma);

  try {
    await withConversationTurnLock(supabase, conversationId, async (lease) => {
      await runTurnPhases(supabase, target, convo, entrega, lease, tiempos, businessHours, links, lessons, demora);
    });
  } catch (err) {
    // Otro turno tiene la conversación: no es un error, es una carrera normal
    // (un webhook casi simultáneo). Ese turno o el cron de la próxima pasada
    // decidirán; acá no se corre un segundo a la vez.
    if (isConversationBusy(err)) return noEnviado(conversationId, "turno_en_curso");

    // Falló DESPUÉS de intentar entregar: el mensaje pudo haber salido, y
    // reintentar lo duplicaría (regla de `turn-delivery.ts`). No se relanza.
    if (entrega.intentado) {
      log.error("demora_fallo_tras_envio", { conversationId, detail: errorText(err) });
      return { enviado: true, motivo: "fallo_tras_envio" };
    }

    // Falló ANTES de enviar nada: es reintentable, y se lo dejamos al cron.
    throw err;
  }

  if (demora.enviado) return { enviado: true, motivo: demora.motivo ?? "respuesta_del_modelo" };
  return noEnviado(conversationId, demora.motivo ?? "sin_respuesta");
}

function noEnviado(conversationId: string, motivo: string): DelayTurnResult {
  log.info("demora_sin_respuesta", { conversationId, motivo });
  return { enviado: false, motivo };
}
