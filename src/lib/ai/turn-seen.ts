import "server-only";
import { getRedis } from "@/lib/redis";
import { errorText, log } from "@/lib/log";
import type { SeenMarker } from "@/lib/ai/history-line";

export type { SeenMarker };

// ---------------------------------------------------------------------------
// T1, plan "Seba no habla de más mientras el cliente espera al asesor"
// (22-23/9/2026): "lo ya respondido no se vuelve a responder".
//
// La marca "visto hasta" recuerda, por conversación, cuál fue la línea de
// cliente más nueva que el ÚLTIMO turno que atendió de verdad llegó a
// cargar. `runTurnPhases` (agent.ts) la lee al arrancar el turno y calcula
// los "pendientes" contra ella (`pendingCustomerLines`, history-line.ts) en
// vez de mirar solo la ráfaga final del historial (`customerBurst`) — ver el
// comentario de esa función para el caso real que motivó esto.
//
// TTL de 6 horas: una marca vieja de una conversación que no volvió a hablar
// no cuesta nada dejarla vencer sola. El TTL nunca decide nada por sí solo
// —si la conversación retoma después de vencido, simplemente se comporta
// como si nunca hubiera tenido marca (`readSeen` da `null`, mismo camino que
// hoy)—, solo evita que Redis acumule claves de conversaciones muertas para
// siempre.
//
// `readSeen`/`writeSeen` NUNCA lanzan: un corte de Redis acá no puede tumbar
// el turno completo, que sin esta marca simplemente se comporta como antes
// de esta tarea (`customerBurst`). Se deja `log.warn` con `errorText`
// (CLAUDE.md: nunca `err instanceof Error ? … : String(err)`, que aplasta un
// error de ioredis o un JSON corrupto a "[object Object]") y se devuelve
// `null`/nada.
// ---------------------------------------------------------------------------

/** Seis horas, en segundos — ver el comentario de cabecera. */
const TTL_SECONDS = 6 * 60 * 60;

function seenKey(conversationId: string): string {
  return `turno:visto:${conversationId}`;
}

/** ¿`value` tiene la forma de `SeenMarker`? Protege contra un JSON viejo o corrupto en la clave. */
function isSeenMarker(value: unknown): value is SeenMarker {
  if (typeof value !== "object" || value === null) return false;
  const { hasta, ids } = value as { hasta?: unknown; ids?: unknown };
  return typeof hasta === "string" && Array.isArray(ids) && ids.every((id) => typeof id === "string");
}

/**
 * La marca "visto hasta" de esta conversación, o `null` si no hay: nunca se
 * escribió, venció, o Redis no respondió (nunca lanza).
 */
export async function readSeen(conversationId: string): Promise<SeenMarker | null> {
  try {
    const raw = await getRedis().get(seenKey(conversationId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSeenMarker(parsed) ? parsed : null;
  } catch (err) {
    log.warn("turno_visto_no_legible", { conversationId, detail: errorText(err) });
    return null;
  }
}

/**
 * Deja la marca "visto hasta" de esta conversación, con TTL de 6 h. Nunca
 * lanza: un fallo acá no puede tumbar un turno que ya terminó de atender al
 * cliente.
 */
export async function writeSeen(conversationId: string, marker: SeenMarker): Promise<void> {
  try {
    await getRedis().set(seenKey(conversationId), JSON.stringify(marker), "EX", TTL_SECONDS);
  } catch (err) {
    log.warn("turno_visto_no_escrito", { conversationId, detail: errorText(err) });
  }
}
