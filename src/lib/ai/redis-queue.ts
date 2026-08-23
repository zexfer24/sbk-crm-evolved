import "server-only";
import type Redis from "ioredis";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Cola de turnos del agente, en Redis.
//
// Antes vivía en Postgres (tabla + RPC). Se movió acá para sacarle a la base
// el trabajo de latido —encolar, reclamar y soltar en cada mensaje que
// entra— y porque la espera del debounce se resuelve mejor con un índice
// ordenado por tiempo que con una tabla.
//
// Lo que NO cambia es la garantía que sostiene todo: una conversación la
// atiende un solo proceso. Acá la da la atomicidad de Redis, con los dos
// scripts de abajo; el reclamo y el cupo se deciden dentro de Redis, en una
// sola operación, y no con un "leer y después escribir" que dos instancias
// pueden intercalar.
//
// IMPORTANTE para el despliegue: Redis tiene que correr con `--appendonly
// yes`. Sin persistencia, un reinicio se lleva los turnos pendientes y esos
// clientes se quedan sin respuesta.
// ---------------------------------------------------------------------------

const QUEUE_KEY = "liminal:agent:turns";
const SLOTS_KEY = "liminal:agent:slots";

/**
 * Toma el turno vencido que lleva más tiempo esperando y lo saca de la cola,
 * todo dentro de Redis. Que el mismo `ZREM` lo ejecute quien lo leyó es lo
 * que impide que dos procesos se lleven la misma conversación.
 */
const CLAIM_SCRIPT = `
local vencidos = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 1)
if #vencidos == 0 then return false end
redis.call('ZREM', KEYS[1], vencidos[1])
return vencidos[1]
`;

/**
 * Otorga un cupo solo si queda lugar, después de descartar los vencidos.
 * Contar y añadir en la misma operación evita que varias instancias vean
 * "queda lugar" a la vez y se pasen todas del tope.
 */
const ACQUIRE_SLOT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return false end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
return ARGV[4]
`;

export interface AgentQueue {
  /**
   * Deja la conversación pendiente, atendible dentro de `debounceSeconds`.
   *
   * Encolar la misma conversación otra vez no agrega un segundo turno: le
   * corre la ventana hacia adelante. Es lo que hace que a un cliente que
   * escribe cinco mensajes seguidos se le responda una vez, con todo el
   * contexto, en vez de cinco veces sueltas.
   */
  enqueue(conversationId: string, debounceSeconds: number): Promise<void>;
  /** Saca la conversación esperando desde hace más tiempo cuya ventana ya venció. */
  claimDue(): Promise<string | null>;
  /** Cuántos turnos hay esperando. */
  pending(): Promise<number>;
  /** Anota un intento fallido y devuelve cuántos lleva acumulados esa conversación. */
  recordFailure(conversationId: string): Promise<number>;
  /** Borra la cuenta de fallos tras un turno bien atendido. */
  clearFailures(conversationId: string): Promise<void>;
}

/**
 * Los fallos se olvidan solos al cabo de un rato. Sin esto, una conversación
 * que falló hace una semana empezaría el día de hoy con los intentos ya
 * gastados y no se la volvería a intentar.
 */
const FAILURE_TTL_SECONDS = 3600;

function failureKey(conversationId: string): string {
  return `liminal:agent:fallos:${conversationId}`;
}

export function createAgentQueue(redis: Redis): AgentQueue {
  return {
    async enqueue(conversationId, debounceSeconds) {
      await redis.zadd(QUEUE_KEY, Date.now() + debounceSeconds * 1000, conversationId);
    },

    async claimDue() {
      const claimed = await redis.eval(CLAIM_SCRIPT, 1, QUEUE_KEY, Date.now());
      return typeof claimed === "string" ? claimed : null;
    },

    async pending() {
      return redis.zcard(QUEUE_KEY);
    },

    async recordFailure(conversationId) {
      const key = failureKey(conversationId);
      const intentos = await redis.incr(key);
      await redis.expire(key, FAILURE_TTL_SECONDS);
      return intentos;
    },

    async clearFailures(conversationId) {
      await redis.del(failureKey(conversationId));
    },
  };
}

export interface TurnSlotsOptions {
  /** Turnos que pueden correr a la vez en TODO el sistema, no por instancia. */
  max: number;
  /**
   * Cuánto vale un cupo antes de considerarse abandonado.
   *
   * Es la red contra el proceso que muere a mitad de turno y nunca libera:
   * sin vencimiento, un par de reinicios desafortunados dejan al agente sin
   * cupos para siempre. Tiene que superar cómodamente lo que tarda el turno
   * más lento.
   */
  leaseSeconds?: number;
}

export interface TurnSlots {
  /** Devuelve el identificador del cupo, o null si ya no hay lugar. */
  acquire(): Promise<string | null>;
  release(leaseId: string): Promise<void>;
}

export function createTurnSlots(redis: Redis, options: TurnSlotsOptions): TurnSlots {
  const leaseSeconds = options.leaseSeconds ?? 120;

  return {
    async acquire() {
      const now = Date.now();
      const granted = await redis.eval(
        ACQUIRE_SLOT_SCRIPT,
        1,
        SLOTS_KEY,
        now,
        options.max,
        now + leaseSeconds * 1000,
        randomUUID()
      );
      return typeof granted === "string" ? granted : null;
    },

    async release(leaseId) {
      await redis.zrem(SLOTS_KEY, leaseId);
    },
  };
}
