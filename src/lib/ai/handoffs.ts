import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// El rastro que deja una conversación al cambiar de manos.
//
// Hasta el 30/8/2026 el sistema tomaba muy bien la decisión de callarse —la
// IA está apagada, un asesor ya escribió, la ventana de 24 h venció— y muy
// mal la de contarlo: el turno hacía `return` y la conversación se quedaba
// esperando sin que nadie quedara a cargo. En la bandeja no se veía nada,
// porque ninguna de las píldoras corta por "el sistema soltó esto". El lead
// no se perdía por una mala decisión, se perdía porque la decisión correcta
// era invisible.
//
// Esto no cambia ninguna decisión: la IA sigue callándose exactamente en los
// mismos casos. Solo deja la fila que dice cuál fue y por qué.
//
// LA REGLA QUE NO SE PUEDE ROMPER: registrar un traspaso NUNCA puede tumbar
// el turno. Esto es observabilidad, no una barrera nueva. Si la escritura
// falla —Postgres caído, un CHECK que no contempla una razón nueva—, se
// registra el fallo y el turno sigue su camino. Un turno que muere por no
// poder escribir su bitácora sería, literalmente, el problema que esta tabla
// vino a resolver, pero peor: hoy el lead queda sin rastro; así quedaría sin
// rastro Y sin respuesta.
//
// Ver la migración 20260830040000_conversation_handoffs.sql y la invariante
// en CLAUDE.md.
// ---------------------------------------------------------------------------

/** Quién atiende una conversación. Espeja el CHECK de `to_kind` en la tabla. */
export type HandoffKind = "ai" | "human" | "unassigned" | "closed";

/**
 * Por qué cambió de manos. Espeja el CHECK de `reason` en la migración: si
 * acá aparece un valor que allá no está, el insert lo rechaza y el traspaso
 * se pierde (sin tumbar el turno, pero se pierde). Los valores de las Etapas
 * 2 y 3 ya están en el CHECK de la base; acá se declaran solo los que la
 * Etapa 1 usa de verdad, para que el compilador delate un uso adelantado.
 */
