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
const PACE_KEY = "liminal:agent:ritmo";
const SWEEP_LOCK_KEY = "liminal:agent:barrido";

/** Prefijo de la clave que guarda el PRIMER vencimiento de un turno, para que sobreviva a sus reintentos (ver `defer`). */
const VENCIMIENTO_PREFIX = "liminal:agent:vencimiento:";

/**
 * Cuánto vive la marca del vencimiento original antes de darse por perdida.
 *
 * Mismo criterio que `FAILURE_TTL_SECONDS` de abajo: es la red contra el
 * turno que nunca vuelve a reclamarse (murió el proceso, se abandonó tras
 * MAX_ATTEMPTS) y dejaría la clave puesta para siempre.
 */
const VENCIMIENTO_TTL_SECONDS = 3600;

function vencimientoKey(conversationId: string): string {
  return `${VENCIMIENTO_PREFIX}${conversationId}`;
}

/**
 * Toma el turno vencido que lleva más tiempo esperando y lo saca de la cola,
 * todo dentro de Redis. Que el mismo `ZREM` lo ejecute quien lo leyó es lo
 * que impide que dos procesos se lleven la misma conversación.
 *
 * 7/9/2026 ("La respuesta llega en siete segundos", T0): además del id,
 * devuelve el vencimiento con que se atiende el turno — el que hace falta
 * para separar, en `agent.ts`, la ventana de silencio (diseño) de la espera
 * en cola (atraso). La primera vez que se reclama un turno no hay nada
 * guardado todavía: se siembra la clave de vencimiento con el score crudo
 * (`SET ... EX 3600`, sin NX: es la primera escritura) para que, si este
 * turno tiene que diferirse (ver `defer`), el PRÓXIMO reclamo la encuentre y
 * sepa que ese fue el vencimiento real, no el de un reintento. Si la clave ya
 * existía —porque este turno viene de un reintento anterior— se usa ese
 * valor (el más viejo) y se borra: ya cumplió su función, este reclamo es el
 * que de verdad va a correr.
 */
const CLAIM_SCRIPT = `
local vencidos = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'WITHSCORES', 'LIMIT', 0, 1)
if #vencidos == 0 then return false end
local miembro = vencidos[1]
local score = vencidos[2]
redis.call('ZREM', KEYS[1], miembro)
local vencKey = ARGV[2] .. miembro
local original = redis.call('GET', vencKey)
if original then
  redis.call('DEL', vencKey)
  return {miembro, original}
end
redis.call('SET', vencKey, score, 'EX', ${VENCIMIENTO_TTL_SECONDS})
return {miembro, score}
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
  /**
   * Saca la conversación esperando desde hace más tiempo cuya ventana ya
   * venció, junto con el vencimiento con que hay que atenderla —el PRIMERO
   * que tuvo, no el de un reintento posterior (ver `defer`)—.
   */
  claimDue(): Promise<{ conversationId: string; vencioEn: number } | null>;
  /**
   * Reintenta un turno que ya se reclamó pero no pudo correr todavía —ritmo
   * al tope, sin cupo, conversación bloqueada, error transitorio—.
   *
   * Es distinto de `enqueue`: un mensaje nuevo del cliente ES una ventana
   * nueva (por eso `enqueue` borra el vencimiento guardado), pero un
   * reintento del SISTEMA no lo es. Sin esta distinción, `debounceMs` (=
   * vencimiento − último mensaje del cliente) terminaría incluyendo la
   * espera en cola de los reintentos anteriores, y `colaMs` mediría de
   * menos — justo el número del criterio de cierre de la rampa ("La
   * respuesta llega en siete segundos", 7/9/2026), sesgado hacia el verde.
   */
  defer(conversationId: string, seconds: number): Promise<void>;
  /** Cuántos turnos hay esperando. */
  pending(): Promise<number>;
  /** Anota un intento fallido y devuelve cuántos lleva acumulados esa conversación. */
  recordFailure(conversationId: string): Promise<number>;
  /** Borra la cuenta de fallos tras un turno bien atendido. */
  clearFailures(conversationId: string): Promise<void>;
  /** Vacía la cola entera y devuelve cuántos turnos se descartaron. */
  purge(): Promise<number>;
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
      // Mensaje nuevo del cliente = ventana nueva: el vencimiento que
      // pudiera haber quedado de un turno diferido para esta conversación ya
      // no vale nada, y dejarlo puesto le mentiría al próximo reclamo.
      await redis.del(vencimientoKey(conversationId));
      await redis.zadd(QUEUE_KEY, Date.now() + debounceSeconds * 1000, conversationId);
    },

    async claimDue() {
      const claimed = await redis.eval(CLAIM_SCRIPT, 1, QUEUE_KEY, Date.now(), VENCIMIENTO_PREFIX);
      if (!Array.isArray(claimed)) return null;
      const [conversationId, vencimiento] = claimed as [string, string];
      const vencioEn = Number(vencimiento);
      // Defensivo: si algún día el script no trajera un número legible, se
      // usa el instante del reclamo — perder cinco segundos de precisión es
      // mejor que tumbar el turno por un dato de telemetría.
      return { conversationId, vencioEn: Number.isFinite(vencioEn) ? vencioEn : Date.now() };
    },

    async defer(conversationId, seconds) {
      // El vencimiento anterior solo existe si esta conversación TODAVÍA
      // está en la cola (no pasó por un `claimDue` que ya la sacó). En el
      // camino real de queue.ts (reintento tras reclamar) no lo va a
      // encontrar acá —`claimDue` ya la sembró en la clave de vencimiento,
      // que es de donde la recupera el PRÓXIMO reclamo—; este `ZSCORE`
      // cubre el otro caso, el de diferir una conversación que todavía no se
      // reclamó ni una vez (varios reintentos seguidos antes del primer
      // `claimDue`).
      const scoreAnterior = await redis.zscore(QUEUE_KEY, conversationId);
      await redis.zadd(QUEUE_KEY, Date.now() + seconds * 1000, conversationId);
      if (scoreAnterior !== null) {
        // NX: si ya había un vencimiento guardado de un diferido previo, se
        // conserva ESE — es el más viejo, y es el que importa.
        await redis.set(vencimientoKey(conversationId), scoreAnterior, "EX", VENCIMIENTO_TTL_SECONDS, "NX");
      }
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

    async purge() {
      const pendientes = await redis.zcard(QUEUE_KEY);
      await redis.del(QUEUE_KEY);

      // Los vencimientos que hubieran quedado de turnos a mitad de un
      // reintento se descartan también: son pocos —uno por turno diferido, y
      // con TTL de una hora— así que un SCAN no pesa, y KEYS bloquearía
      // Redis entero en producción mientras dura.
      let cursor = "0";
      do {
        const [siguiente, claves] = await redis.scan(cursor, "MATCH", `${VENCIMIENTO_PREFIX}*`, "COUNT", 200);
        cursor = siguiente;
        if (claves.length > 0) await redis.del(...claves);
      } while (cursor !== "0");

      return pendientes;
    },
  };
}

/**
 * Consume un turno del presupuesto de la ventana, si queda.
 *
 * Misma forma que los cupos —limpiar, contar y añadir en una sola operación—
 * porque el problema es el mismo: varias instancias mirando a la vez verían
 * todas que queda lugar.
 */
const CONSUME_PACE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return false end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return ARGV[4]
`;

