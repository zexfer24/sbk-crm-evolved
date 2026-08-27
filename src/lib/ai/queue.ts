import "server-only";
import { getRedis } from "@/lib/redis";
import { createAgentQueue, createTurnPace, createTurnSlots, releaseSweepLock } from "@/lib/ai/redis-queue";
import { runAgentTurn } from "@/lib/ai/agent";
import { isNonRetryable } from "@/lib/ai/turn-delivery";
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
 * Silencio que se espera antes de atender un chat cuando el mensaje parece
 * quedar a medias.
 *
 * Meta entrega casi siempre un POST por mensaje, así que sin esto un cliente
 * que escribe en ráfaga recibe una respuesta por frase, cada una sin el
 * contexto de las siguientes. Seis segundos alcanzan para que termine de
 * tipear.
 */
export const DEBOUNCE_SECONDS = 6;

/**
 * Silencio para el mensaje que ya dice lo que tenía que decir.
 *
 * El debounce no es gratis: son segundos fijos que se le suman a TODAS las
 * respuestas, y con el objetivo de cuatro segundos que pide el dueño, seis
 * fijos se comen el presupuesto entero antes de que el modelo haya leído
 * nada. Pero quitarlo devuelve el problema que vino a resolver.
 *
 * La salida no es elegir uno de los dos números: es dejar de aplicarle el
 * mismo a los dos casos. "buenas" y "necesito una para" son el arranque de
 * una ráfaga y esperan los seis segundos completos; "¿Tienen bujía para una
 * Empire Owen?" es una pregunta terminada y no gana nada esperando.
 *
 * Dos segundos y no cero: la ráfaga también existe DESPUÉS de una pregunta
 * completa —el cliente agrega la marca de la moto en un segundo mensaje— y
 * dos segundos cubren ese caso sin que se note como espera.
 */
export const DEBOUNCE_SHORT_SECONDS = 2;

/**
 * Puntuación de cierre, aunque después venga un emoji o un espacio.
 *
 * "¿Cuánto cuesta? 🏍️" cierra igual que "¿Cuánto cuesta?", y en WhatsApp el
 * emoji al final es la norma, no la excepción.
 */
const CIERRA_LA_IDEA = /[.?!…][^\p{L}\p{N}]*$/u;

/**
 * Palabras con las que nadie termina un mensaje. Si el texto acaba en una de
 * estas, el cliente está a mitad de la frase y sigue tecleando — da igual lo
 * largo que sea lo que lleve escrito.
 */
const CONECTOR_AL_FINAL =
  /(?:^|\s)(?:y|o|u|e|pero|que|de|del|al|para|por|con|sin|en|el|la|los|las|un|una|unos|unas|mi|tu|su|me|te|se|lo|le|si|como|cuando|donde|porque|es|son|está|están|tengo|necesito|quiero|busco)\s*$/iu;

/**
 * A partir de cuántos caracteres un mensaje se defiende solo aunque no lleve
 * puntuación. En WhatsApp casi nadie puntúa, así que la longitud es la única
 * señal que queda: nadie escribe cuarenta caracteres para cortarse a la mitad
 * si no terminó en un conector.
 */
const LARGO_QUE_SE_DEFIENDE_SOLO = 40;

/**
 * Cuánto silencio esperar antes de atender, según lo que acaba de escribir el
 * cliente.
 *
 * `texto` es lo que el cliente TECLEÓ —el cuerpo de un mensaje de texto o el
 * pie de una foto—, no lo que el CRM redactó para representar una ubicación o
 * un contacto compartido. Sin texto propio se espera la ventana completa: una
 * foto suelta casi siempre viene seguida del "¿cuánto cuesta?".
 */
export function debounceSecondsFor(texto: string | null | undefined): number {
  const limpio = texto?.trim();
  if (!limpio) return DEBOUNCE_SECONDS;

  // El conector manda sobre todo lo demás: "necesito una cadena para" tiene
  // veinticinco caracteres y termina en preposición — está a medias, seguro.
  if (CONECTOR_AL_FINAL.test(limpio)) return DEBOUNCE_SECONDS;

  if (CIERRA_LA_IDEA.test(limpio)) return DEBOUNCE_SHORT_SECONDS;
  if (limpio.length >= LARGO_QUE_SE_DEFIENDE_SOLO) return DEBOUNCE_SHORT_SECONDS;

  return DEBOUNCE_SECONDS;
}