export type HandoffReason =
  // El webhook y el turno: `agent_can_run()` dijo que no. Fusiona a propósito
  // "IA apagada" y "tope de gasto alcanzado" — esa RPC ya las fusiona en un
  // solo booleano y separarlas costaría otra consulta en el camino caliente.
  | "agente_no_puede_correr"
  // La IA está apagada en ESTE chat (`ai_enabled = false`).
  | "pausada"
  // El chat tiene asesor asignado.
  | "asignada"
  // Una persona ya había escrito antes de que el turno abriera.
  | "humano_intervino"
  // Una persona escribió MIENTRAS el turno corría: carrera perdida en `deliver()`.
  | "humano_se_adelanto"
  // Pasadas 24 h del último mensaje del cliente, Meta rechaza el texto libre.
  | "fuera_de_ventana"
  // No se pudo congelar a quién se le habla: identidad rota, no se reintenta.
  | "identidad_no_verificable"
  // El lock de la conversación dejó de ser nuestro antes de enviar.
  | "lock_perdido"
  // La cola agotó los tres intentos.
  | "abandonado"
  // Falló después de haber intentado entregar: no se reintenta para no
  // duplicar (regla de `turn-delivery.ts`). Nace con la cola (los tres
  // intentos agotados de `abandonado` son un caso vecino); S6 (corrida "La
  // IA ve lo que llega", 8/9/2026) le suma un segundo uso: `agent.ts`
  // (`deliveryFailed`, antes `rejectedByMeta`) la escribe también cuando un
  // envío del turno falla por un corte de RED (`origenDelFallo === "red"` en
  // `send.ts`, ver `DeliveryOutcome`) — un `fetch failed` nunca llegó a la
  // Graph API, así que no es `rechazado_por_meta`. Es "reintentable por la
  // cola" igual: un saliente `failed` no apaga `awaiting_reply` (T0.1), y el
  // reconciliador la reencola sola en ≤ 5 min.
  | "entrega_fallida"
  // El reconciliador encontró una conversación esperando que nadie tenía.
  | "reabierto"
  // T0.3: escalateConversation() encontró un asesor libre y se lo asignó.
  | "escalada"
  // T0.3: escalateConversation() escaló igual, pero no había ningún asesor
  // activo — la conversación queda "assigned" sin `assigned_agent_id`.
  | "escalada_sin_asesor"
  // T0.3: Meta rechazó el envío de la IA (whatsapp_status = 'failed') después
  // de que el turno ya había pasado todas las guardas de deliver(). El
  // cliente no recibió nada; no se reintenta para no arriesgar un duplicado
  // si el rechazo fue parcial.
  | "rechazado_por_meta"
  // T2.1: un asesor cerró la conversación a mano desde el menú de la
  // bandeja o la cabecera del chat (close/route.ts).
  | "cerrada_por_asesor"
  // T2.1: un asesor reabrió a mano una conversación cerrada (reopen/route.ts).
  | "reabierta_por_asesor"
  // T2.1: el cliente le escribió a una conversación que estaba cerrada; el
  // webhook la reabre sola ANTES de guardar el mensaje entrante, para que no
  // quede invisible detrás de un status que ninguna píldora vuelve a mirar.
  | "reabierta_por_cliente"
  // T4, corrida "La IA ve lo que llega" (8/9/2026): el turno arrancó sin
  // nada legible para el modelo -- el historial armado por `loadHistory`
  // quedó vacío tras describir la media con `historyLine` (T2, misma
  // corrida), es decir que las filas que llegaron eran solo `unsupported`
  // o notas internas. Caso `cea69118…`: un audio sin texto previo dejaba el
  // historial vacío y el turno salía sin dueño, sin dejar rastro; el
  // reconciliador lo reencoló 30 veces. Con `historyLine` describiendo
  // media, esta salida pasa a ser una red de seguridad (0 de 269
  // conversaciones esperando quedarían vacías tras T2), pero cuando vuelva
  // a darse tiene que dejar traspaso igual.
  | "sin_contenido_legible"
  // Tarea 4, "La voz cercana y la espera visible" (14/9/2026): el cliente
  // cerró con puro agradecimiento/cortesía ("Ok, muchas gracias") mientras
  // la conversación seguía con una escalada abierta y ningún asesor había
  // escrito todavía (`escalationOpen`, abajo). Tras la devolución masiva
  // del 13/9/2026 un caso así recibió la despedida fija de escalada
  // ("¡Gracias por preferirnos!") — una respuesta MÁS, y ninguna de la
  // persona que el cliente en realidad espera. El turno se calla (no hay
  // pregunta nueva que contestar) pero deja esta fila, con el mismo dueño
  // que ya tenía la conversación: la migración 20260914010000 (T1, misma
  // corrida) suma el valor al CHECK de la base.
  | "cortesia_tras_escalada"
  // T1 de "La IA no vuelve a pedir lo que ya pidió" (16/9/2026): un asesor
  // devuelve el gobierno a la IA reactivando `ai_enabled` a mano sin
  // reasignar a nadie. La escribe el trigger
  // `handle_conversation_ownership_change` (20260916010000), nunca código de
  // TypeScript — existe en el CHECK desde 20260830040000 pero hasta esta
  // migración nadie la escribía de verdad.
  | "devuelto_a_ia"
  // Misma migración: un asesor suelta el caso (desasignar), con la IA
  // encendida. También la escribe el trigger de arriba, nunca TypeScript.
  | "desasignada_por_asesor"
  // Corrección post-revisión de la misma corrida (16/9/2026, hallazgo de
  // `/code-review high`): un asesor reclama un caso (lo toma sin tenerlo, o
  // se lo saca a otro asesor) sin que `ai_enabled` cambie en el mismo
  // UPDATE. Vivía en el CHECK desde 20260830040000 sin que nadie la
  // escribiera de verdad — `assignToMe`/`intervene` (mutations.ts) asignan
  // sin dejar rastro, y un chat que pasaba de manos quedaba con la última
  // fila de la bitácora en `unassigned` mientras alguien ya lo tenía.
  // También la escribe el trigger `handle_conversation_ownership_change`,
  // nunca TypeScript.
  | "reclamado"
  // T3 de la misma corrida: `runAgentTurn` encontró un mensaje del cliente
  // (`last_customer_message_at`) anterior o igual al sello de la última
  // devolución (`ai_resume_cutoff_at`) — ese mensaje ya estaba ahí cuando le
  // devolvieron el chat a la IA, no es una pregunta nueva. El turno se calla
  // sin llamar al modelo. Ver el comentario de esa guarda en agent.ts.
  | "mensaje_previo_a_devolucion"
  // T0 de "Seba atiende el mostrador" (18/9/2026, migración 20260917010000):
  // `ai_enabled` se apagó SIN que `assigned_agent_id` cambiara en el mismo
  // UPDATE — un asesor mandó su primer mensaje real (trigger AFTER INSERT ON
  // messages `handle_agent_message_silences_ai`, requisito 6 del cliente: la
  // IA sigue contestando tras escalar hasta que el asesor escribe de
  // verdad) o alguien pausó la IA a mano (`setAiEnabled(false)`,
  // `mutations.ts`). La escribe el trigger `handle_conversation_ownership_change`
  // de esa migración, NUNCA TypeScript — mismo patrón que `devuelto_a_ia`/
  // `desasignada_por_asesor`/`reclamado`.
  | "silenciada_por_asesor";

