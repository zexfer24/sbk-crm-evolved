import "server-only";
import { ToolLoopAgent, isStepCount, type LanguageModelUsage, type ModelMessage, type ToolSet } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Playbook, Tag } from "@/lib/types";
import { parseBusinessHours, type BusinessHours } from "@/lib/business-hours";
import { createAdminClient } from "@/lib/supabase/admin";
import { classifyIntent, type Intent } from "@/lib/ai/classify";
import { currentAgentModelLabel, getAgentModel } from "@/lib/ai/model";
import { OFF_TOPIC_REPLY, buildInstructions } from "@/lib/ai/prompt";
import { buildCatalogTool, buildEscalateTool, buildOrderHistoryTool, type EscalationOutcome } from "@/lib/ai/tools";
import { TOOL_KEYS, fetchEnabledToolKeys } from "@/lib/ai/agent-tools";
import { buildKnowledgeTool } from "@/lib/ai/knowledge";
import { escalateConversation } from "@/lib/ai/escalate";
import { withConversationTurnLock, type TurnLease } from "@/lib/ai/conversation-lock";
import { humanHasWritten } from "@/lib/ai/human-handled";
import { fetchActivePlaybooks, matchPlaybook, playbookSentRecently } from "@/lib/ai/playbooks";
import { playbookMessageText, sendAgentText, sendPlaybookReply, type DeliveryOutcome } from "@/lib/ai/send";
import { buildTurnTarget, type AgentConversation, type TurnTarget } from "@/lib/ai/turn-target";
import { NonRetryableTurnError, newTurnDelivery, type TurnDelivery } from "@/lib/ai/turn-delivery";
import { recordHandoff } from "@/lib/ai/handoffs";
import { errorText, log } from "@/lib/log";
import { withinFreeformWindow } from "@/lib/dashboard";
import { isWithin24hWindow } from "@/lib/whatsapp-window";
import { sendTypingIndicator } from "@/lib/whatsapp/meta-client";

// ---------------------------------------------------------------------------
// Orquestador del turno del agente. Dos tiempos:
//
//   0 y 1. En PARALELO, porque no dependen una de la otra: reconocer si el
//      mensaje calza con una respuesta predeterminada, y clasificar la
//      intención (una de cinco categorías genéricas). Si calza un escenario,
//      se envía ese texto tal cual y el turno termina ahí, sin redactar.
//   2. Actuar con las herramientas acotadas a esa intención.
//
// Lo dispara la cola, una vez por conversación (ver src/lib/ai/queue.ts).
//
// A quién le hablamos no se deduce en ningún paso: se verifica una vez al
// abrir el turno y viaja como un TurnTarget congelado hasta el envío (ver
// turn-target.ts). Ninguna de las tres fases recibe un id suelto que pueda
// venir de otro lado.
// ---------------------------------------------------------------------------

const MAX_STEPS = 5;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Cuánto tarda un turno, por tramo.
//
// El dueño quiere respuesta en cuatro segundos. Para discutir ese número hace
// falta saber dónde se van los que se van, y hasta ahora la única forma de
// averiguarlo era restar a mano dos columnas de `messages` conversación por
// conversación. Una línea por turno lo deja en un grep.
//
// Va al registro y no a una tabla a propósito: es una medida de operación, no
// un dato del negocio. No merece una migración, no merece crecer sin límite en
// Postgres, y el sitio donde se mira es el mismo donde ya se miran los fallos.
// ---------------------------------------------------------------------------
interface TurnTiming {
  /** Del mensaje del cliente al arranque del turno: ventana de silencio más cola. */
  esperaMs: number | null;
  /** Escenario y clasificación, que corren juntos: tarda lo que la más lenta. */
  clasificacionMs: number | null;
  /** El tool loop entero, incluidas las herramientas que haya usado. */
  redaccionMs: number | null;
  /** Lo que cuesta entregarlo: la Graph API de Meta manda acá. */
  envioMs: number | null;
  /** Pasos del tool loop que el turno gastó de verdad, contra el techo MAX_STEPS. */
  pasos: number | null;
}

type TimingPhase = "clasificacionMs" | "redaccionMs" | "envioMs";

function newTurnTiming(lastCustomerMessageAt: string | null): TurnTiming {
  const desde = lastCustomerMessageAt ? Date.parse(lastCustomerMessageAt) : NaN;

  return {
    esperaMs: Number.isNaN(desde) ? null : Date.now() - desde,
    clasificacionMs: null,
    redaccionMs: null,
    envioMs: null,
    pasos: null,
  };
}

/**
 * Corre `fn` y anota cuánto tardó. Mide también cuando lanza: un tramo que
 * falló después de veinte segundos es justo el que hay que ver.
 */
async function medir<T>(tiempos: TurnTiming, fase: TimingPhase, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    tiempos[fase] = Date.now() - t0;
  }
}

interface TurnTokens {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * Parte de `inputTokens` que el proveedor sirvió desde su caché de prompts.
   *
   * Se guarda porque se factura mucho más barata y porque es la única señal
   * de que el prefijo estático sigue cacheando: si alguien edita el prompt y
   * rompe el prefijo, esto cae a cero y se ve en el panel.
   */
  cachedInputTokens: number;
}

function tokensFromUsage(usage: LanguageModelUsage): TurnTokens {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
  };
}

function addTokens(a: TurnTokens, b: TurnTokens): TurnTokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
}

/**
 * Mensajes que se le pasan al modelo.
 *
 * Quince cubren de sobra el ida y vuelta de una consulta por WhatsApp, que
 * es lo que el agente necesita para responder. Subirlo encarece cada turno
 * —el historial viaja en las tres fases— sin aportar contexto que se use.
 */
const HISTORY_LIMIT = 15;

/**
 * Últimos mensajes de la conversación, en orden cronológico.
 *
 * Se piden DESCENDENTES y se invierten. Pedirlos ascendentes con `limit`
 * traía los treinta MÁS ANTIGUOS: en un cliente recurrente la IA leía la
 * conversación de hace semanas y no veía el mensaje que tenía que responder.
 */
