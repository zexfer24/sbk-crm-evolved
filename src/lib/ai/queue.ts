import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAgentTurn } from "@/lib/ai/agent";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Cola de turnos del agente.
//
// El webhook encola y sigue; procesar es un paso aparte. Así un reinicio en
// mitad de un turno deja la conversación pendiente en vez de perderla: la
// recoge el intento siguiente o el cron.
// ---------------------------------------------------------------------------

/** Tope de turnos por pasada. Evita que una tanda grande agote el tiempo de la petición. */
const MAX_PER_RUN = 10;

/**
 * Silencio que se espera antes de atender un chat.
 *
 * Meta entrega casi siempre un POST por mensaje, así que sin esto un cliente
 * que escribe en ráfaga recibe una respuesta por frase, cada una sin el
 * contexto de las siguientes. Seis segundos alcanzan para que termine de
 * tipear y siguen leyéndose como una respuesta inmediata.
 */
export const DEBOUNCE_SECONDS = 6;

/** Margen para no despertar justo en el borde y encontrar la ventana sin vencer. */
const WAKE_MARGIN_MS = 500;

export async function enqueueAgentTurns(
  supabase: SupabaseClient<Database>,
  conversationIds: Iterable<string>
): Promise<void> {
  for (const conversationId of new Set(conversationIds)) {
    const { error } = await supabase.rpc("enqueue_agent_turn", {
      p_conversation_id: conversationId,
      p_debounce_seconds: DEBOUNCE_SECONDS,
    });
    if (error) {
      // Encolar es lo único que no puede fallar en silencio: si esto no
      // queda registrado, el cliente se queda sin respuesta y nadie lo sabe.
      // Este evento merece una alerta en el agregador.
      log.error("cola_encolar_fallido", { conversationId, detail: error.message });
    }
  }
}

export interface QueueRunResult {
  processed: number;
  failed: number;
}

/**
 * Espera a que venza la ventana de silencio y recién ahí procesa.
 *
 * Lo llama el webhook después de responderle a Meta. Con varios mensajes
 * seguidos quedan varias esperas en curso, y no pasa nada: cada mensaje corre
 * la ventana hacia adelante, así que las primeras despiertan, no encuentran
 * nada vencido y se van. La última es la que atiende, ya con todo el hilo.
 */
export async function processAfterDebounce(): Promise<QueueRunResult> {
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_SECONDS * 1000 + WAKE_MARGIN_MS));
  return processQueuedTurns();
}

/**
 * Procesa turnos pendientes hasta agotar la cola o llegar al tope.
 *
 * No lanza: un turno que falla marca su fila y deja seguir a los demás. La
 * fila queda con el error a la vista y se reintenta hasta agotar los intentos.
 */
export async function processQueuedTurns(limit = MAX_PER_RUN): Promise<QueueRunResult> {
  const supabase = createAdminClient();
  const result: QueueRunResult = { processed: 0, failed: 0 };

  for (let i = 0; i < limit; i++) {
    const { data: conversationId, error } = await supabase.rpc("claim_agent_turn", {});

    if (error) {
      log.error("cola_reclamar_fallido", { detail: error.message });
      break;
    }
    if (!conversationId) break; // Cola vacía.

    try {
      await runAgentTurn(conversationId);
      // Si el cliente escribió mientras corría el turno, finish_agent_turn no
      // borra la fila: la devuelve a la cola con la ventana corrida.
      await supabase.rpc("finish_agent_turn", {
        p_conversation_id: conversationId,
        p_debounce_seconds: DEBOUNCE_SECONDS,
      });
      result.processed++;
    } catch (err) {
      const detail = errorText(err);
      log.error("cola_turno_fallido", { conversationId, detail });
      await supabase.rpc("finish_agent_turn", { p_conversation_id: conversationId, p_error: detail });
      result.failed++;
    }
  }

  return result;
}
