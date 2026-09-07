import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRedis } from "@/lib/redis";
import { freeformWindowCutoff } from "@/lib/dashboard";
import { enqueueAgentTurns } from "@/lib/ai/queue";
import { recordHandoff } from "@/lib/ai/handoffs";
import { conversationsWrittenByHumans } from "@/lib/ai/human-handled";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// El reconciliador de turnos huérfanos.
//
// Hasta el 30/8/2026 la única red de seguridad era el cron que drena la cola
// de Redis (`processQueuedTurns`, ver `src/app/api/cron/process-queue`). Eso
// cubre el turno que quedó ENCOLADO y no se procesó. No cubre el turno que
// nunca llegó a encolarse de verdad: un reinicio de Redis sin persistencia,
// un `flushdb` accidental, un proceso que murió entre escribir el mensaje y
// encolar el turno. El único que encola es el webhook, y esa ventana ya
// pasó — el cliente escribió y nadie vuelve a mirar esa conversación NUNCA,
// porque nada la vuelve a poner en la cola.
//
// La corrección: Postgres, no Redis, es la fuente de verdad de "quién sigue
// esperando". `conversations` ya sabe perfectamente quién espera —columna
// generada `awaiting_reply`— sin depender de que Redis se acuerde de nada.
// Cada pasada relee esa verdad y reencola lo que falte.
//
// El predicado de abajo es una copia deliberada del de `unansweredFreeWork`
// (src/lib/data.ts, ~línea 1719), no una importación: esa función no está
// exportada, y data.ts está fuera del alcance de esta tarea (otra tarea lo
// está tocando en paralelo). Si el predicado de allá cambia, este se queda
// desincronizado — es el costo aceptado de no ampliar el alcance.
// ---------------------------------------------------------------------------

/**
 * Misma clave que `QUEUE_KEY` en `redis-queue.ts`. Ese archivo tampoco está
 * en el alcance de esta tarea y no exporta la clave, así que se duplica el
 * literal en vez de tocarlo — mismo criterio que ya usa
 * `src/lib/ai/queue-limit.test.ts` para limpiar la cola entre pruebas.
 */
export const RECONCILE_QUEUE_KEY = "liminal:agent:turns";

/**
 * Tope de conversaciones reencoladas por pasada.
 *
 * Tras un incidente largo puede haber cientos de conversaciones esperando a
 * la vez. Soltarlas todas de golpe reventaría los cupos de turnos simultáneos
 * y el ritmo por minuto hacia el proveedor (ver `queue.ts`): esos frenos
 * están pensados para el goteo normal de mensajes entrantes, no para un
 * alud. Se recuperan de a 50, una vez por pasada del cron (cada 5 minutos).
 */
export const RECONCILE_BATCH_LIMIT = 50;

export interface ReconcileResult {
  /** Candidatas que trajo la consulta, ya con el tope de la pasada aplicado. */
  revisadas: number;
  /** Ya estaban en la cola de Redis: no se tocan, no cuentan como encoladas. */
  yaEnCola: number;
  /** Tenían un turno de IA corriendo ahora mismo (lock vigente): no se tocan. */
  bloqueadasPorLock: number;
  /** Las descartó el filtro de "ya escribió una persona": ver el comentario en el cuerpo. */
  atendidasPorHumanos: number;
  /** Las que de verdad se reencolaron en esta pasada. */
  encoladas: number;
}

const EMPTY_RESULT: ReconcileResult = {
  revisadas: 0,
  yaEnCola: 0,
  bloqueadasPorLock: 0,
  atendidasPorHumanos: 0,
  encoladas: 0,
};

interface CandidateRow {
  id: string;
  ai_turn_lock_until: string | null;
  last_customer_message_at: string | null;
}

/** Mismo criterio que `conversation-lock.ts`: null o vencido = libre. */
function lockIsActive(until: string | null, now: number): boolean {
  if (!until) return false;
  return new Date(until).getTime() > now;
}

/**
 * Relee Postgres, reencola lo que la cola perdió y deja dicho el porqué.
 *
 * `supabase` la trae quien llama (el cron) porque el reconciliador no tiene
 * sesión propia — igual que `fetchBacklogConversationIds` en `data.ts`. No
 * lanza: un fallo de consulta o de Redis se registra y devuelve el resumen
 * en cero, para que una pasada de reconciliación fallida no tumbe el resto
 * del cron (que todavía tiene que drenar la cola).
 */