async function loadHistory(supabase: SupabaseClient<Database>, conversationId: string): Promise<ModelMessage[]> {
  const { data } = await supabase
    .from("messages")
    .select("sender_type, content, is_internal_note, message_type")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  const messages: ModelMessage[] = [];
  for (const row of [...(data ?? [])].reverse()) {
    // 'unsupported' (T3.2, 5/9/2026) es Meta avisando de un tipo que el CRM
    // no sabe representar: `content` ya queda null en la base, pero el
    // filtro es explícito y no depende de esa nulidad — un mensaje que el
    // asesor no puede leer en la burbuja tampoco debe entrar al contexto del
    // modelo. Un 'order' SÍ entra: su `content` ya es el resumen en español
    // que arma el webhook (ítems y total), así que no necesita tratamiento
    // aparte acá.
    if (row.is_internal_note || row.sender_type === "system" || row.message_type === "unsupported" || !row.content)
      continue;
    messages.push({ role: row.sender_type === "customer" ? "user" : "assistant", content: row.content });
  }
  return messages;
}

/** Último mensaje del cliente del turno: es lo que se guarda en la bitácora para poder crear el escenario que faltó. */
function lastCustomerMessage(history: ModelMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role === "user" && typeof message.content === "string") return message.content;
  }
  return null;
}

/**
 * El wamid del último mensaje ENTRANTE de la conversación (T3.1, 4/9/2026):
 * es el "message_id" que la Cloud API exige para mostrar "escribiendo…" — no
 * hay forma de dispararlo sin apuntar a un mensaje concreto. Consulta aparte
 * de `loadHistory`: esa trae texto para el modelo, no wamids, y esto solo
 * hace falta cuando SÍ se va a redactar con el tool loop.
 */
async function lastInboundWamid(
  supabase: SupabaseClient<Database>,
  conversationId: string
): Promise<string | null> {
  const { data } = await supabase
    .from("messages")
    .select("whatsapp_message_id")
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.whatsapp_message_id as string | null | undefined) ?? null;
}

/**
 * Le avisa al cliente que el agente está redactando (T3.1, 4/9/2026), solo
 * dentro de la ventana de 24h de Meta y solo con el canal real conectado —
 * fuera de ahí no hay a quién avisarle, o Meta lo rechazaría igual que
 * rechaza el texto libre. Nunca lanza ni se espera: `sendTypingIndicator` ya
 * atrapa su propio fallo (ver meta-client.ts), y un typing que se demora no
 * puede sumarle latencia a la redacción real.
 */
function fireTypingIndicator(
  supabase: SupabaseClient<Database>,
  target: TurnTarget,
  lastCustomerMessageAt: string | null
): void {
  if (!isWithin24hWindow(lastCustomerMessageAt)) return;
  if (target.channelStatus !== "connected" || !target.phoneNumberId) return;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) return;

  void lastInboundWamid(supabase, target.conversationId)
    .then((wamid) => {
      if (!wamid) return;
      return sendTypingIndicator(target.phoneNumberId!, accessToken, wamid);
    })
    // Red de más: `sendTypingIndicator` ya no lanza (ver meta-client.ts), pero
    // la consulta del wamid sí podría fallar contra la base. Cualquiera de
    // las dos cosas es un aviso que no salió, nunca un turno que se cae.
    .catch((err) => {
      log.warn("turno_typing_fallido", { conversationId: target.conversationId, detail: errorText(err) });
    });
}

/**
 * ¿Le toca al agente saludar en este turno?
 *
 * La plantilla de bienvenida solo sale si WHATSAPP_WELCOME_TEMPLATE está
 * configurada; sin esa variable `welcome_sent_at` se queda en null para
 * siempre y nadie saluda nunca. Pero mirar solo esa columna haría que el
 * agente saludara en CADA mensaje, así que se exige además que no haya
 * respondido antes en esta conversación.
 */
function needsGreeting(welcomeSentAt: string | null, history: ModelMessage[]): boolean {
  return !welcomeSentAt && !history.some((message) => message.role === "assistant");
}

/** true si nuestra última respuesta ya fue la redirección de fuera de tema. */
function alreadyRedirected(history: ModelMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role !== "assistant") continue;
    return message.content === OFF_TOPIC_REPLY;
  }
  return false;
}

/**
 * ¿Nuestra última respuesta ya fue este mismo escenario?
 *
 * Segunda red, no la principal: la que decide es la ventana de seis horas
 * contra `agent_turns` (ver playbookSentRecently). Esta cubre el hueco que
 * aquella tiene por construcción — si el turno murió entre el envío y la
 * bitácora (`turno_fallo_tras_envio`), `agent_turns` no tiene la fila pero el
 * mensaje sí salió, y el historial lo prueba.
 *
 * Cuesta cero: el historial ya está cargado, así que se pregunta primero y a
 * menudo ahorra la consulta.
 *
 * La comparación es contra el texto tal como SALE —con el enlace pegado
 * abajo si el escenario lo lleva—, porque es eso lo que quedó guardado en el
 * historial. De ahí que el compositor viva en send.ts y no acá.
 */
function alreadySentPlaybook(history: ModelMessage[], playbook: Playbook): boolean {
  const enviado = playbookMessageText(playbook);
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role !== "assistant") continue;
    return message.content === enviado;
  }
  return false;
}

interface LogTurnParams {
  intent: Intent | null;
  action: "answered" | "escalated" | "error";
  summary: string;
  tokens: TurnTokens | null;
  playbookId?: string | null;
  customerMessage?: string | null;
}

async function logTurn(supabase: SupabaseClient<Database>, conversationId: string, params: LogTurnParams) {
  await supabase.from("agent_turns").insert({
    conversation_id: conversationId,
    intent: params.intent,
    action: params.action,
    summary: params.summary.slice(0, 500),
    model: currentAgentModelLabel(),
    input_tokens: params.tokens?.inputTokens ?? null,
    output_tokens: params.tokens?.outputTokens ?? null,
    total_tokens: params.tokens?.totalTokens ?? null,
    cached_input_tokens: params.tokens?.cachedInputTokens ?? null,
    playbook_id: params.playbookId ?? null,
    customer_message: params.customerMessage ?? null,
  });
}

/**
 * Aplica al contacto las etiquetas configuradas en el escenario.
 *
 * No lanza. Cuando esto corre, el mensaje al cliente YA salió: un fallo
 * etiquetando no puede tumbar el turno ni, sobre todo, impedir que el caso
 * llegue a un asesor. Pero sí queda registrado — que es exactamente lo que
 * no hacía el etiquetado de reclamos de escalate.ts, donde una etiqueta que
 * no aparecía se saltaba en silencio.
 *
 * `ignoreDuplicates` porque la etiqueta ya puesta se respeta: el escenario
 * puede dispararse varias veces con el mismo contacto y no tiene sentido
 * pisarle la fecha a una marca que ya estaba.
 */
