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
//   - NO toca `conversation_delay_episodes`: el episodio ya lo reclamó el cron.
//   - REACTIVA la IA (cambio de diseño del operador, 29/9/2026, reemplaza la
//     regla de D2 "no reactiva la IA"): "Si Seba va a responder a los 10 minutos
//     porque ningún asesor respondió, activa nuevamente la IA y que mande la
//     respuesta, esto no debe colisionar; además nos aseguramos que la IA se
//     reactive sola porque los asesores no reactivan la IA luego de hablar con
//     el cliente". Si `ai_enabled` era false, DESPUÉS de enviar con éxito y de
//     marcar "visto hasta", todavía DENTRO del lock, un UPDATE propio y
//     condicionado (`where ai_enabled = false`, con las filas afectadas
//     verificadas) la vuelve a encender. Ver `reactivarIA`, abajo, para el
//     porqué de cada guarda y del orden.
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
  // Se anota ANTES de correr: la pregunta es "¿estaba apagada cuando este turno
  // empezó?", no lo que diga la conversación cuando termine.
  const iaEstabaApagada = !convo.ai_enabled;

  try {
    await withConversationTurnLock(supabase, conversationId, async (lease) => {
      try {
        await runTurnPhases(supabase, target, convo, entrega, lease, tiempos, businessHours, links, lessons, demora);
      } finally {
        // En `finally`: si algo lanza DESPUÉS de que el mensaje salió (una
        // etiqueta, la bitácora), el cliente ya recibió la respuesta y la IA
        // tiene que quedar encendida igual -- el cron no reintenta este
        // episodio (`responded_at` ya está reclamado). `demora.enviado` solo es
        // true si el envío salió y Meta no lo rechazó.
        if (iaEstabaApagada && demora.enviado) {
          await reactivarIA(supabase, conversationId, lcma, opts.esperaMinutos, Boolean(convo.assigned_agent_id));
        }
      }
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

/**
 * Vuelve a encender la IA de una conversación cuyo cliente acaba de recibir la
 * respuesta por demora de Seba. Nunca lanza: el mensaje ya salió, y un fallo acá
 * no puede convertir eso en un turno fallido (el cron lo reintentaría y el
 * cliente recibiría dos respuestas). Si no se pudo, queda `log.error` y la IA
 * sigue apagada -- exactamente como antes de este cambio, no peor.
 *
 * Por qué así y no de otra forma (29/9/2026, "esto no debe colisionar"):
 *   - DESPUÉS de enviar, nunca antes. Con la IA encendida a mitad del envío, un
 *     turno normal de la cola que lee la conversación en ese instante ya no se
 *     corta en `pausada` y contesta el MISMO mensaje que Seba está mandando.
 *   - DENTRO del lock, y después de que `runTurnPhases` dejó la marca "visto
 *     hasta" en Redis: el turno normal que esperaba el lock la encuentra y sale
 *     por `turno_sin_mensaje_nuevo`. Sin asesor asignado, además, el trigger
 *     `handle_conversation_ai_resume` sella `ai_resume_cutoff_at` con este mismo
 *     mensaje y el turno normal sale por `mensaje_previo_a_devolucion`; con
 *     asesor el trigger no sella y el freno es la marca (medido en
 *     `supabase/tests/reactivacion_por_demora.sql`). Un mensaje NUEVO del cliente
 *     queda por delante de las dos y Seba lo atiende normal.
 *   - Relectura fresca antes del UPDATE. (1) Si el cliente escribió un mensaje
 *     nuevo mientras el turno corría, NO se reactiva: sin asesor el trigger
 *     sellaría ese mensaje como "anterior a la devolución" y Seba lo callaría;
 *     su propio episodio de demora lo atiende a los 10 min. (2) Si un asesor
 *     escribió de verdad después del mensaje del cliente, tampoco: la IA
 *     encendida le pisaría la conversación que acaba de tomar.
 *   - UPDATE propio, condicionado a `ai_enabled = false` y con las filas
 *     afectadas verificadas: si alguien ya la había encendido, 0 filas, sin nota
 *     y sin fila de bitácora de más. Un solo reintento ante un error de base.
 *   - No es una mutación del asesor: el trigger deja `devuelto_a_ia` con
 *     `created_by = 'system'` (corre con `service_role`, sin sesión), y esa fila
 *     es la que `demora.ts` reconoce para no darla por cierre de la escalada.
 *     Cualquier mensaje real de un asesor sigue apagando la IA por trigger.
 */
async function reactivarIA(
  supabase: ReturnType<typeof createAdminClient>,
  conversationId: string,
  ultimoMensajeDelCliente: string,
  esperaMinutos: number,
  conAsesorAsignado: boolean
): Promise<void> {
  try {
    const { data: fresca, error: lecturaError } = await supabase
      .from("conversations")
      .select("ai_enabled, last_customer_message_at")
      .eq("id", conversationId)
      .maybeSingle();
    if (lecturaError) throw new Error(`conversación no legible: ${errorText(lecturaError)}`);
    if (!fresca) return;
    if (fresca.ai_enabled) return sinReactivar(conversationId, "ya_estaba_encendida");
    if (
      fresca.last_customer_message_at === null ||
      Date.parse(fresca.last_customer_message_at) !== Date.parse(ultimoMensajeDelCliente)
    ) {
      return sinReactivar(conversationId, "cliente_escribio_de_nuevo");
    }
    if (await asesorEscribioDespuesDe(supabase, conversationId, ultimoMensajeDelCliente)) {
      return sinReactivar(conversationId, "asesor_escribio");
    }

    let filas: { id: string }[] | null = null;
    let ultimoError: unknown = null;
    for (let intento = 1; intento <= 2 && filas === null; intento++) {
      const { data, error } = await supabase
        .from("conversations")
        .update({ ai_enabled: true })
        .eq("id", conversationId)
        .eq("ai_enabled", false)
        .select("id");
      if (error) ultimoError = error;
      else filas = data ?? [];
    }
    if (filas === null) throw new Error(`no se pudo encender la IA: ${errorText(ultimoError)}`);
    if (filas.length === 0) return sinReactivar(conversationId, "ya_estaba_encendida");

    log.info("ia_reactivada_por_demora", { conversationId, esperaMinutos, conAsesorAsignado });

    // Nota aparte de la de `registrarRespuestaPorDemora`: esa se escribe al
    // enviar y esta solo si la IA quedó encendida de verdad. `sender_type =
    // 'system'`, nunca 'agent': un mensaje de asesor apagaría la IA que
    // acabamos de encender (`handle_agent_message_silences_ai`).
    const { error: notaError } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      direction: "outbound",
      sender_type: "system",
      message_type: "system_event",
      is_internal_note: true,
      content: `Seba reactivó la IA en este chat: nadie le había escrito al cliente en ${esperaMinutos} min. Seguirá atendiendo hasta que un asesor escriba.`,
    });
    if (notaError) log.warn("demora_nota_no_escrita", { conversationId, detail: errorText(notaError), nota: "reactivacion" });
  } catch (err) {
    log.error("ia_reactivada_por_demora_fallida", { conversationId, detail: errorText(err) });
  }
}

function sinReactivar(conversationId: string, motivo: string): void {
  log.info("ia_no_reactivada", { conversationId, motivo });
}

function noEnviado(conversationId: string, motivo: string): DelayTurnResult {
  log.info("demora_sin_respuesta", { conversationId, motivo });
  return { enviado: false, motivo };
}