export interface HandoffInput {
  conversationId: string;
  toKind: HandoffKind;
  reason: HandoffReason;
  fromKind?: HandoffKind | null;
  fromId?: string | null;
  toId?: string | null;
  /** `system` (webhook, cola, cron) o `user` (una acción del panel). */
  createdBy?: "system" | "user";
}

/**
 * Escribe el traspaso y devuelve si quedó registrado.
 *
 * Va por la RPC `record_handoff` y no por un `insert` directo a propósito,
 * aunque `service_role` podría insertar sin intermediarios: así hay UNA sola
 * puerta de escritura a la bitácora, y cuando la Etapa 2 traiga los botones
 * de reclamar/cerrar/devolver a IA —que corren como `authenticated` y no
 * pueden insertar directo— no habrá que cambiar este helper ni abrir un
 * segundo camino. La función se ejercita desde el día uno en vez de nacer
 * sin uso.
 *
 * Nunca lanza. El booleano es para los tests y para quien quiera contar
 * fallos; ningún llamador debe cambiar su comportamiento según el resultado.
 *
 * NO sirve para la salida "la conversación no existe": `conversation_id`
 * tiene clave foránea contra `conversations`, así que no hay fila a la que
 * apuntar y el insert se rechazaría. Es correcto que lo haga —una bitácora
 * de traspasos de una conversación que no existe no significa nada—, y por
 * eso `conversacion_inexistente` no está en `HandoffReason` aunque sí esté
 * en el CHECK de la base: que el compilador lo impida es más barato que
 * descubrirlo por un `traspaso_no_registrado` en producción.
 */
export async function recordHandoff(
  supabase: SupabaseClient<Database>,
  input: HandoffInput
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc("record_handoff", {
      p_conversation_id: input.conversationId,
      p_to_kind: input.toKind,
      p_reason: input.reason,
      // Se omiten en vez de mandarse en null: los tres tienen `default null`
      // en la función, así que dejarlos fuera es exactamente lo mismo para
      // Postgres y encaja con los tipos generados, que los declaran
      // opcionales por tener default.
      p_from_kind: input.fromKind ?? undefined,
      p_from_id: input.fromId ?? undefined,
      p_to_id: input.toId ?? undefined,
      p_created_by: input.createdBy ?? "system",
    });

    if (error) {
      log.error("traspaso_no_registrado", {
        conversationId: input.conversationId,
        reason: input.reason,
        detail: error.message,
      });
      return false;
    }

    return true;
  } catch (err) {
    // Se traga TODO —incluida una excepción de red— por la regla de arriba.
    log.error("traspaso_no_registrado", {
      conversationId: input.conversationId,
      reason: input.reason,
      detail: errorText(err),
    });
    return false;
  }
}