async function applyPlaybookTags(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  contactId: string,
  tags: Tag[]
): Promise<void> {
  if (tags.length === 0) return;

  const { error } = await supabase
    .from("contact_tags")
    .upsert(
      tags.map((tag) => ({ contact_id: contactId, tag_id: tag.id })),
      { ignoreDuplicates: true }
    );

  if (error) {
    log.error("escenario_etiquetado_fallido", {
      conversationId,
      tagIds: tags.map((tag) => tag.id).join(","),
      detail: error.message,
    });
  }
}

/**
 * ¿La IA sigue encendida AHORA?
 *
 * El interruptor se miraba una sola vez, al abrir el turno, y después el turno
 * corría entero: reconocer escenario, clasificar, hasta cinco pasos del tool
 * loop y enviar. Entre esa comprobación y el envío pasan decenas de segundos
 * —más desde que los reintentos esperan en segundos—, así que apagar la IA no
 * paraba nada de lo que ya estaba en vuelo: hasta tres turnos seguían y le
 * escribían al cliente igual. El dueño apagaba y los mensajes seguían saliendo.
 *
 * Volver a preguntar justo antes de hablar es lo que convierte el interruptor
 * en un freno de emergencia de verdad. Lo que ya se gastó en el modelo se
 * gastó; lo que no pasa es que el cliente lo reciba.
 *
 * Falla cerrado: si no se puede preguntar, no se envía. Un botón de pánico que
 * ante la duda sigue adelante no es un botón de pánico.
 */
async function stillEnabled(supabase: SupabaseClient<Database>, conversationId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("agent_can_run");
    if (error) throw new Error(error.message);
    if (!data) log.warn("turno_abortado_por_interruptor", { conversationId });
    return Boolean(data);
  } catch (err) {
    log.error("turno_interruptor_no_consultable", { conversationId, detail: errorText(err) });
    return false;
  }
}

/**
 * ¿Se metió una persona entre la apertura del turno y este envío?
 *
 * `runAgentTurn` ya preguntó esto al abrir. Que acá vuelva a decir que sí
 * significa necesariamente que el asesor escribió MIENTRAS el turno corría —no
 * hay otra lectura posible, porque si hubiera escrito antes el turno no habría
 * llegado hasta acá—. De ahí que el evento sea propio y no el
 * `turno_chat_de_una_persona` de la apertura: uno cuenta chats que la IA no
 * tocó, este cuenta carreras perdidas.
 *
 * Falla cerrado igual que la comprobación de apertura, y por el mismo motivo:
 * no contestar deja a un cliente esperando un rato más; contestar encima de un
 * asesor le escribe a alguien que está a mitad de una venta.
 */
async function humanWroteMeanwhile(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  fase: SendPhase
): Promise<boolean> {
  try {
    if (!(await humanHasWritten(supabase, conversationId))) return false;
  } catch (err) {
    log.error("turno_persona_no_consultable", { conversationId, fase, detail: errorText(err) });
    return true;
  }

  log.warn("turno_persona_se_adelanto", { conversationId, fase });
  return true;
}

/** Desde qué punto del turno se está intentando hablar. Viaja al registro. */
type SendPhase = "escenario" | "fuera_de_tema" | "redaccion";

/**
 * La única puerta por la que un turno le pone algo delante al cliente.
 *
 * Los tres caminos que hablan —escenario, redirección de fuera de tema y
 * texto redactado— repetían el mismo trío: comprobar, marcar `intentado`,
 * medir el envío. Tres copias de una regla es una regla que se olvida en el
 * cuarto camino, y el 27 de agosto de 2026 se olvidó algo peor: la
 * comprobación del asesor NO estaba en el trío. Se miraba una sola vez, al
 * abrir el turno, y entre esa mirada y el envío pasan de 3 a 10 segundos
 * (clasificar 2,2–3,5 s, redactar 3,5–6,5 s, entregar 0,83–1,14 s, medido en
 * producción). Un asesor entró en ese hueco y la IA le escribió encima, en
 * medio de una venta que estaba cerrando.
 *
 * Ahora los tres caminos pasan por acá y no hay ninguno que pueda saltarse
 * las guardas: esta función es la dueña de `entrega.intentado` y del tramo
 * `envioMs`, así que un envío que la esquive no queda ni marcado como
 * intentado ni medido — y eso se ve.
 *
 * Queda una ventana irreducible: la que dura la llamada a Meta, ~1 s. Cerrarla
 * del todo exigiría un candado que tomara también el asesor al escribir desde
 * el CRM. Lo que se cerró es el hueco de 3–10 s, que es donde vivía el
 * incidente.
 *
 * Devuelve el resultado de `enviar()`, o `null` si una guarda lo frenó antes
 * de intentar nada: en ese caso el turno sigue siendo reintentable. Genérico
 * en `T` desde T0.3: los tres caminos que llaman acá mandan una `enviar` que
 * devuelve `DeliveryOutcome` (`sendAgentText`/`sendPlaybookReply`), y quien
 * llama necesita ese valor para mirar `whatsapp_status` — antes `deliver`
 * devolvía un `boolean` que se comía el resultado real del envío.
 */
async function deliver<T>(
  supabase: SupabaseClient<Database>,
  target: TurnTarget,
  entrega: TurnDelivery,
  lease: TurnLease,
  tiempos: TurnTiming,
  fase: SendPhase,
  enviar: () => Promise<T>
): Promise<T | null> {
  const { conversationId } = target;

  // `confirmar()` es a la vez renovación y verificación de propiedad:
  // renovar justo antes de hablar es lo que evita que el lease se venza en
  // el segundo más caro del turno. La ventana irreducible que queda es la de
  // la llamada a Meta (~1 s), la misma ya documentada arriba para la guarda
  // del asesor.
  if (!(await lease.confirmar())) {
    log.warn("turno_lock_perdido_sin_enviar", { conversationId, fase });
    await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "lock_perdido" });
    return null;
  }

  if (!(await stillEnabled(supabase, conversationId))) {
    await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "pausada" });
    return null;
  }
  if (await humanWroteMeanwhile(supabase, conversationId, fase)) {
    await recordHandoff(supabase, { conversationId, toKind: "human", reason: "humano_se_adelanto" });
    return null;
  }

  // Se marca ANTES de enviar: si el envío falla a mitad no sabemos si el
  // mensaje salió, y ante la duda el turno deja de ser reintentable. Ver
  // turn-delivery.ts.
  entrega.intentado = true;
  return await medir(tiempos, "envioMs", enviar);
}

