import "server-only";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { errorText, log } from "@/lib/log";

/**
 * Ejecuta `fn` solo si logra tomar el lock de turno de IA de esta
 * conversación. Si ya hay un turno en curso para la misma conversación (dos
 * webhooks casi simultáneos, típico cuando el cliente manda varios mensajes
 * seguidos) NO se salta en silencio: lanza `ConversationBusyError` para que
 * quien llama (la cola, ver queue.ts) decida qué hacer, en vez de correr dos
 * turnos en paralelo y arriesgar una respuesta duplicada.
 *
 * El lock es un lease con dueño (`ai_turn_lock_until` / `ai_turn_lock_token`,
 * migración 20260829020000_conversations_turn_lock_lease.sql), no el booleano
 * `ai_turn_running` de antes. Antes, un proceso que moría entre adquirir el
 * lock y el `finally` que lo soltaba —un crash, un redeploy a mitad de
 * turno— dejaba la conversación muda para siempre: nadie volvía a poner
 * `ai_turn_running` en false. El lease vence solo a los
 * `TURN_LOCK_LEASE_SECONDS` si nadie lo renueva, así que un proceso muerto
 * libera la conversación en como mucho ese tiempo, no nunca. Mientras el
 * turno sigue vivo lo renueva un latido cada `TURN_LOCK_RENEW_SECONDS`
 * llamando al RPC `ai_turn_lock_renew`, fenceado por token: solo quien tomó
 * el lock puede renovarlo o soltarlo, así que un turno zombi no puede
 * pisarle el lock al que vino después.
 */
export const TURN_LOCK_LEASE_SECONDS = 90;
export const TURN_LOCK_RENEW_SECONDS = 30;

export interface TurnLease {
  /** Renueva el lease y dice si el turno sigue siendo el dueño. */
  confirmar(): Promise<boolean>;
}

/** La conversación ya tiene un turno de IA en curso (lock tomado por otro). */
export class ConversationBusyError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(`La conversación ${conversationId} ya tiene un turno de IA en curso`);
    this.name = "ConversationBusyError";
    this.conversationId = conversationId;
  }
}

export function isConversationBusy(err: unknown): err is ConversationBusyError {
  return err instanceof ConversationBusyError;
}

export async function withConversationTurnLock(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  fn: (lease: TurnLease) => Promise<void>
): Promise<void> {
  const token = randomUUID();

  const { data: acquired, error: acquireError } = await supabase.rpc("ai_turn_lock_acquire", {
    p_conversation_id: conversationId,
    p_token: token,
    p_lease_seconds: TURN_LOCK_LEASE_SECONDS,
  });

  if (acquireError) {
    // CAMBIO DELIBERADO (29/8/2026): antes de este cambio un error de base
    // acá se trataba igual que "el lock lo tiene otro turno" y el turno se
    // saltaba en silencio. Un fallo de conexión es reintentable —la cola
    // sabe reencolar un turno que lanza—, mientras que "ocupado" es una
    // decisión de negocio distinta. Confundirlos le escondía a la cola los
    // cortes de base como si fueran carreras normales entre webhooks.
    throw new Error(`No se pudo tomar el lock del turno: ${errorText(acquireError)}`);
  }

  if (acquired !== true) {
    // Antes esto era un `return` mudo: el turno se saltaba sin dejar
    // rastro y el bug de ai_turn_running sin TTL pasaba inadvertido. Ahora
    // lanza: encontrar la conversación tomada deja de ser silencio, es
    // ConversationBusyError (29/8/2026).
    log.warn("turno_lock_ocupado", { conversationId, leaseSegundos: TURN_LOCK_LEASE_SECONDS });
    throw new ConversationBusyError(conversationId);
  }

  async function confirmar(): Promise<boolean> {
    const { data, error } = await supabase.rpc("ai_turn_lock_renew", {
      p_conversation_id: conversationId,
      p_token: token,
      p_lease_seconds: TURN_LOCK_LEASE_SECONDS,
    });

    if (error) {
      // Falla cerrado, igual que el resto de las guardas del envío: ante la
      // duda de si el lock sigue siendo nuestro, no se sigue hablando.
      log.warn("turno_lock_renovacion_fallida", { conversationId, detail: errorText(error) });
      return false;
    }

    if (data !== true) {
      log.error("turno_lock_perdido", { conversationId });
      clearInterval(latido);
      return false;
    }

    return true;
  }

  // Sin .unref(): bajo la lib DOM de Next el tipo de setInterval no lo trae.
  // El clearInterval del finally de abajo (y el de confirmar() cuando se
  // pierde el lock) evita la fuga.
  const latido = setInterval(() => {
    void confirmar();
  }, TURN_LOCK_RENEW_SECONDS * 1000);

  try {
    await fn({ confirmar });
  } finally {
    clearInterval(latido);

    // El release nunca lanza: no puede tapar un error que haya venido de
    // fn(). Si falla o ya no éramos el dueño, el lease vence solo igual.
    try {
      const { data: liberado, error: releaseError } = await supabase.rpc("ai_turn_lock_release", {
        p_conversation_id: conversationId,
        p_token: token,
      });

      if (releaseError) {
        log.error("turno_lock_no_liberado", { conversationId, detail: errorText(releaseError) });
      } else if (liberado !== true) {
        log.warn("turno_lock_ya_no_era_nuestro", { conversationId });
      }
    } catch (err) {
      log.error("turno_lock_no_liberado", { conversationId, detail: errorText(err) });
    }
  }
}