/** Margen para no despertar justo en el borde y encontrar la ventana sin vencer. */
const WAKE_MARGIN_MS = 500;

/**
 * Cuántos turnos pueden estar hablando con el modelo a la vez.
 *
 * Cada webhook dispara su propia pasada, así que sin un tope compartido un
 * pico de mensajes se convierte en decenas de turnos simultáneos. Se lee en
 * cada pasada para poder ajustarlo sin recompilar la imagen.
 *
 * OJO: esto cuenta TURNOS, no peticiones al proveedor. Un turno gasta hasta
 * siete —escenario, clasificación y hasta cinco pasos del tool loop—, así
 * que este número nunca sirvió para no chocar con el rate limit: tres turnos
 * podían ser veintiuna peticiones en el mismo minuto. Quien controla el
 * ritmo hacia el proveedor es src/lib/ai/rate-limit.ts, y es el único sitio
 * donde se controla. Este tope sigue siendo útil por otra cosa: acota cuánta
 * conversación tiene el sistema abierta a la vez.
 */
function maxConcurrentTurns(): number {
  const configurado = Number(process.env.AGENT_MAX_CONCURRENT_TURNS);
  return Number.isFinite(configurado) && configurado > 0 ? configurado : 3;
}

/**
 * Turnos que pueden SALIR por minuto, en todo el sistema.
 *
 * Es un freno distinto del de cupos y hace falta que sean los dos. Los cupos
 * limitan cuántos turnos corren A LA VEZ; esto limita cuántos terminan por
 * minuto. Con tres cupos y turnos de siete segundos caben veinticinco turnos
 * en un minuto sin que el tope de cupos se pase ni una vez — que es
 * exactamente lo que pasó el 26 de agosto de 2026, cuando salieron ocho
 * mensajes en un minuto con AGENT_MAX_CONCURRENT_TURNS en 3.
 *
 * Cuatro por minuto es deliberadamente lento. El valor de que sea lento es
 * que apagar el interruptor alcance a frenar algo: a este ritmo, una tanda
 * equivocada son cuatro clientes antes de que alguien reaccione, no
 * veinticuatro.
 */
function maxTurnsPerMinute(): number {
  const configurado = Number(process.env.AGENT_MAX_TURNS_PER_MINUTE);
  return Number.isFinite(configurado) && configurado > 0 ? configurado : 4;
}

/**
 * Cuánto vale un cupo antes de darse por abandonado. Tiene que superar
 * cómodamente el turno más lento; si no, dos procesos podrían creerse dueños
 * del mismo cupo.
 */
const TURN_LEASE_SECONDS = 180;

/** Espera corta cuando no hay cupo: el turno vuelve a la cola, no se pierde. */
const RETRY_WHEN_BUSY_SECONDS = 3;

/** Espera cuando lo que se agotó es el presupuesto del minuto, no los cupos. */
const RETRY_WHEN_PACED_SECONDS = 20;

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

/**
 * Descarta todo lo que la IA tenía pendiente. Devuelve cuántos turnos eran.
 *
 * Es la mitad que le faltaba al botón de apagado. Apagar escribía
 * `ai_globally_enabled = false` y nada más: la cola se quedaba llena, y esos
 * turnos se iban reclamando uno a uno para salir por la puerta de atrás de
 * runAgentTurn sin dejar rastro. Peor todavía si alguien volvía a encender
 * antes de que se drenara — la tanda vieja salía de golpe, con un contexto de
 * hace media hora.
 *
 * Se descarta y no se guarda a propósito: un turno pendiente es "hay que
 * contestarle a este cliente lo que dijo hace un rato", y cuanto más rato
 * pasa menos cierto es. Si el cliente sigue esperando, vuelve a escribir y
 * entra por el webhook con el hilo fresco.
 *
 * También suelta el lock del barrido: apagar tiene que dejar el sistema listo
 * para volver a encenderse, no bloqueado media hora por una tanda que ya no
 * existe.
 */