export interface TurnPace {
  /** true si el turno puede correr ahora. false = la ventana está llena. */
  tryConsume(): Promise<boolean>;
  /** Turnos gastados en la ventana actual. Para los registros. */
  used(): Promise<number>;
}

/**
 * Tope de turnos por minuto en TODO el sistema.
 *
 * El tope de cupos limita turnos SIMULTÁNEOS, que no es lo mismo y por eso no
 * frenó nada el 26 de agosto de 2026: con tres cupos y turnos de siete
 * segundos caben veinticinco turnos en un minuto. Salieron ocho mensajes en
 * el minuto de las 16:35 sin que ningún tope se pasara, porque ninguno contaba
 * mensajes por minuto.
 *
 * Este es el freno que hace que apagar el interruptor sirva de algo: acota
 * cuánto puede salir mientras alguien se da cuenta y reacciona.
 */
export function createTurnPace(redis: Redis, options: { maxPerMinute: number }): TurnPace {
  const ventanaMs = 60_000;

  return {
    async tryConsume() {
      const ahora = Date.now();
      const otorgado = await redis.eval(
        CONSUME_PACE_SCRIPT,
        1,
        PACE_KEY,
        ahora - ventanaMs,
        options.maxPerMinute,
        ahora,
        randomUUID(),
        ventanaMs * 2
      );
      return typeof otorgado === "string";
    },

    async used() {
      await redis.zremrangebyscore(PACE_KEY, "-inf", Date.now() - ventanaMs);
      return redis.zcard(PACE_KEY);
    },
  };
}

/**
 * Lock del barrido del atraso.
 *
 * El 26 de agosto el barrido se disparó dos veces con dos minutos y medio de
 * diferencia (139 y 129 conversaciones) porque el botón no tiene memoria de
 * que ya se pulsó. Con el atraso a medio drenar, volver a pulsarlo re-encola
 * todo lo que no salió todavía.
 *
 * El TTL es la red contra el proceso que muere con el lock puesto: sin él, un
 * reinicio desafortunado deja el barrido bloqueado para siempre.
 */
export async function acquireSweepLock(redis: Redis, ttlSeconds: number): Promise<boolean> {
  const puesto = await redis.set(SWEEP_LOCK_KEY, String(Date.now()), "EX", ttlSeconds, "NX");
  return puesto === "OK";
}

export async function releaseSweepLock(redis: Redis): Promise<void> {
  await redis.del(SWEEP_LOCK_KEY);
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