/**
 * T0.3 (5/9/2026): el CHECK de `conversation_handoffs.reason` sumó
 * `escalada`, `escalada_sin_asesor` y `rechazado_por_meta`. Ninguna de las
 * tres le cambia nada a esta función: el predicado de abajo nunca lee
 * `conversation_handoffs` —ni `reason` ni `to_kind`—, solo columnas de
 * `conversations` (`awaiting_reply`, `assigned_agent_id`, `status`,
 * `ai_enabled`, `last_customer_message_at`). Una conversación que quedó
 * huérfana por `rechazado_por_meta` se rescata exactamente igual que una que
 * quedó huérfana por `entrega_fallida` o por `pausada`: lo único que importa
 * es en qué estado quedó la fila de `conversations`, no por qué motivo llegó
 * ahí. (El único lugar del sistema que sí mira `to_kind` —nunca `reason`— es
 * `unassigned_waiting_count()`, el KPI de "Sin dueño"; ver
 * 20260830040000_conversation_handoffs.sql.)
 */
export async function reconcileOrphanTurns(
  supabase: SupabaseClient,
  now: number = Date.now()
): Promise<ReconcileResult> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, ai_turn_lock_until, last_customer_message_at")
    .eq("awaiting_reply", true)
    .is("assigned_agent_id", null)
    .neq("status", "closed")
    .eq("ai_enabled", true)
    // Fuera de esta ventana Meta rechaza el texto libre: no hay nada que
    // reencolar, encolarlo solo movería el problema a un turno que
    // `withinFreeformWindow` va a rechazar igual (ver agent.ts).
    .gt("last_customer_message_at", freeformWindowCutoff(now))
    // Más reciente primero, igual que `fetchBacklogConversationIds`: quien
    // escribió hace un rato tiene más chances de seguir del otro lado.
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(RECONCILE_BATCH_LIMIT);

  if (error) {
    log.error("reconciliador_consulta_fallida", { detail: errorText(error) });
    return EMPTY_RESULT;
  }

  // Tope defensivo además del `.limit()` de la consulta: si algún día la
  // consulta cambia y deja de traerlo, o un intermediario lo ignora, esto
  // sigue sin poder soltar más de RECONCILE_BATCH_LIMIT de una vez.
  const candidatas = ((data ?? []) as unknown as CandidateRow[]).slice(0, RECONCILE_BATCH_LIMIT);

  let bloqueadasPorLock = 0;
  const sinLock: { id: string; lastCustomerMessageAt: string | null }[] = [];
  for (const fila of candidatas) {
    if (lockIsActive(fila.ai_turn_lock_until, now)) {
      // Un turno de IA está corriendo ahora mismo para esta conversación
      // (proceso vivo, no huérfano): tocarla la duplicaría. Si de verdad es
      // un turno zombi, el lease vence solo (ver conversation-lock.ts) y una
      // pasada futura la recoge.
      bloqueadasPorLock++;
    } else {
      sinLock.push({ id: fila.id, lastCustomerMessageAt: fila.last_customer_message_at });
    }
  }

  // Un chat que un asesor está atendiendo AHORA es de ese asesor, aunque no
  // se haya asignado el chat. `assigned_agent_id is null` NO alcanza para
  // detectarlo: el asesor que contesta sin asignarse deja la conversación
  // libre a los ojos de la consulta de arriba.
  //
  // Sin este filtro el reconciliador entra en un bucle perpetuo, y es un
  // bucle silencioso: encola la conversación, `runAgentTurn` la descarta por
  // su propia guarda de `humanHasWritten` —así que el cliente NUNCA recibe
  // nada indebido, esa parte está a salvo—, la conversación sigue con
  // `awaiting_reply` porque el cliente escribió último, y cinco minutos
  // después el cron la vuelve a encolar. Cada vuelta gasta un cupo de turno y
  // escribe una fila de bitácora, para siempre.
  //
  // Hasta el 8/9/2026 existía OTRA puerta al mismo bucle, más difícil de ver
  // porque no pasaba por `humanHasWritten`: el turno que salía por historial
  // vacío (`if (history.length === 0) return;` en `agent.ts`) lo hacía SIN
  // escribir traspaso — caso `cea69118…`, un audio sin texto previo, 30
  // reencolados seguidos hasta que un asesor contestó a mano. La corrida "La
  // IA ve lo que llega" la cerró en dos frentes: T2 hace que un audio, foto,
  // video, documento o sticker ya produzcan una línea de historial (vía
  // `historyLine`), así que esa salida casi nunca se da; y T4 hace que,
  // cuando se dé igual, deje traspaso `sin_contenido_legible` y limpie
  // `journey_stage` — el reconciliador ya no la vuelve a encontrar como
  // huérfana sin dueño ni fecha.
  //
  // T7 (misma corrida, 8/9/2026) cambió el alcance temporal de la guarda de
  // acá abajo: hasta entonces preguntaba "¿alguna vez escribió un asesor?",
  // así que una conversación con una nota vieja de semanas quedaba fuera del
  // reconciliador para siempre, aunque el cliente hubiera vuelto a escribir
  // días después y ningún humano estuviera mirando el chat. Ahora
  // `conversationsWrittenByHumans` recibe también `last_customer_message_at`
  // de cada fila y aplica `humanClaimsChat` (human-handled.ts): bloquea solo
  // si el asesor se adelantó al último mensaje del cliente o si escribió en
  // los últimos `AI_HUMAN_GRACE_MINUTES` (G=30 por default) — "¿lo está
  // tocando AHORA?", no "¿lo tocó algún día?".
  //
  // Es exactamente el mismo filtro, por el mismo motivo, que ya aplica
  // `fetchBacklogConversationIds` en data.ts: la guarda de verdad vive en el
  // turno, esto es lo que evita llenar la cola de trabajo que el turno va a
  // descartar uno por uno.
  let libres = sinLock.map((fila) => fila.id);
  let atendidasPorHumanos = 0;
  if (sinLock.length > 0) {
    try {
      const deHumanos = await conversationsWrittenByHumans(supabase, sinLock, { now });
      libres = sinLock.filter((fila) => !deHumanos.has(fila.id)).map((fila) => fila.id);
      atendidasPorHumanos = sinLock.length - libres.length;
    } catch (err) {
      // Falla CERRADO, al revés que la consulta a Redis de más abajo: ante la
      // duda no se encola. Encolar de más acá no arriesga escribirle a un
      // cliente (el turno vuelve a comprobarlo), pero sí reproduce el bucle
      // que este filtro existe para cortar.
      log.error("reconciliador_humanos_no_consultables", { detail: errorText(err) });
      libres = [];
    }
  }

  // Encolar es idempotente (ver `AgentQueue.enqueue` en redis-queue.ts): re-
  // encolar algo que ya estaba solo le corre la ventana hacia adelante, no
  // duplica el turno. Por eso, si Redis no responde, el camino seguro es
  // encolar de todas formas — `porEncolar` arranca en `libres` y solo se
  // reduce si la consulta a Redis contesta.
  let porEncolar = libres;
  let yaEnCola = 0;

  if (libres.length > 0) {
    try {
      const puntajes = await getRedis().zmscore(RECONCILE_QUEUE_KEY, ...libres);
      porEncolar = libres.filter((_id, i) => puntajes[i] == null);
      yaEnCola = libres.length - porEncolar.length;
    } catch (err) {
      log.error("reconciliador_redis_fallido", { detail: errorText(err) });
    }
  }

  if (porEncolar.length > 0) {
    // debounceSeconds: 0 — estas conversaciones ya superaron cualquier
    // ventana de silencio hace rato (llevan huérfanas desde el incidente
    // que las soltó de la cola); no hay ráfaga del cliente que esperar, y
    // encolarlas con demora solo pospone sin necesidad la respuesta.
    await enqueueAgentTurns(porEncolar, { debounceSeconds: 0 });

    await Promise.all(
      porEncolar.map((conversationId) =>
        recordHandoff(supabase, {
          conversationId,
          toKind: "ai",
          reason: "reabierto",
          createdBy: "system",
        })
      )
    );

    log.info("reconciliador_encolo_huerfanas", { encoladas: porEncolar.length });
  }

  return {
    revisadas: candidatas.length,
    yaEnCola,
    bloqueadasPorLock,
    atendidasPorHumanos,
    encoladas: porEncolar.length,
  };
}