/**
 * Igual que `recordHandoff`, pero se fabrica su propio cliente `service_role`.
 *
 * Para los llamadores que no tienen uno a mano: la cola (`queue.ts`) y el
 * reconciliador trabajan sobre ids de conversación y Redis, sin cliente de
 * Supabase abierto. Que el `createAdminClient()` viva DENTRO del try no es
 * decorativo: sin `NEXT_PUBLIC_SUPABASE_URL` o `SUPABASE_SERVICE_ROLE_KEY`
 * ese constructor lanza, y la cola lo llama desde dentro de un `catch` —una
 * excepción ahí no la recoge nadie y se lleva por delante el worker entero,
 * que es justo lo contrario de lo que esta bitácora vino a hacer.
 */
export async function recordHandoffAdmin(input: HandoffInput): Promise<boolean> {
  try {
    return await recordHandoff(createAdminClient(), input);
  } catch (err) {
    log.error("traspaso_no_registrado", {
      conversationId: input.conversationId,
      reason: input.reason,
      detail: errorText(err),
    });
    return false;
  }
}

/**
 * Razones que NO cierran una escalada abierta porque ninguna cambia a quién
 * pertenece la conversación — se escriben SOBRE el mismo dueño que dejó la
 * `escalada`/`escalada_sin_asesor`, no le entregan la conversación a nadie
 * nuevo. Tarea 5 ("La voz cercana y la espera visible", 14/9/2026): hueco
 * medido en local el 14/9 y anotado en CLAUDE.md — `escalationOpen` miraba
 * SOLO la última fila, y si el cliente volvía a escribir mientras seguía
 * asignado, `openTurn` grababa `asignada` encima de la `escalada`; la guarda
 * de cortesía dejaba de disparar y la IA volvía a despedirse dos veces.
 *
 * Una por una, por qué se escribe sin que la escalada cambie de manos:
 *   - `asignada`: la escribe `openTurn` en CADA mensaje del cliente a un chat
 *     que YA tiene asesor asignado (agent.ts:~1761) — reafirma un dueño que
 *     ya existía, no asigna uno nuevo.
 *   - `pausada`: la escribe `openTurn` cuando la IA está apagada en ESTE chat
 *     y no hay asesor (agent.ts:~1770) — la conversación sigue sin dueño
 *     nuevo, solo callada.
 *   - `agente_no_puede_correr`: la escribe `openTurn`/`deliver()` cuando el
 *     interruptor global o el tope de gasto lo impiden — tampoco mueve el
 *     dueño.
 *   - `cortesia_tras_escalada`: la escribe ESTA MISMA guarda (`runTurnPhases`
 *     en agent.ts) cuando ya decidió que la escalada sigue abierta — un
 *     segundo "gracias" no puede volver a cerrar lo que la primera fila de
 *     cortesía ya dejó abierto.
 *   - `humano_intervino`/`humano_se_adelanto`: las decide la consulta de
 *     `messages` de más abajo (paso 2), no la de `conversation_handoffs` —
 *     dejarlas fuera de esta lista sería redundante con esa consulta, pero
 *     incluirlas documenta que tampoco cierran por sí solas si por algún
 *     camino quedaran como última fila.
 *
 * T3 de "La IA no vuelve a pedir lo que ya pidió" (16/9/2026) suma UNA razón
 * más a la lista, y a propósito NO suma `devuelto_a_ia`/`desasignada_por_asesor`
 * (la primera versión de este plan, del 15/9, sí las había sumado — revisar
 * el diff viejo de este archivo antes de repetir el error):
 *   - `mensaje_previo_a_devolucion`: la escribe la guarda de T3 (agent.ts,
 *     apertura de `runAgentTurn`) cuando el turno se calla porque el mensaje
 *     del cliente ya estaba ahí antes de que le devolvieran el chat a la IA
 *     — ni siquiera llegó a mirar si había una escalada abierta. Tratarla
 *     como cierre dejaría a `escalationOpen` mirando su propia salida
 *     silenciosa como si fuera un movimiento de dueño real, exactamente el
 *     mismo hueco que `cortesia_tras_escalada` (arriba) vino a tapar.
 *   - `devuelto_a_ia`/`desasignada_por_asesor` SÍ CIERRAN la escalada, y por
 *     eso NO están en esta lista: un humano decidió, a propósito, devolverle
 *     el chat a la IA — eso es un movimiento de dueño real, no un eco de la
 *     propia IA. Si no cerraran, un "gracias" que el cliente escribe DESPUÉS
 *     de la devolución quedaría callado por la guarda de cortesía
 *     (`runTurnPhases` en agent.ts), contra la decisión del operador de que
 *     la IA solo responde a lo que el cliente escriba después de que se la
 *     devuelven. (La corrida del 15/9 había razonado justo al revés —que
 *     cerrar la escalada aquí "tapaba" la guarda de cortesía— pero esa
 *     lectura confundía la escalada VIEJA, que sí debe darse por cerrada,
 *     con la posibilidad de una escalada NUEVA sobre el mismo chat.)
 *
 * Corrección post-revisión de la misma corrida (16/9/2026, `/code-review
 * high`): `reclamado` (un asesor toma el caso) tampoco está en esta lista,
 * por el mismo motivo que `devuelto_a_ia`/`desasignada_por_asesor` — un
 * asesor reclamando el chat es un movimiento de dueño real, y la escalada
 * vieja debe darse por cerrada aunque el nuevo dueño sea un humano y no la
 * IA.
 *
 * T0/T4 de "Seba atiende el mostrador" (18/9/2026): `silenciada_por_asesor`
 * (un asesor mandó su primer mensaje real, o alguien pausó la IA a mano) NO
 * entra en esta lista, por el MISMO motivo que `reclamado`/`devuelto_a_ia`/
 * `desasignada_por_asesor` — un humano tomando el chat de verdad SÍ cambia
 * de manos, así que cierra la escalada vieja. Con D2 la IA sigue
 * contestando después de escalar hasta que eso pasa; si esta razón no
 * cerrara, la guarda de cortesía (`cortesia_tras_escalada`) seguiría
 * callando a la IA sobre un chat que un asesor ya tomó de verdad.
 *
 * T8 de "Seba sale sin pisar a nadie" (19/9/2026, hallazgo M6 de la
 * inspección pre-despliegue del mismo día): `reabierto` SÍ suma a esta
 * lista, con el mismo motivo que `asignada`/`pausada`/
 * `agente_no_puede_correr` — la escribe el reconciliador (`reconciler.ts`)
 * CADA VEZ que reencola un turno huérfano, sin que nadie cambie de dueño;
 * no era ninguna decisión nueva sobre a quién pertenece la conversación,
 * solo "vuelvo a intentar". Sin sumarla, un reencolado sobre una escalada
 * abierta tapaba la fila `escalada`/`escalada_sin_asesor` como si fuera "lo
 * último que pasó de verdad", `escalationOpen` daba `false` y la guarda de
 * cortesía dejaba de disparar — la IA podía volver a despedirse dos veces
 * sobre un cliente que seguía esperando al mismo asesor.
 *
 * Ver la migración 20260830040000_conversation_handoffs.sql (el CHECK de
 * `reason`) y CLAUDE.md.
 */
