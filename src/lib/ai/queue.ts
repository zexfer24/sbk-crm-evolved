import "server-only";
import { getRedis } from "@/lib/redis";
import { createAgentQueue, createTurnSlots } from "@/lib/ai/redis-queue";
import { runAgentTurn } from "@/lib/ai/agent";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Cola de turnos del agente.
//
// El webhook encola y sigue; procesar es un paso aparte. Así un reinicio en
// mitad de un turno deja la conversación pendiente en vez de perderla: la
// recoge el intento siguiente o el cron.
//
// El almacenamiento es Redis (ver redis-queue.ts), que además impone el tope
// de turnos simultáneos de TODO el sistema, no de cada instancia.
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

/**
 * Cuántos turnos pueden estar hablando con el modelo a la vez.
 *
 * Cada webhook dispara su propia pasada, así que sin un tope compartido un
 * pico de mensajes se convierte en decenas de llamadas simultáneas al
 * proveedor: responde con rate limit y los turnos empiezan a fallar en
 * cadena, gastando reintentos. Se lee en cada pasada para poder ajustarlo
 * sin recompilar la imagen.
 */
function maxConcurrentTurns(): number {
  const configurado = Number(process.env.AGENT_MAX_CONCURRENT_TURNS);
  return Number.isFinite(configurado) && configurado > 0 ? configurado : 3;
}

/**
 * Cuánto vale un cupo antes de darse por abandonado. Tiene que superar
 * cómodamente el turno más lento; si no, dos procesos podrían creerse dueños
 * del mismo cupo.
 */
const TURN_LEASE_SECONDS = 180;

/** Espera corta cuando no hay cupo: el turno vuelve a la cola, no se pierde. */
const RETRY_WHEN_BUSY_SECONDS = 3;

/** Espera antes de reintentar un turno que falló. */
const RETRY_AFTER_ERROR_SECONDS = 30;

/**
 * Intentos antes de abandonar una conversación.
 *
 * Una que rompe siempre —un mensaje que el modelo rechaza, un dato corrupto—
 * se quedaría reclamando cupos indefinidamente y empujando al resto hacia
 * atrás. Se abandona con un registro de error, que es lo que hace falta para
 * ir a mirarla.
 */
const MAX_ATTEMPTS = 3;

export interface EnqueueOptions {
  /** Ventana de silencio. Se baja a cero en pruebas y en el cron de recuperación. */
  debounceSeconds?: number;
  /**
   * Segundos que se le suman a cada conversación respecto de la anterior.
   *
   * No es un freno: quien limita el ritmo es MAX_PER_RUN. Existe para fijar
   * el ORDEN. La cola es un conjunto ordenado por instante de vencimiento, y
   * con vencimientos idénticos Redis los devuelve por orden alfabético del
   * id — o sea, al azar. Separarlos un segundo hace que se atiendan en el
   * orden en que llegaron acá, que para el repaso del atraso importa: el
   * más reciente primero.
   */
  spacingSeconds?: number;
}

export async function enqueueAgentTurns(
  conversationIds: Iterable<string>,
  options: EnqueueOptions = {}
): Promise<void> {
  const debounce = options.debounceSeconds ?? DEBOUNCE_SECONDS;
  const spacing = options.spacingSeconds ?? 0;
  const cola = createAgentQueue(getRedis());

  let posicion = 0;
  for (const conversationId of new Set(conversationIds)) {
    try {
      await cola.enqueue(conversationId, debounce + posicion * spacing);
    } catch (err) {
      // Encolar es lo único que no puede fallar en silencio: si esto no
      // queda registrado, el cliente se queda sin respuesta y nadie lo sabe.
      // Este evento merece una alerta en el agregador.
      log.error("cola_encolar_fallido", { conversationId, detail: errorText(err) });
    }
    posicion++;
  }
}

/** Turnos esperando en la cola. */
export async function pendingAgentTurns(): Promise<number> {
  return createAgentQueue(getRedis()).pending();
}

export interface QueueRunResult {
  processed: number;
  failed: number;
  /** Turnos que no encontraron cupo y volvieron a la cola. */
  deferred: number;
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
 * No lanza: un turno que falla vuelve a la cola y deja seguir a los demás.
 * Los turnos corren en paralelo hasta el tope de cupos —el histórico era uno
 * detrás de otro, y con el modelo tardando segundos eso hacía esperar a
 * clientes que no tenían nada que ver entre sí.
 */
export async function processQueuedTurns(limit = MAX_PER_RUN): Promise<QueueRunResult> {
  const redis = getRedis();
  const cola = createAgentQueue(redis);
  const cupos = createTurnSlots(redis, {
    max: maxConcurrentTurns(),
    leaseSeconds: TURN_LEASE_SECONDS,
  });

  const result: QueueRunResult = { processed: 0, failed: 0, deferred: 0 };

  async function atender(): Promise<void> {
    while (result.processed + result.failed + result.deferred < limit) {
      let conversationId: string | null;
      try {
        conversationId = await cola.claimDue();
      } catch (err) {
        log.error("cola_reclamar_fallido", { detail: errorText(err) });
        return;
      }
      if (!conversationId) return; // Cola vacía.

      const cupo = await cupos.acquire();
      if (!cupo) {
        // Sistema al tope: se devuelve para el próximo intento. Este worker
        // se retira; insistir solo gastaría viajes a Redis.
        await cola.enqueue(conversationId, RETRY_WHEN_BUSY_SECONDS);
        result.deferred++;
        return;
      }

      try {
        await runAgentTurn(conversationId);
        await cola.clearFailures(conversationId);
        result.processed++;
      } catch (err) {
        const detail = errorText(err);
        const intentos = await cola.recordFailure(conversationId);
        result.failed++;

        if (intentos >= MAX_ATTEMPTS) {
          log.error("cola_turno_abandonado", { conversationId, intentos, detail });
        } else {
          log.error("cola_turno_fallido", { conversationId, intentos, detail });
          await cola.enqueue(conversationId, RETRY_AFTER_ERROR_SECONDS);
        }
      } finally {
        // Pase lo que pase, el cupo se devuelve: retenerlo tras un fallo
        // iría cerrando el sistema turno a turno.
        await cupos.release(cupo);
      }
    }
  }

  await Promise.all(Array.from({ length: maxConcurrentTurns() }, () => atender()));

  return result;
}