/**
 * ¿Meta rechazó de plano el envío que ya pasó todas las guardas de `deliver`?
 *
 * Un `whatsapp_status: "failed"` acá es distinto de cualquier guarda de
 * arriba: no es que el turno decidiera callarse, es que SÍ intentó hablar y
 * el proveedor lo rechazó — el cliente se quedó exactamente igual de sin
 * respuesta, pero antes de T0.3 el turno seguía como si hubiera contestado
 * (`logTurn` con action "answered", `journey_stage` reseteado): la
 * conversación quedaba sin dueño en la bitácora aunque el mensaje nunca
 * hubiera llegado. No se reintenta — reintentar no arregla un rechazo del
 * proveedor y arriesga mandarlo dos veces si Meta lo aceptó a medias.
 *
 * `yaEscalada` (5/9/2026): en el tool loop, devolución/queja terminan
 * SIEMPRE escaladas —por el modelo con la herramienta, o por la red de
 * seguridad forzada más abajo— y `escalateConversation` ya deja su propio
 * traspaso (`escalada` con asesor, `escalada_sin_asesor` sin uno) ANTES de
 * que se intente el envío final. Si ese envío es justo el que Meta rechaza,
 * escribir ADEMÁS `rechazado_por_meta` con `toKind: "unassigned"` pisaría esa
 * fila: como el conteo "Sin dueño" mira la ÚLTIMA fila de
 * `conversation_handoffs`, una conversación que sí quedó con asesor asignado
 * aparecería como sin dueño. Un solo traspaso por salida, el más específico:
 * con `yaEscalada` en true se deja el `log.warn` —Meta sí rechazó, y eso
 * tiene que verse— pero no se vuelve a llamar a `recordHandoff`.
 *
 * A3 (5/9/2026, tablero de Atascados): en la rama SIN escalar, este `return`
 * salía antes de que `runPlaybook`/`runTurnPhases` llegaran a su propio
 * reseteo de `journey_stage`/`active_tool` (los de después de un envío que sí
 * salió) — el tablero seguía viendo "Clasificando" o "Herramienta" mucho
 * después de que el turno terminara, como si el cliente estuviera esperando
 * una fase que ya no existe. Se limpia acá, en el único lugar por el que
 * pasan los tres consumidores. NO se toca en la rama `yaEscalada`: ahí
 * `escalateConversation` ya dejó `journey_stage = "assigned"` (ver
 * `escalate.ts`) ANTES del intento de envío, y pisarlo con `null`
 * disfrazaría de "sin escalar" un caso que sí tiene asesor.
 */
async function rejectedByMeta(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  entrega: DeliveryOutcome,
  yaEscalada = false
): Promise<boolean> {
  if (entrega.whatsapp_status !== "failed") return false;

  if (yaEscalada) {
    log.warn("turno_rechazado_por_meta", {
      conversationId,
      codigo: entrega.whatsapp_error_code,
      traspaso_omitido: "escalada_previa",
    });
    return true;
  }

  log.warn("turno_rechazado_por_meta", { conversationId, codigo: entrega.whatsapp_error_code });
  await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "rechazado_por_meta" });

  // La fila de traspaso ya quedó escrita arriba; este `update` es solo
  // observabilidad del tablero y no puede tumbar el turno si falla (misma
  // regla que `recordHandoff`: registrar nunca frena al que registra).
  const { error } = await supabase
    .from("conversations")
    .update({ journey_stage: null, active_tool: null })
    .eq("id", conversationId);
  if (error) {
    log.error("turno_etapa_no_reseteada_tras_rechazo", { conversationId, detail: error.message });
  }

  return true;
}

/** Sufijo para la bitácora: qué quedó etiquetado, por nombre. Vacío si no había etiquetas. */
function tagSummary(tags: Tag[]): string {
  return tags.length === 0 ? "" : ` Etiquetas: ${tags.map((tag) => tag.label).join(", ")}.`;
}

/**
 * Ejecuta una respuesta predeterminada. No llama al modelo en ningún punto:
 * el texto sale tal cual está guardado. El modelo eligió CUÁL responder;
 * nunca CÓMO se redacta.
 *
 * El orden de los tres pasos —responder, etiquetar, escalar— no es
 * indistinto. Etiquetar va ANTES de escalar para que el asesor abra el chat
 * ya clasificado y no lo vea cambiar de color debajo del cursor; y va
 * después de responder porque el cliente esperando es lo primero.
 */