const RAZONES_QUE_NO_CIERRAN_LA_ESCALADA: HandoffReason[] = [
  "asignada",
  "pausada",
  "agente_no_puede_correr",
  "cortesia_tras_escalada",
  "humano_intervino",
  "humano_se_adelanto",
  "mensaje_previo_a_devolucion",
  "reabierto",
];

/**
 * ¿Sigue abierta la última escalada de esta conversación? Tarea 4, "La voz
 * cercana y la espera visible" (14/9/2026): se pregunta ANTES de dejarle
 * hablar a la IA sobre un mensaje que es puro agradecimiento/cortesía — si
 * la respuesta es sí, el turno se calla en vez de despedirse otra vez de
 * alguien que ya está esperando a un asesor (ver `runTurnPhases` en
 * agent.ts, guarda de cortesía).
 *
 * `true` solo si SE CUMPLEN LAS DOS COSAS:
 *   1. La ÚLTIMA fila de `conversation_handoffs` de esta conversación QUE
 *      CAMBIA DE MANOS (Tarea 5, 14/9/2026: se excluyen con `.not("reason",
 *      "in", …)` las razones de `RAZONES_QUE_NO_CIERRAN_LA_ESCALADA`, arriba
 *      — `asignada`/`pausada`/`agente_no_puede_correr`/
 *      `cortesia_tras_escalada`/`humano_intervino`/`humano_se_adelanto`) es
 *      una escalada — `escalada` (con asesor) o `escalada_sin_asesor` (sin
 *      ninguno libre). Si esa fila es cualquier otra cosa —la conversación
 *      se cerró, se reabrió, un asesor la reclamó a mano— la escalada ya no
 *      es "lo último que pasó de verdad" y esto devuelve `false`. Una razón
 *      DESCONOCIDA futura (fuera del CHECK de hoy) no está en la lista de
 *      exclusión, así que cuenta como cierre: el mismo sesgo hacia responder
 *      que ya tiene el resto de la función.
 *   2. Ningún `messages` con `sender_type = 'agent'` (un asesor humano,
 *      nunca `'ai'`) quedó con `created_at` posterior a esa fila: si un
 *      asesor ya escribió, la conversación pasó a ser SUYA y la IA no tiene
 *      por qué seguir en silencio.
 *
 * Falla CERRADO hacia `false` (ante cualquier error de cualquiera de las dos
 * consultas, la IA atiende normal): equivocarse hacia ese lado cuesta, como
 * mucho, una despedida de más — equivocarse hacia el otro sería la IA muda
 * en una conversación que ya no tiene ninguna escalada pendiente, que es el
 * defecto que esta función existe para no repetir en el sentido contrario.
 */
