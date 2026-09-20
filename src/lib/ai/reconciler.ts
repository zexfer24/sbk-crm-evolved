import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRedis } from "@/lib/redis";
import { freeformWindowCutoff } from "@/lib/dashboard";
import { enqueueAgentTurns } from "@/lib/ai/queue";
import { recordHandoff, conversationsWithDecidedSilence } from "@/lib/ai/handoffs";
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
  /**
   * Las descartó el filtro de "el turno ya miró este mensaje y decidió
   * callarse a propósito" (Tarea C1, "El resguardo antes del push",
   * 20/9/2026): ver `RAZONES_DE_SILENCIO_DECIDIDO` en handoffs.ts y el
   * comentario en el cuerpo de esta función.
   */
  silencioYaDecidido: number;
  /** Las que de verdad se reencolaron en esta pasada. */
  encoladas: number;
}

const EMPTY_RESULT: ReconcileResult = {
  revisadas: 0,
  yaEnCola: 0,
  bloqueadasPorLock: 0,
  atendidasPorHumanos: 0,
  silencioYaDecidido: 0,
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
 *
 * Tarea 2, "La IA no vuelve a pedir lo que ya pidió" — revisión (16/9/2026).
 * Caso real del 13-15/9: un cliente pide un asesor, la IA escala y se
 * despide ("te paso con un asesor") — esa despedida es `is_auto_reply`, así
 * que a propósito NO apaga `awaiting_reply` (el cliente sigue esperando a
 * una PERSONA, no a una IA) — y `escalateConversation` apaga `ai_enabled`.
 * Un asesor desasigna el caso y reactiva la IA a mano: sin este filtro, esta
 * misma consulta encontraba la conversación "esperando, sin asesor, con la
 * IA encendida" en menos de un minuto y la reencolaba — la IA repetía la
 * MISMA promesa sobre el MISMO mensaje del cliente, sin que hubiera nada
 * nuevo que contestar. Es el mecanismo que el 13/9 volvió a escalar 63
 * casos.
 *
 * Un reloj de SALIDAS (el diseño del 15/9, `awaiting_any_reply`) no alcanza:
 * lo tapa el caso 5 hallado en la revisión adversarial de ese plan. Mientras
 * el cliente espera al asesor puede escribir "¿ya me atienden?" — el webhook
 * lo encola igual, y el turno sale por `pausada` (la IA sigue apagada) sin
 * contestarlo. Ese mensaje queda PENDIENTE y es ANTERIOR a la devolución.
 * Un filtro que solo mirara "¿salió algo después del último mensaje?" lo
 * habría dado por nuevo apenas alguien reactivara la IA, y la IA le habría
 * contestado un mensaje viejo dejando además el traspaso `reabierto`.
 * (Corrección T9/hallazgo 9, revisión "Seba sale sin pisar a nadie",
 * 19/9/2026: `reabierto` NO cierra la escalada para `escalationOpen` — desde
 * T8 de ese plan vive en `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`, handoffs.ts,
 * justo porque lo escribe el reconciliador por mensaje, sin que la
 * conversación cambie de dueño.)
 *
 * `new_since_ai_resume` (columna generada, migración 20260916010000)
 * resuelve las dos fallas con una sola pregunta: ¿este mensaje del cliente
 * llegó DESPUÉS de que un humano le devolvió el chat a la IA? El sello
 * `ai_resume_cutoff_at` se mueve solo con una devolución
 * (`handle_conversation_ai_resume()`), nunca con una salida — ni con la
 * despedida de la escalada ni con la respuesta a "¿ya me atienden?" (que no
 * existe, es justo el problema) — así que ninguno de los dos mensajes viejos
 * pasa por "nuevo". Va en el WHERE, no en un filtro posterior en TypeScript,
 * por el mismo motivo que las demás condiciones de esta consulta:
 * `RECONCILE_BATCH_LIMIT` corta la consulta ANTES de que el código filtre
 * nada, así que filtrar en memoria dejaría fuera huérfanas de verdad que sí
 * necesitan reencolarse.
 *
 * Hallazgo 2 del plan "Seba atiende el mostrador" (18/9/2026): con D2 (la
 * escalada ya no apaga `ai_enabled` — requisito 6 del cliente), el bucle de
 * noche vuelve por una puerta DISTINTA a la que tapó `new_since_ai_resume`.
 * Caso: la IA escala `escalada_sin_asesor` (P1, sin nadie conectado) y se
 * despide — esa despedida es `is_auto_reply`, así que `awaiting_reply` sigue
 * en `true` (el cliente sigue esperando a una PERSONA) —, nadie queda
 * asignado, y el sello `ai_resume_cutoff_at` NO se mueve (no hubo ninguna
 * devolución, la IA nunca se apagó). Sin un predicado más, esta misma
 * consulta la volvía a encontrar "esperando, sin asesor, con la IA
 * encendida" en el minuto siguiente, la reencolaba, el modelo volvía a
 * escalar con el MISMO mensaje del cliente (round-robin no aplica: sigue sin
 * candidato) — y así cada minuto hasta que alguien escribiera. `.or(...)`
 * abajo es la barrera: solo reencola si el ÚLTIMO mensaje VISIBLE de la
 * conversación es del cliente (`last_message_direction = 'inbound'`, la
 * despedida de la IA con `is_auto_reply` de esta corrida NO cuenta como algo
 * que el cliente todavía no vio — sigue siendo un saliente) o si el último
 * saliente falló (`last_message_status = 'failed'`, el caso de siempre:
 * `entrega_fallida`). Una despedida de la IA que SÍ salió bien dejó
 * `last_message_direction = 'outbound'` con `last_message_status` distinto
 * de `'failed'`, así que esta consulta la deja quieta — el reconciliador no
 * es quien tiene que reintentar una escalada que ya se hizo, solo turnos
 * huérfanos de verdad. `last_message_direction`/`last_message_status` son
 * columnas que `handle_new_message()` mantiene desde 20260822060000 (ver
 * `unansweredFreeWork` en `data.ts`, que gana el mismo `.or()` por el mismo
 * motivo — el botón "encender la IA" del atraso sufre el mismo bucle).
 */
export async function reconcileOrphanTurns(
  supabase: SupabaseClient,
  now: number = Date.now()
): Promise<ReconcileResult> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, ai_turn_lock_until, last_customer_message_at")
    .eq("awaiting_reply", true)
    .eq("new_since_ai_resume", true)
    .is("assigned_agent_id", null)
    .neq("status", "closed")
    .eq("ai_enabled", true)
    // Hallazgo 2 del plan "Seba atiende el mostrador" (18/9/2026, D2): sin
    // esto, una escalada sin asesor de noche (P1, la IA sigue encendida y se
    // despide con is_auto_reply) se reencolaba cada minuto para siempre. Ver
    // el comentario largo más arriba.
    .or("last_message_direction.eq.inbound,last_message_status.eq.failed")
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

  // Tarea C1, "El resguardo antes del push" (20/9/2026, hallazgo A): el turno
  // puede decidir callarse sobre ESTE mensaje exacto del cliente y dejarlo
  // dicho en la bitácora (`cortesia_tras_escalada`, `sin_contenido_legible`,
  // `identidad_no_verificable` — ver `RAZONES_DE_SILENCIO_DECIDIDO` en
  // handoffs.ts para el porqué de cada una y de las que quedaron afuera). Sin
  // este filtro, esa misma conversación sigue cumpliendo el predicado de
  // arriba —awaiting_reply, sin asesor, IA encendida, último mensaje del
  // cliente— y el reconciliador la reencola cada minuto: el turno vuelve a
  // mirar el MISMO mensaje, vuelve a callarse, escribe OTRO traspaso igual, y
  // así hasta que se cierran las 24 h de la ventana de Meta. Caso real: una
  // escalada sin asesor de noche (`escalada_sin_asesor`) se despide con
  // `is_auto_reply`; el cliente contesta "ok gracias"; el turno calla con
  // `cortesia_tras_escalada`; sin este filtro, esa despedida silenciosa se
  // repetía cada minuto, gastando un cupo de `AGENT_MAX_TURNS_PER_MINUTE` por
  // vuelta y atrasando turnos de clientes reales.
  //
  // Va DESPUÉS del filtro de humanos (menos candidatas a las que preguntarle
  // a `conversation_handoffs`) y ANTES de Redis, mismo criterio que el filtro
  // de arriba: evitar encolar trabajo que el turno va a descartar de todas
  // formas, sin arriesgar nunca escribirle a un cliente de más (la peor
  // consecuencia de un falso positivo acá es una respuesta tardía, nunca una
  // duplicada — el turno vuelve a comprobar todo por su cuenta).
  //
  // Si el cliente escribe de nuevo, `last_customer_message_at` avanza más
  // allá del traspaso de silencio y la conversación vuelve a ser candidata en
  // la siguiente pasada — la comparación se rehace cada vez contra la fecha
  // FRESCA que trae la consulta de arriba, no contra un valor cacheado.
  let silencioYaDecidido = 0;
  if (libres.length > 0) {
    try {
      const filasLibres = sinLock.filter((fila) => libres.includes(fila.id));
      const conSilencio = await conversationsWithDecidedSilence(supabase, filasLibres);
      const antes = libres.length;
      libres = libres.filter((id) => !conSilencio.has(id));
      silencioYaDecidido = antes - libres.length;
    } catch (err) {
      // Falla CERRADO, mismo criterio que el filtro de humanos de arriba:
      // ante la duda no se encola esta pasada. Una pasada futura, con la
      // consulta funcionando de nuevo, recupera lo que de verdad haga falta.
      log.error("reconciliador_silencio_no_consultable", { detail: errorText(err) });
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
    silencioYaDecidido,
    encoladas: porEncolar.length,
  };
}