async function runPlaybook(
  supabase: SupabaseClient<Database>,
  target: TurnTarget,
  entrega: TurnDelivery,
  lease: TurnLease,
  playbook: Playbook,
  tokens: TurnTokens,
  customerMessage: string | null,
  tiempos: TurnTiming,
  lastCustomerMessageAt: string | null,
  businessHours: BusinessHours
): Promise<void> {
  // Última mirada a las guardas antes de hablarle al cliente. Si la IA se apagó
  // —o si un asesor se metió— mientras el modelo elegía el escenario, el turno
  // termina acá sin enviar y sin etiquetar ni escalar: todo lo que sigue
  // acompaña a un mensaje que no salió.
  const salida = await deliver(supabase, target, entrega, lease, tiempos, "escenario", () =>
    sendPlaybookReply(supabase, target, playbook)
  );
  if (!salida) return;
  if (await rejectedByMeta(supabase, target.conversationId, salida)) return;

  // Se etiqueta siempre que el escenario responda, escale o no: un escenario
  // que deja al cliente esperando también puede querer dejar marcado el caso.
  await applyPlaybookTags(supabase, target.conversationId, target.contactId, playbook.tags);

  if (playbook.afterSend === "escalate") {
    const result = await escalateConversation(supabase, {
      conversationId: target.conversationId,
      contactId: target.contactId,
      motivo: "seguimiento",
      resumen: `Respuesta automática "${playbook.name}". Falta que un asesor continúe el caso.`,
      businessHours,
    });

    // Anexo B2 (5/9/2026): el texto de este escenario salió ANTES de saber si
    // iba a hacer falta un asesor —T0.3 exige ese orden: nada puede acompañar
    // a un mensaje que Meta ya rechazó—, así que se insertó con
    // is_auto_reply = false y handle_new_message ya lo contó como respuesta
    // real. Si escalateConversation acaba de descubrir que no había NADIE,
    // se marca ahora, después, todo lo que la IA mandó en este turno: el
    // trigger que sumó B1 (20260905070000_auto_reply_recalcula) recalcula
    // last_reply_at/awaiting_reply al ver que is_auto_reply pasó a true. La
    // ventana "desde el último mensaje del cliente" es exacta porque dentro
    // de un turno solo escribe la IA —si un humano escribe, deliver() frena
    // el envío antes de que llegue acá— y este turno responde a lo que el
    // cliente dijo después de su último mensaje, nunca a un turno anterior.
    if (result.unassigned) {
      if (lastCustomerMessageAt === null) {
        // No debería darse en un turno real: withinFreeformWindow ya exige
        // last_customer_message_at para que el turno llegue hasta acá. Pero
        // el tipo lo permite, y sin esa fecha no hay ventana fiable — marcar
        // por conversación a secas arriesgaría atrapar la despedida de un
        // turno ANTERIOR que no tiene nada que ver con este escalamiento.
        // Se prefiere no marcar y dejar constancia en el registro.
        log.warn("turno_escenario_sin_fecha_cliente", { conversationId: target.conversationId });
      } else {
        const { error } = await supabase
          .from("messages")
          .update({ is_auto_reply: true })
          .eq("conversation_id", target.conversationId)
          .eq("direction", "outbound")
          .eq("sender_type", "ai")
          .eq("is_internal_note", false)
          .gt("created_at", lastCustomerMessageAt);

        if (error) {
          // Observabilidad de awaiting_reply, no una barrera: el traspaso
          // escalada_sin_asesor ya quedó escrito por escalateConversation, y
          // el turno sigue igual aunque este UPDATE falle.
          log.error("turno_escenario_despedida_no_marcada", {
            conversationId: target.conversationId,
            detail: error.message,
          });
        } else {
          log.info("turno_escenario_sin_asesor_marcado", {
            conversationId: target.conversationId,
            desde: lastCustomerMessageAt,
          });
        }
      }
    }

    await logTurn(supabase, target.conversationId, {
      intent: null,
      action: "escalated",
      summary: `Escenario "${playbook.name}" → ${result.assignedAgentName ?? "(sin asesor disponible)"}.${tagSummary(playbook.tags)}`,
      tokens,
      playbookId: playbook.id,
      customerMessage,
    });
    return;
  }

  await supabase
    .from("conversations")
    .update({ journey_stage: null, active_tool: null })
    .eq("id", target.conversationId);

  await logTurn(supabase, target.conversationId, {
    intent: null,
    action: "answered",
    summary: `Escenario "${playbook.name}".${tagSummary(playbook.tags)}`,
    tokens,
    playbookId: playbook.id,
    customerMessage,
  });
}

/**
 * Las tres fases del turno, con el destinatario ya verificado.
 *
 * Corre dentro del lock de conversación. Todo lo que le hable al cliente
 * pasa por `entrega`, que es lo que decide si un fallo posterior se puede
 * reintentar o no.
 */