export async function stopAgentQueue(): Promise<{ discarded: number }> {
  const redis = getRedis();
  const descartados = await createAgentQueue(redis).purge();
  await releaseSweepLock(redis);

  log.warn("cola_purgada", { descartados });
  return { discarded: descartados };
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
 *
 * `debounceSeconds` tiene que ser el MISMO con el que se encoló, o la pasada
 * despierta antes de que el turno venza y se va con las manos vacías. Como el
 * webhook usa dos ventanas distintas según cómo venga el mensaje (ver
 * debounceSecondsFor), lanza una pasada por ventana y no una sola.
 *
 * `limit` es lo que arregla el agujero del 26 de agosto de 2026. Esto corría
 * sin límite, o sea con el MAX_PER_RUN de diez, sobre la cola COMPARTIDA: cada
 * mensaje entrante de WhatsApp drenaba hasta diez turnos del atraso. El
 * comentario del barrido decía que el drenado lo hacía el cron, diez turnos
 * cada cinco minutos, y que esa lentitud era el freno de emergencia — pero el
 * mecanismo no estaba conectado y el ritmo lo terminaba poniendo el tráfico
 * entrante. En cuatro minutos entraron veintisiete mensajes de clientes y
 * salieron veinticuatro respuestas.
 *
 * Ahora el webhook drena como mucho lo que él mismo encoló: un mensaje
 * entrante puede provocar un turno, no diez.
 */
export async function processAfterDebounce(
  limit = MAX_PER_RUN,
  debounceSeconds = DEBOUNCE_SECONDS
): Promise<QueueRunResult> {
  await new Promise((resolve) => setTimeout(resolve, debounceSeconds * 1000 + WAKE_MARGIN_MS));
  return processQueuedTurns(limit);
}

/**
 * Procesa turnos pendientes hasta agotar la cola o llegar al tope.
 *
 * No lanza: un turno que falla vuelve a la cola y deja seguir a los demás,
 * salvo el que ya le habló al cliente — ese se abandona en vez de volver,
 * para no mandarle el mismo mensaje dos veces.
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
  const ritmo = createTurnPace(redis, { maxPerMinute: maxTurnsPerMinute() });

  const result: QueueRunResult = { processed: 0, failed: 0, deferred: 0 };

  /**
   * Lugares del presupuesto ya tomados, contando los turnos que todavía no
   * terminaron.
   *
   * Mirar `result` para decidir si queda sitio era una carrera: sus contadores
   * suben DESPUÉS del turno, así que con limit=1 los tres trabajadores veían
   * "0 < 1", los tres reclamaban y los tres arrancaban. `limit` no era un
   * límite sino una sugerencia que se pasaba hasta en maxConcurrentTurns-1 por
   * pasada — y el límite del webhook, que es lo que evita que un mensaje
   * entrante drene el atraso de otros, se apoya justo en eso.
   *
   * Reservar antes de reclamar lo cierra sin necesidad de nada atómico: el
   * incremento y la comprobación no tienen ningún `await` en medio, así que
   * ningún otro trabajador puede colarse entre los dos.
   */
  let tomados = 0;

  async function atender(): Promise<void> {
    for (;;) {
      if (tomados >= limit) return;
      tomados++;

      let conversationId: string | null;
      try {
        conversationId = await cola.claimDue();
      } catch (err) {
        tomados--; // No se llegó a atender nada: el lugar vuelve al presupuesto.
        log.error("cola_reclamar_fallido", { detail: errorText(err) });
        return;
      }
      if (!conversationId) {
        tomados--; // Cola vacía: idem.
        return;
      }

      // El presupuesto del minuto se pide ANTES del cupo: pedir el cupo
      // primero lo tendría retenido durante una comprobación que puede decir
      // que no, y con tres cupos eso se nota.
      if (!(await ritmo.tryConsume())) {
        // Se devuelve a la cola con la espera del minuto: volver antes solo
        // gastaría viajes a Redis para recibir el mismo no.
        await cola.enqueue(conversationId, RETRY_WHEN_PACED_SECONDS);
        result.deferred++;
        log.info("cola_ritmo_al_tope", { conversationId, tope: maxTurnsPerMinute() });
        return;
      }

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
        result.failed++;

        // Hay fallos que volver a intentar empeora. El turno que ya le puso
        // algo delante al cliente es el caso: reintentarlo le manda el mismo
        // mensaje otra vez. Se registra y se abandona, sin gastar los
        // intentos ni ocupar la cola. Ver turn-delivery.ts.
        if (isNonRetryable(err)) {
          await cola.clearFailures(conversationId);
          log.error("cola_turno_no_reintentable", { conversationId, detail });
          continue;
        }

        const intentos = await cola.recordFailure(conversationId);

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
