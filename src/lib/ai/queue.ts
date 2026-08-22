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

export async function enqueueAgentTurns(
  supabase: SupabaseClient<Database>,
  conversationIds: Iterable<string>
): Promise<void> {
  for (const conversationId of new Set(conversationIds)) {
    const { error } = await supabase.rpc("enqueue_agent_turn", { p_conversation_id: conversationId });
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
      await supabase.rpc("finish_agent_turn", { p_conversation_id: conversationId });
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