async function runTurnPhases(
  supabase: SupabaseClient<Database>,
  target: TurnTarget,
  convo: AgentConversation,
  entrega: TurnDelivery,
  lease: TurnLease,
  tiempos: TurnTiming,
  businessHours: BusinessHours
): Promise<void> {
  const conversationId = target.conversationId;

  await supabase
    .from("conversations")
    .update({ journey_stage: "classifying", active_tool: null })
    .eq("id", conversationId);

  const history = await loadHistory(supabase, conversationId);
  if (history.length === 0) return;

  const customerMessage = lastCustomerMessage(history);

  // Fases 0 y 1 — ¿el mensaje calza con una respuesta ya redactada, y qué
  // caso es? Si calza un escenario, se envía tal cual y el turno termina ahí:
  // el cliente recibe el texto oficial en vez de una versión que el modelo
  // improvise.
  // Los interruptores del panel se leen junto con los escenarios: ambos
  // son configuración que el equipo cambia en vivo y el turno respeta.
  const [playbooks, enabledTools] = await Promise.all([
    fetchActivePlaybooks(supabase),
    fetchEnabledToolKeys(supabase),
  ]);

  // Las dos clasificaciones salen JUNTAS y no una detrás de la otra.
  //
  // Encadenadas eran unos dos segundos cada una —medidos contra el proveedor
  // desde este servidor— o sea cuatro segundos de reloj antes de que el
  // modelo empezara a redactar. Y no había ninguna razón para el orden: no
  // comparten nada, las dos leen el mismo historial y ninguna usa el
  // resultado de la otra. Eran secuenciales porque se escribieron una después
  // de la otra. En paralelo cuestan lo que cuesta la más lenta.
  //
  // Lo que sí cambia es el precio del camino de escenario: antes, un
  // escenario reconocido terminaba el turno en UNA llamada, y ahora la
  // clasificación ya salió igual. Es el precio de los dos segundos, y se
  // compensa poniéndole a AI_CLASSIFIER_MODEL un modelo pequeño — la costura
  // ya existe en model.ts y hoy está vacía.
  //
  // No se fusionaron en una sola llamada con dos campos, que ahorraría
  // también esa llamada: son dos enums con criterios distintos y prompts
  // distintos, y juntarlos degrada los dos a la vez sin forma de saber cuál.
  // Con esta forma, cada uno se puede mover de modelo por su cuenta.
  const [match, classified] = await medir(tiempos, "clasificacionMs", () =>
    Promise.all([
      // matchPlaybook nunca lanza: un fallo del proveedor deja el turno por el
      // flujo genérico. classifyIntent sí, y su fallo aborta el turno — así que
      // se captura acá para que no se lleve por delante un escenario que quizá
      // sí reconoció.
      //
      // `undefined` en el tercer lugar deja que matchPlaybook use su propio
      // "ahora" por defecto — acá solo hace falta empujar el horario, que ya
      // llegó calculado desde runAgentTurn (Frente B3, 5/9/2026).
      matchPlaybook(history, playbooks, undefined, businessHours),
      classifyIntent(history).then(
        (result) => ({ ok: true as const, result }),
        (err: unknown) => ({ ok: false as const, err })
      ),
    ])
  );

  const matchTokens = tokensFromUsage(match.usage);
  // La clasificación ya se pagó, calce o no un escenario: se cuenta siempre o
  // el panel de gasto informaría de menos justo en el camino más frecuente.
  const classifiedTokens = classified.ok
    ? addTokens(matchTokens, tokensFromUsage(classified.result.usage))
    : matchTokens;

  // Un escenario reconocido termina el turno... salvo que ya haya salido hace
  // poco en este mismo chat. En ese caso el turno NO se queda callado: cae al
  // flujo genérico, que es el que puede contestar lo que el cliente preguntó
  // después. Repetir el texto oficial no responde nada; redactar, sí.
  //
  // Dos redes, y se preguntan en este orden porque la primera es gratis: el
  // historial ya está en memoria, la ventana cuesta una consulta.
  if (match.playbook) {
    const fueLaUltimaRespuesta = alreadySentPlaybook(history, match.playbook);
    const yaSalioHacePoco =
      fueLaUltimaRespuesta ||
      (await playbookSentRecently(supabase, conversationId, match.playbook.id));

    if (!yaSalioHacePoco) {
      await runPlaybook(
        supabase,
        target,
        entrega,
        lease,
        match.playbook,
        classifiedTokens,
        customerMessage,
        tiempos,
        convo.last_customer_message_at,
        businessHours
      );
      return;
    }

    log.info("escenario_no_se_repite", {
      conversationId,
      escenario: match.playbook.name,
      motivo: fueLaUltimaRespuesta ? "fue_la_ultima_respuesta" : "ventana_de_6h",
    });
  }

  if (!classified.ok) {
    // Clasificar es lo único que se reintenta ante rate limit, y si aun así
    // falla el turno termina acá SIN responder. No hay intención por defecto:
    // adivinarla mandaría un mensaje genérico a alguien que preguntó algo
    // concreto, que es peor que no contestar. El caso queda en la bitácora
    // con action "error" para que un humano lo retome.
    await logTurn(supabase, conversationId, {
      intent: null,
      action: "error",
      summary: `Fallo al clasificar intención: ${errorMessage(classified.err)}`,
      tokens: classifiedTokens,
      customerMessage,
    });
    return;
  }

  const intent: Intent = classified.result.intent;
  const classifyTokens = classifiedTokens;

  await supabase.from("conversations").update({ intent }).eq("id", conversationId);

  // Fuera de tema: el turno termina acá. No se arma el tool loop —que es la
  // parte cara— y el texto sale de una constante, así que no cuesta salida.
  // A la segunda insistencia ni se responde: repetir la misma línea contra
  // alguien que insiste (o contra otro bot) es un ping-pong sin final.
  if (intent === "fuera_de_tema") {
    const repetido = alreadyRedirected(history);
    if (!repetido) {
      const salió = await deliver(supabase, target, entrega, lease, tiempos, "fuera_de_tema", () =>
        sendAgentText(supabase, target, OFF_TOPIC_REPLY)
      );
      if (!salió) return;
      if (await rejectedByMeta(supabase, conversationId, salió)) return;
    }

    await supabase
      .from("conversations")
      .update({ journey_stage: null, active_tool: null })
      .eq("id", conversationId);

    await logTurn(supabase, conversationId, {
      intent,
      action: "answered",
      summary: repetido ? "Fuera de tema, insistiendo: no se respondió." : OFF_TOPIC_REPLY,
      tokens: classifyTokens,
      customerMessage,
    });
    return;
  }

  const outcome: EscalationOutcome = { escalated: false };
  // `businessHours` viaja en `deps` para `buildEscalateTool`, que lo usa en la
  // despedida sin asesores (Frente B4, "El reloj dice la verdad", 5/9/2026):
  // así no hace falta reabrir el Promise.all de runAgentTurn para conseguirlo.
  const deps = { supabase, conversationId, contactId: target.contactId, businessHours };

  // Escalar no tiene interruptor: es la única salida hacia un humano. El
  // resto entra solo si su interruptor del panel está encendido.
  const tools: ToolSet = { escalarAAsesor: buildEscalateTool(deps, outcome) };
  if (intent === "devolucion") {
    if (enabledTools.has(TOOL_KEYS.orderHistory)) tools.buscarHistorialCompras = buildOrderHistoryTool(deps);
  } else if (intent !== "queja") {
    if (enabledTools.has(TOOL_KEYS.catalog)) tools.buscarRepuesto = buildCatalogTool(deps);
  }
  if (enabledTools.has(TOOL_KEYS.knowledge)) tools.consultarBiblioteca = buildKnowledgeTool(deps);

  // Con el catálogo apagado en un caso de consulta, el riesgo es que el
  // modelo cotice de memoria: se le avisa en las instrucciones del turno.
  const missingCatalog =
    !enabledTools.has(TOOL_KEYS.catalog) && (intent === "consulta_disponibilidad" || intent === "otro");

  const { model, providerOptions } = getAgentModel("medium");

  const agent = new ToolLoopAgent({
    model,
    instructions: buildInstructions({
      intent,
      needsGreeting: needsGreeting(convo.welcome_sent_at, history),
      missingCatalog,
      businessHours,
    }),
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    providerOptions,
    // El reintento vive en el control de ritmo, que espera en segundos y
    // respeta Retry-After. El del SDK reintenta a ~2 s, o sea dentro de la
    // misma ventana de un minuto que acaba de rechazar la petición: no
    // recupera nada y gasta el doble de cuota. Ver rate-limit.ts.
    maxRetries: 0,
    onToolExecutionStart: async ({ toolCall }) => {
      await supabase
        .from("conversations")
        .update({ journey_stage: "tool_running", active_tool: toolCall.toolName })
        .eq("id", conversationId);
    },
    onToolExecutionEnd: async () => {
      await supabase.from("conversations").update({ active_tool: null }).eq("id", conversationId);
    },
  });

  let text = "";
  let turnTokens = classifyTokens;
  try {
    // "Escribiendo…" hacia el cliente (T3.1, 4/9/2026), justo al arrancar la
    // parte cara del turno. No se espera: un typing que tarda no puede
    // sumarle latencia a la redacción real, y su propio fallo ya queda
    // contenido en meta-client.ts.
    fireTypingIndicator(supabase, target, convo.last_customer_message_at);
    const result = await medir(tiempos, "redaccionMs", () => agent.generate({ messages: history }));
    text = result.text ?? "";
    // Cuántos pasos gastó de verdad, contra el techo de MAX_STEPS. Sin este
    // número, "cinco es generoso" es una opinión: lo que se sabía del turno
    // era su coste total, que no distingue un paso caro de cuatro baratos.
    //
    // Con `?.` aunque el tipo diga que siempre viene: esto es telemetría, y
    // ninguna medición puede tumbar la respuesta que está midiendo. Si el SDK
    // deja de traerlo, se pierde el dato y el cliente recibe su mensaje igual.
    tiempos.pasos = result.steps?.length ?? null;
    turnTokens = addTokens(classifyTokens, tokensFromUsage(result.usage));
  } catch (err) {
    await logTurn(supabase, conversationId, {
      intent,
      action: "error",
      summary: errorMessage(err),
      tokens: classifyTokens,
      customerMessage,
    });
    await supabase.from("conversations").update({ active_tool: null }).eq("id", conversationId);
    return;
  }

  // Red de seguridad: devolución y queja SIEMPRE terminan escaladas. Si el
  // turno se quedó sin pasos sin lograrlo, se fuerza en código.
  if (!outcome.escalated && (intent === "devolucion" || intent === "queja")) {
    const forced = await escalateConversation(supabase, {
      conversationId,
      contactId: target.contactId,
      motivo: intent,
      resumen: "El turno de la IA se quedó sin pasos antes de escalar formalmente. Revisar el hilo completo.",
    });
    outcome.escalated = forced.escalated;
    outcome.assignedAgentName = forced.assignedAgentName ?? undefined;
    // Copiado también acá (anexo A1, 5/9/2026): esta es la red de seguridad,
    // no la herramienta que el modelo invoca — sin este campo, el envío de
    // abajo no tendría cómo saber si la despedida se quedó sin nadie detrás.
    outcome.unassigned = forced.unassigned;
    if (!text.trim()) {
      // Sin asesores no se promete lo que no va a pasar: nadie va a
      // contestar en un minuto si no hay nadie trabajando.
      text = forced.unassigned
        ? "Ya dejé tu caso registrado para que lo revise un asesor. En cuanto haya alguien disponible te escriben por acá."
        : "Dame un momentico, ya te paso con un asesor para que te ayude con esto.";
    }
  }

  if (text.trim()) {
    // Acá es donde más se nota: entre abrir el turno y llegar a esta línea
    // pasaron el reconocimiento de escenario, la clasificación y hasta cinco
    // pasos de tool loop. Es el punto del turno más lejano al momento en que
    // se miraron las guardas al abrirlo.
    // `isAutoReply` (anexo A1, 5/9/2026): una despedida sin nadie detrás no
    // es una respuesta. Cubre los DOS caminos por los que la IA se despide al
    // escalar sin asesores: el texto fijo de la red de seguridad de arriba y
    // el que redacta el propio modelo tras leer `instruccionParaTuRespuesta`
    // de la herramienta (`tools.ts`). El cliente sigue esperando a una
    // persona, así que el trigger `handle_new_message` no debe apagar
    // `awaiting_reply` con este mensaje — de ahí la misma marca que ya lleva
    // la bienvenida automática (T0.1).
    const salida = await deliver(supabase, target, entrega, lease, tiempos, "redaccion", () =>
      sendAgentText(supabase, target, text.trim(), {
        isAutoReply: outcome.escalated && outcome.unassigned === true,
      })
    );
    if (!salida) return;
    // `outcome.escalated` es la bandera: `escalateConversation` SIEMPRE deja
    // su traspaso antes de devolver (por el tool del modelo o por la red de
    // seguridad de arriba), así que si ya está en true acá el dueño de la
    // conversación ya quedó fijado y un rechazo de Meta no debe pisarlo.
    if (await rejectedByMeta(supabase, conversationId, salida, outcome.escalated)) return;
  }

  if (!outcome.escalated) {
    await supabase.from("conversations").update({ journey_stage: null, active_tool: null }).eq("id", conversationId);
  }

  await logTurn(supabase, conversationId, {
    intent,
    action: outcome.escalated ? "escalated" : "answered",
    summary: outcome.escalated
      ? `Escalado a ${outcome.assignedAgentName ?? "(sin asesor disponible)"}. Motivo: ${outcome.motivo}.`
      : text,
    tokens: turnTokens,
    customerMessage,
  });
}