export async function escalationOpen(
  supabase: SupabaseClient<Database>,
  conversationId: string
): Promise<boolean> {
  try {
    // `.not("reason", "in", "(a,b,c)")` es la forma que usa supabase-js para
    // el operador PostgREST `not.in`: la lista va entre paréntesis y SIN
    // comillas por valor (precedente ya en el repo: `customers-data.ts`,
    // `.not("id", "in", \`(${buyers.join(",")})\`)`); los valores de
    // `HandoffReason` son identificadores simples (sin comas ni paréntesis),
    // así que un `join(",")` alcanza sin escapar nada.
    const { data: ultimoTraspaso, error: traspasoError } = await supabase
      .from("conversation_handoffs")
      .select("reason, created_at")
      .eq("conversation_id", conversationId)
      .not("reason", "in", `(${RAZONES_QUE_NO_CIERRAN_LA_ESCALADA.join(",")})`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (traspasoError) {
      log.error("escalada_abierta_no_consultable", { conversationId, detail: traspasoError.message });
      return false;
    }

    if (!ultimoTraspaso || (ultimoTraspaso.reason !== "escalada" && ultimoTraspaso.reason !== "escalada_sin_asesor")) {
      return false;
    }

    const { data: mensajesDeAsesor, error: mensajesError } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("sender_type", "agent")
      .gt("created_at", ultimoTraspaso.created_at)
      .limit(1);

    if (mensajesError) {
      log.error("escalada_abierta_no_consultable", { conversationId, detail: mensajesError.message });
      return false;
    }

    return (mensajesDeAsesor ?? []).length === 0;
  } catch (err) {
    log.error("escalada_abierta_no_consultable", { conversationId, detail: errorText(err) });
    return false;
  }
}