/**
 * Corre el turno del agente para UNA conversación.
 *
 * Puede lanzar, y la cola cuenta con eso: un fallo antes de responder vuelve
 * a la cola para otro intento. Lo que NO vuelve es un fallo posterior a haber
 * intentado entregarle algo al cliente — ese sale como NonRetryableTurnError
 * y la cola lo abandona, porque reintentarlo mandaría el mismo mensaje dos
 * veces (ver turn-delivery.ts).
 */
export async function runAgentTurn(conversationId: string): Promise<void> {
  const supabase = createAdminClient();

  const [{ data: canRun }, { data: conversation }, { data: settingsRow, error: settingsError }] = await Promise.all([
    // agent_can_run junta el interruptor global y el tope de gasto del día.
    // La decisión vive en la base para que sea la misma la pregunte quien la
    // pregunte, y para que el tope se levante solo al cambiar el día.
    supabase.rpc("agent_can_run"),
    supabase
      .from("conversations")
      .select(
        "id, contact_id, ai_enabled, assigned_agent_id, welcome_sent_at, last_customer_message_at, contact:contacts(phone_number), channel:whatsapp_channels(phone_number_id, status)"
      )
      .eq("id", conversationId)
      .maybeSingle(),
    // Horario de atención (Frente B3, "El reloj dice la verdad", 5/9/2026):
    // se lee junto con las otras dos porque tampoco depende de ellas. Una
    // fila rota, sin permiso o sin fila cae al horario por defecto más abajo
    // — el turno nunca se cae por esto.
    supabase.from("agent_settings").select("business_hours").eq("id", true).maybeSingle(),
  ]);

  if (settingsError) {
    log.warn("turno_horario_no_legible", { conversationId, detail: settingsError.message });
  }
  const businessHours = parseBusinessHours(settingsRow?.business_hours ?? undefined);

  const convo = conversation as unknown as AgentConversation | null;
  // Sin fila no hay traspaso que registrar: `conversation_id` tiene FK contra
  // `conversations`, así que un insert acá se rechazaría solo. La única
  // salida silenciosa de este turno que no deja bitácora, y es correcto.
  if (!convo) return;

  // Guardrail duro: si algo dice que la IA no debe correr, no se llama al
  // modelo. No depende de que el prompt "se acuerde" de quedarse callado.
  if (!canRun) {
    // Antes era un `return` mudo. Con la cola llena y la IA apagada, los
    // turnos se reclamaban y desaparecían sin dejar rastro de por qué.
    log.info("turno_saltado_ia_apagada", { conversationId });
    await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "agente_no_puede_correr" });
    return;
  }
  // Partido en dos para poder registrar cuál de las dos causas fue. El orden
  // CAMBIÓ el 5/9/2026 (anexo A2): antes se miraba primero `ai_enabled`, así
  // que un chat con dueño (`assigned_agent_id`) y la IA apagada —el estado
  // normal tras una escalación o un cierre manual, no un caso raro— caía en
  // la rama de `pausada`/`unassigned` sin que importara que tenía asesor: la
  // bitácora decía "sin dueño" de una conversación que sí lo tenía. Ahora se
  // mira primero `assigned_agent_id`: un chat asignado registra `asignada`/
  // `human` aunque la IA esté apagada en él, que es justo el caso que este
  // reordenamiento vino a corregir. El efecto observable —return sin enviar
  // nada— no cambia, solo qué dice el traspaso.
  if (convo.assigned_agent_id) {
    await recordHandoff(supabase, {
      conversationId,
      toKind: "human",
      reason: "asignada",
      toId: convo.assigned_agent_id,
    });
    return;
  }
  if (!convo.ai_enabled) {
    await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "pausada" });
    return;
  }

  // Un chat que ya tocó una persona es de esa persona.
  //
  // Va acá, en el turno, y no solo en la consulta que arma el atraso, porque
  // este es el cuello por donde pasan TODOS los caminos: el barrido, el
  // webhook, el cron de recuperación y el simulador. El 26 de agosto de 2026
  // la IA le escribió a 22 clientes que estaban hablando con un asesor, y no
  // llegaron por el barrido nada más: cualquier mensaje entrante de un chat
  // atendido lo encolaba igual. Arreglar solo el barrido habría dejado esa
  // puerta abierta.
  //
  // Se comprueba en cada turno y no una vez al encolar porque entre encolar y
  // atender pasa tiempo, y ese es justo el rato en el que un asesor puede
  // meterse en la conversación. Ver human-handled.ts.
  if (await humanHasWritten(supabase, conversationId)) {
    log.warn("turno_chat_de_una_persona", { conversationId });
    await recordHandoff(supabase, { conversationId, toKind: "human", reason: "humano_intervino" });
    return;
  }

  // Pasadas 24 h del último mensaje del cliente, Meta rechaza el texto libre:
  // solo entra una plantilla aprobada, y no hay ninguna configurada. Sin esta
  // comprobación el turno correría completo —clasificar, herramientas,
  // redactar— para producir un mensaje que el cliente no va a ver nunca y una
  // fila en `messages` diciendo que salió.
  //
  // Va acá y no solo en la consulta que elige a quién atender porque entre
  // encolar y atender pasa tiempo: el repaso del atraso drena a lo largo de
  // una hora, y una conversación encolada en la hora 23 cruza el borde en el
  // medio. La consulta filtra un instante; esto cubre el hueco.
  if (!withinFreeformWindow(convo.last_customer_message_at)) {
    log.warn("turno_fuera_de_ventana", { conversationId });
    await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "fuera_de_ventana" });
    return;
  }

  // A quién le vamos a hablar se fija ACÁ, una sola vez, contra el id que
  // pidió la cola. De acá en adelante nada vuelve a resolver el destinatario:
  // el mismo objeto congelado llega al envío. Si no cuadra, el turno no
  // envía nada y no se reintenta — una identidad rota no se arregla sola, y
  // reintentarla solo gasta cupos.
  let target: TurnTarget;
  try {
    target = buildTurnTarget(conversationId, convo);
  } catch (err) {
    log.error("turno_identidad_no_verificable", { conversationId, detail: errorText(err) });
    await recordHandoff(supabase, {
      conversationId,
      toKind: "unassigned",
      reason: "identidad_no_verificable",
    });
    throw new NonRetryableTurnError(conversationId, errorText(err), { cause: err });
  }

  // Lock por conversación: si dos webhooks casi simultáneos disparan el
  // turno para la misma conversación (típico cuando el cliente manda varios
  // mensajes seguidos), solo uno corre — el otro se salta en vez de generar
  // una respuesta duplicada o un doble escalamiento.
  await withConversationTurnLock(supabase, conversationId, async (lease) => {
    const entrega = newTurnDelivery();
    const tiempos = newTurnTiming(convo.last_customer_message_at);
    const arranque = Date.now();

    try {
      await runTurnPhases(supabase, target, convo, entrega, lease, tiempos, businessHours);
    } catch (err) {
      if (!entrega.intentado) throw err;

      // El mensaje ya salió (o pudo haber salido) y lo que falló es un paso
      // posterior: actualizar la conversación, escalar, escribir la bitácora.
      // Reintentar el turno lo reenviaría. Se registra y se abandona.
      log.error("turno_fallo_tras_envio", { conversationId, detail: errorText(err) });
      await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "entrega_fallida" });
      throw new NonRetryableTurnError(
        conversationId,
        `El turno falló después de intentar entregar un mensaje; no se reintenta para no duplicarlo: ${errorText(err)}`,
        { cause: err }
      );
    } finally {
      // En `finally` y no al final del camino feliz: el turno que revienta a
      // los veinte segundos es justo el que hay que poder ver. Un turno que
      // salió temprano —sin historial, con el interruptor abajo— deja sus
      // tramos en null, que también dice algo.
      log.info("turno_tiempos", {
        conversationId,
        ...tiempos,
        turnoMs: Date.now() - arranque,
        // Del mensaje del cliente a acá: es el número que mira el dueño.
        totalMs: tiempos.esperaMs === null ? null : tiempos.esperaMs + (Date.now() - arranque),
        maxPasos: MAX_STEPS,
        entregado: entrega.intentado,
      });
    }
  });
}

// El disparo en lote vive ahora en src/lib/ai/queue.ts: el webhook encola y
// la cola procesa de a uno. Correr varios turnos en paralelo desde acá dejaba
// las respuestas sin registro si el proceso moría a mitad.
