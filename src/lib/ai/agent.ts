import "server-only";
import {
  ToolLoopAgent,
  generateText,
  isStepCount,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Playbook, Tag } from "@/lib/types";
import { dayBand, parseBusinessHours, type BusinessHours, type BusinessStatus } from "@/lib/business-hours";
import { createAdminClient } from "@/lib/supabase/admin";
import { classifyIntent, type Intent } from "@/lib/ai/classify";
import { currentAgentModelLabel, getAgentModel } from "@/lib/ai/model";
import { OFF_TOPIC_REPLY, SYSTEM_PROMPT, buildInstructions } from "@/lib/ai/prompt";
import { buildCatalogTool, buildEscalateTool, buildOrderHistoryTool, type EscalationOutcome } from "@/lib/ai/tools";
import { revealsIdentity, rewriteSuffix } from "@/lib/ai/identity-guard";
import { TOOL_KEYS, fetchEnabledToolKeys } from "@/lib/ai/agent-tools";
import { buildKnowledgeTool } from "@/lib/ai/knowledge";
import { escalateConversation } from "@/lib/ai/escalate";
import { withConversationTurnLock, type TurnLease } from "@/lib/ai/conversation-lock";
import { humanHasWritten } from "@/lib/ai/human-handled";
import { ZERO_USAGE, fetchActivePlaybooks, matchPlaybook, playbookSentRecently, type PlaybookMatch } from "@/lib/ai/playbooks";
import { historyLine, isHistoryMarker, mediaStreakWithoutText } from "@/lib/ai/history-line";
import { customerFirstName } from "@/lib/ai/customer-name";
import { playbookMessageText, sendAgentText, sendPlaybookReply, type DeliveryOutcome } from "@/lib/ai/send";
import { buildTurnTarget, type AgentConversation, type TurnTarget } from "@/lib/ai/turn-target";
import { NonRetryableTurnError, newTurnDelivery, type TurnDelivery } from "@/lib/ai/turn-delivery";
import { recordHandoff, escalationOpen } from "@/lib/ai/handoffs";
import { isCourtesyOnly, isGreetingOnly } from "@/lib/ai/saludo";
import { sebaGreeting } from "@/lib/ai/seba";
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
  /**
   * La ventana de silencio, sola: cuánto se esperó a propósito (debounce, 2 s
   * o 6 s) antes de que la cola considerara el turno vencido. Es DISEÑO, no
   * atraso.
   *
   * `null` sin `vencioEn` (turnos disparados fuera de la cola, como
   * `simulate-message`) o sin `last_customer_message_at`. 7/9/2026 ("La
   * respuesta llega en siete segundos", T0): antes de esto, `esperaMs` los
   * mezclaba en un solo número y no se podía afirmar por turno si se cumplió
   * el objetivo de siete segundos o si la espera en cola ya bajó de un
   * segundo — el primero es diseño, el segundo es la métrica que hay que
   * bajar.
   */
  debounceMs: number | null;
  /**
   * La espera en cola, sola: del vencimiento (cuando el turno ya estaba listo
   * para correr) al arranque real. Es ATRASO — el número que el criterio de
   * cierre de la rampa exige por debajo de un segundo de mediana.
   *
   * `debounceMs + colaMs === esperaMs` EXACTO cuando `vencioEn` es válido:
   * los tres se calculan sobre el mismo `Date.now()`, capturado una única vez
   * en `newTurnTiming` — dos llamadas separadas a `Date.now()` habrían dejado
   * un resto de unos pocos milisegundos que rompería la igualdad y, peor,
   * habría sido casi imposible de reproducir en una prueba.
   */
  colaMs: number | null;
  /** Escenario y clasificación, que corren juntos: tarda lo que la más lenta. */
  clasificacionMs: number | null;
  /** El tool loop entero, incluidas las herramientas que haya usado. */
  redaccionMs: number | null;
  /** Lo que cuesta entregarlo: la Graph API de Meta manda acá. */
  envioMs: number | null;
  /** Pasos del tool loop que el turno gastó de verdad, contra el techo MAX_STEPS. */
  pasos: number | null;
  /**
   * Nombres de las herramientas que el tool loop usó de verdad, en el orden
   * en que corrieron, separados por coma (`""` si corrió y no usó ninguna,
   * `null` si el turno no llegó a esta fase). 7/9/2026: sin esto nadie podía
   * decir qué disparaba el segundo paso de redacción (29 de 65 turnos
   * medidos ese día) sin tocar el prompt del redactor — T4 queda para
   * después, esto es solo la observabilidad que hace falta para medirlo.
   */
  herramientas: string | null;
}

type TimingPhase = "clasificacionMs" | "redaccionMs" | "envioMs";

/**
 * `vencioEn` es el instante en que la cola dio por vencida la ventana de
 * silencio del turno — el que trae `claimDue()` (ver redis-queue.ts), ya
 * limpio de cualquier reintento del sistema (ritmo, cupo, lock, error: ver
 * `defer` en la misma cola). Ausente (turnos fuera de la cola, como
 * `api/dev/simulate-message`) o no finito, `debounceMs`/`colaMs` quedan en
 * `null` y solo `esperaMs` sigue midiendo, como medía antes de esta corrida.
 */
function newTurnTiming(lastCustomerMessageAt: string | null, vencioEn?: number): TurnTiming {
  // Un solo Date.now(): es lo que garantiza, por construcción, que
  // debounceMs + colaMs === esperaMs, sin depender de que dos lecturas del
  // reloj caigan en el mismo milisegundo.
  const ahora = Date.now();
  const desde = lastCustomerMessageAt ? Date.parse(lastCustomerMessageAt) : NaN;
  const esperaMs = Number.isNaN(desde) ? null : ahora - desde;

  const vencimientoValido = esperaMs !== null && Number.isFinite(vencioEn);
  const debounceMs = vencimientoValido ? (vencioEn as number) - desde : null;
  const colaMs = vencimientoValido ? ahora - (vencioEn as number) : null;

  return {
    esperaMs,
    debounceMs,
    colaMs,
    clasificacionMs: null,
    redaccionMs: null,
    envioMs: null,
    pasos: null,
    herramientas: null,
  };
}

/**
 * Nombres de las herramientas que corrieron en el tool loop, en orden.
 *
 * Defensivo a propósito: `steps` es de un SDK externo y esto es telemetría,
 * no algo que pueda tumbar la respuesta que está midiendo. Un paso sin
 * `toolCalls` (o sin herramientas declaradas) simplemente no aporta nombres.
 */
function toolNamesUsed(steps: readonly unknown[] | undefined): string {
  if (!steps) return "";
  const nombres: string[] = [];
  for (const paso of steps) {
    const llamadas = (paso as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(llamadas)) continue;
    for (const llamada of llamadas) {
      const nombre = (llamada as { toolName?: unknown }).toolName;
      if (typeof nombre === "string") nombres.push(nombre);
    }
  }
  return nombres.join(",");
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
    //
    // Lo que SÍ cambió (8/9/2026, Bug 1 medido en producción el 7/9): una
    // foto, un video, una nota de voz, un documento o un sticker traen
    // `content` null cuando llegan sin pie, y antes esa nulidad los
    // descartaba igual que un 'unsupported' — invisibles para el modelo. La
    // línea que arma `historyLine` (ver history-line.ts) es la manera de
    // avisarle al modelo que algo llegó sin sintetizar nada en
    // `messages.content`: la fila de la base no se toca, el marcador vive
    // solo en memoria.
    const linea = historyLine(row);
    if (!linea) continue;
    messages.push({ role: linea.role, content: linea.content });
  }
  return messages;
}

/**
 * Último mensaje del cliente del turno: es lo que se guarda en la bitácora
 * para poder crear el escenario que faltó.
 *
 * Devuelve `null` si esa última línea es un marcador de media (8/9/2026): un
 * supervisor no puede crear un escenario a partir de "[El cliente envió una
 * foto sin texto; no puedes verla]" — no hay texto de cliente ahí, solo el
 * aviso que arma el CRM. Mejor una bitácora vacía que una engañosa.
 */
function lastCustomerMessage(history: ModelMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role === "user" && typeof message.content === "string") {
      return isHistoryMarker(message.content) ? null : message.content;
    }
  }
  return null;
}

/**
 * ¿La última línea del CLIENTE en el historial es un marcador de media
 * (foto/video/audio/documento/sticker sin texto que leer)? (8/9/2026)
 *
 * Gobierna si vale la pena llamar a `matchPlaybook`: un escenario está
 * escrito para calzar contra texto de cliente, y un marcador —"[El cliente
 * envió una nota de voz; no puedes escucharla]"— nunca va a calzar con
 * ningún disparador. Preguntarlo igual sería gastar una llamada al
 * proveedor por nada. El caso normal, un texto DESPUÉS de la foto
 * ("cualquiera de estos en talla L", caso `7631718e…`), sí corre fase 0 con
 * el marcador en contexto: acá se mira solo la ÚLTIMA línea de cliente, no
 * si hay marcadores en cualquier parte del historial.
 */
function lastUserLineIsMarker(history: ModelMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role !== "user") continue;
    return typeof message.content === "string" && isHistoryMarker(message.content);
  }
  return false;
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
 * true si nuestra última respuesta ya fue la redirección de fuera de tema.
 *
 * Salta los marcadores de media salientes (8/9/2026, hallazgo 6 del plan):
 * "[El asesor envió una foto]" no es la redirección ni podría serlo, y si se
 * lo tomara como "nuestra última respuesta" la red dejaría de reconocer que
 * la redirección sí se mandó antes de esa foto — se apoyaría solo en que el
 * cliente vuelva a insistir para descubrirlo. Se compara contra el último
 * TEXTO real que salió.
 */
function alreadyRedirected(history: ModelMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string" && isHistoryMarker(message.content)) continue;
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
 *
 * Salta los marcadores de media salientes (8/9/2026, hallazgo 6 del plan): si
 * el asesor mandó una foto DESPUÉS del escenario, "nuestra última respuesta"
 * sigue siendo el texto del escenario para todo efecto práctico — la red de
 * "fue la última respuesta" no debe dejar de reconocerlo solo porque en el
 * medio se coló un adjunto.
 */
function alreadySentPlaybook(history: ModelMessage[], playbook: Playbook): boolean {
  const enviado = playbookMessageText(playbook);
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string" && isHistoryMarker(message.content)) continue;
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

/**
 * Escribe la fila de bitácora del turno (`agent_turns`).
 *
 * Hasta el 14/9/2026 (Tarea 5) el `error` de este INSERT se ignoraba en
 * silencio: un `fuera_de_tema` o cualquier otro turno cuya única huella es
 * esta fila desaparecía sin dejar rastro si el INSERT fallaba —exactamente
 * el motivo por el que nadie encontró en la bitácora ningún `fuera_de_tema`
 * cuando se buscó uno. No lanza: `logTurn` es observabilidad, nunca puede
 * tumbar un turno que ya le habló al cliente (o que decidió, correctamente,
 * callarse).
 */
async function logTurn(supabase: SupabaseClient<Database>, conversationId: string, params: LogTurnParams) {
  const { error } = await supabase.from("agent_turns").insert({
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

  if (error) {
    log.error("turno_bitacora_no_escrita", { conversationId, action: params.action, detail: errorText(error) });
  }
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
 * Falla cerrado: si no se puede enviar, no se envía. Pero desde la Tarea 5
 * ("La voz cercana y la espera visible", 14/9/2026) "no se puede preguntar"
 * y "la respuesta dice que no" dejaron de ser lo mismo. Antes un error de
 * red o de la RPC caía en el mismo `catch` que un `data === false` genuino y
 * `deliver()` los trataba IGUAL: `recordHandoff(..., "agente_no_puede_correr")`
 * y el turno terminaba ahí, reintentable solo si el llamador de `runAgentTurn`
 * decidía reencolarlo por su cuenta — un corte de base se disfrazaba de
 * interruptor apagado en la bitácora (hallazgo 10 de la auditoría de esta
 * tarea: 13 turnos así en 72 h). Ahora un error de la RPC (o una excepción de
 * red) se relanza DESPUÉS de loguearlo: `deliver()` no lo atrapa, así que el
 * turno entero falla ANTES de marcar `entrega.intentado = true` y la cola lo
 * reintenta como cualquier otro fallo transitorio (ver el `catch` de
 * `runAgentTurn`, más abajo). Solo un `data === false` DE VERDAD —la RPC
 * respondió, y dijo que no— sigue escribiendo `agente_no_puede_correr`: ese
 * caso no es reintentable, es una decisión.
 */
async function stillEnabled(supabase: SupabaseClient<Database>, conversationId: string): Promise<boolean> {
  let data: boolean | null;
  try {
    const result = await supabase.rpc("agent_can_run");
    if (result.error) throw new Error(result.error.message);
    data = result.data;
  } catch (err) {
    log.error("turno_interruptor_no_consultable", { conversationId, detail: errorText(err) });
    throw new Error(`agent_can_run no consultable: ${errorText(err)}`, { cause: err });
  }
  if (!data) log.warn("turno_abortado_por_interruptor", { conversationId });
  return Boolean(data);
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
  lastCustomerMessageAt: string | null,
  fase: SendPhase
): Promise<boolean> {
  try {
    if (!(await humanHasWritten(supabase, conversationId, lastCustomerMessageAt))) return false;
  } catch (err) {
    log.error("turno_persona_no_consultable", { conversationId, fase, detail: errorText(err) });
    return true;
  }

  log.warn("turno_persona_se_adelanto", { conversationId, fase });
  return true;
}

/** Desde qué punto del turno se está intentando hablar. Viaja al registro. */
type SendPhase = "presentacion" | "escenario" | "fuera_de_tema" | "redaccion" | "adjuntos_sin_texto";

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
  lastCustomerMessageAt: string | null,
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
    // `stillEnabled` vuelve a consultar la RPC `agent_can_run` (interruptor
    // global de la IA + tope de gasto del día), NO el `ai_enabled` del chat
    // — ese otro caso lo cubre la guarda de `openTurn` (l. ~1056) y ahí sí
    // corresponde `pausada`. Antes las dos guardas del mismo hecho —el
    // apagado global— dejaban razones distintas en la bitácora según en
    // cuál de las dos cayera el turno, y eso confundía la lectura (deuda
    // anotada el 5/9/2026 en el reporte de entrega de "Bandeja que no
    // pierde"). D2 (6/9/2026): ahora las dos escriben `agente_no_puede_correr`.
    await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "agente_no_puede_correr" });
    return null;
  }
  if (await humanWroteMeanwhile(supabase, conversationId, lastCustomerMessageAt, fase)) {
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
 * ¿Falló el envío que ya pasó todas las guardas de `deliver`? Si sí, deja su
 * traspaso y dice que el turno termina acá.
 *
 * Un `whatsapp_status: "failed"` acá es distinto de cualquier guarda de
 * arriba: no es que el turno decidiera callarse, es que SÍ intentó hablar y
 * algo salió mal — el cliente se quedó exactamente igual de sin respuesta,
 * pero antes de T0.3 el turno seguía como si hubiera contestado (`logTurn`
 * con action "answered", `journey_stage` reseteado): la conversación quedaba
 * sin dueño en la bitácora aunque el mensaje nunca hubiera llegado. No se
 * reintenta DENTRO del turno — regla de `turn-delivery.ts`: `entrega.intentado`
 * ya quedó en `true` antes del envío, y una vez intentado no se repite porque
 * no sabemos si el request llegó a mitad de camino. Reintentar acá arriesga
 * mandarlo dos veces. Sí es "reintentable por la cola": un saliente `failed`
 * NO apaga `awaiting_reply` (T0.1), así que el reconciliador reencola la
 * conversación sola en ≤ 5 min (`api/cron/process-queue`).
 *
 * Renombrada de `rejectedByMeta` (S6, corrida "La IA ve lo que llega",
 * hallazgo 4, 8/9/2026): el nombre viejo asumía que TODO `failed` era un
 * rechazo de la Graph API. El corte de red de OpenRouter del 7/9 a las 11:57
 * UTC (`getaddrinfo EAI_AGAIN openrouter.ai`) dejó dos envíos `failed` con
 * `detalle: "fetch failed"` — Meta nunca vio esos mensajes — y el código de
 * entonces igual escribía `rechazado_por_meta`. `entrega.origenDelFallo`
 * (`send.ts`) ahora dice cuál de los dos pasó, y esta función bifurca:
 *
 *   - `"red"`: un corte de red, DNS o timeout — nada volvió de Meta.
 *     `log.error("turno_envio_fallo_de_red", ...)` y, si no hay escalación
 *     previa, `recordHandoff(unassigned, entrega_fallida)` + `resetStage`.
 *   - `"meta"` (o `null` con `whatsapp_status: "failed"`, por compatibilidad
 *     con outcomes viejos que no traían `origenDelFallo`): Meta SÍ respondió
 *     y lo rechazó — comportamiento de siempre, `rechazado_por_meta`.
 *
 * `yaEscalada` (5/9/2026): en el tool loop, devolución/queja terminan
 * SIEMPRE escaladas —por el modelo con la herramienta, o por la red de
 * seguridad forzada más abajo— y `escalateConversation` ya deja su propio
 * traspaso (`escalada` con asesor, `escalada_sin_asesor` sin uno) ANTES de
 * que se intente el envío final. Si ese envío es justo el que falla, escribir
 * ADEMÁS un traspaso con `toKind: "unassigned"` pisaría esa fila: como el
 * conteo "Sin dueño" mira la ÚLTIMA fila de `conversation_handoffs`, una
 * conversación que sí quedó con asesor asignado aparecería como sin dueño.
 * Un solo traspaso por salida, el más específico: con `yaEscalada` en true se
 * deja el log —el fallo sí tiene que verse— pero no se vuelve a llamar a
 * `recordHandoff` ni a `resetStage` (mismo motivo que la rama `"meta"`:
 * `escalateConversation` ya dejó `journey_stage = "assigned"` y pisarlo con
 * `null` disfrazaría de "sin escalar" un caso que sí tiene asesor).
 *
 * A3 (5/9/2026, tablero de Atascados): en la rama SIN escalar, este `return`
 * salía antes de que `runPlaybook`/`runTurnPhases` llegaran a su propio
 * reseteo de `journey_stage`/`active_tool` (los de después de un envío que sí
 * salió) — el tablero seguía viendo "Clasificando" o "Herramienta" mucho
 * después de que el turno terminara, como si el cliente estuviera esperando
 * una fase que ya no existe. Se limpia acá, en el único lugar por el que
 * pasan los tres consumidores.
 */
async function deliveryFailed(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  entrega: DeliveryOutcome,
  /**
   * T4, "Seba atiende el mostrador" (18/9/2026, D2/D3): `assigned_agent_id`
   * del chat, para que el reseteo de `journey_stage` de acá abajo pase por
   * `stageFor` — con D2 la IA sigue corriendo turnos enteros en un chat YA
   * asignado (ya no corta en la apertura), y un reseteo a `null` a secas lo
   * sacaría de la píldora "Escaladas" (`inbox-filters.ts`, que mira el campo
   * crudo) apenas un envío fallara.
   */
  assignedAgentId: string | null,
  yaEscalada = false
): Promise<boolean> {
  if (entrega.whatsapp_status !== "failed") return false;

  if (entrega.origenDelFallo === "red") {
    log.error("turno_envio_fallo_de_red", { conversationId, detalle: entrega.whatsapp_error_detail });
    if (yaEscalada) return true;

    await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "entrega_fallida" });
    await resetStage(supabase, conversationId, "turno_envio_fallo_de_red", assignedAgentId);
    return true;
  }

  // origen "meta" (Meta respondió por HTTP, con o sin código) o `null` con
  // `whatsapp_status: "failed"` (compatibilidad con outcomes que no traen
  // `origenDelFallo`): comportamiento de siempre.
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
    .update({ journey_stage: stageFor(assignedAgentId, null), active_tool: null })
    .eq("id", conversationId);
  if (error) {
    log.error("turno_etapa_no_reseteada_tras_rechazo", { conversationId, detail: error.message });
  }

  return true;
}

/**
 * Limpia `journey_stage`/`active_tool` cuando el turno abandona SIN llegar a
 * hablarle al cliente (T4, corrida "La IA ve lo que llega", 8/9/2026).
 *
 * Hallazgo 2 del plan: había TRES puertas en `runTurnPhases` que dejaban la
 * etapa congelada para siempre porque el único reseteo vivía en los caminos
 * que sí llegaban a enviar algo (o en `deliveryFailed`, que tiene el suyo
 * propio por escribir además su traspaso específico). Medido en producción
 * el 7/9/2026: 17 conversaciones quedadas en `classifying` sin lock vigente,
 * la más vieja del 27/8/2026 — el corte de red de OpenRouter del 7/9 11:57
 * UTC pasó justo por la puerta de clasificación fallida.
 *
 * Mismo patrón que `deliveryFailed`: esto es observabilidad del tablero de
 * Atascados, nunca una barrera — si el UPDATE falla se registra y el turno
 * sigue exactamente igual. `evento` es el nombre de la salida que llamó
 * (aparece en el registro) para poder distinguir cuál de las puertas dejó el
 * UPDATE sin poder aplicarse.
 */
async function resetStage(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  evento: string,
  /** Ver el comentario de `stageFor`, más abajo. */
  assignedAgentId: string | null
): Promise<void> {
  const { error } = await supabase
    .from("conversations")
    .update({ journey_stage: stageFor(assignedAgentId, null), active_tool: null })
    .eq("id", conversationId);
  if (error) {
    log.error("turno_etapa_no_reseteada", { conversationId, evento, detail: errorText(error) });
  }
}

/**
 * T4, "Seba atiende el mostrador" (18/9/2026, D2/D3): qué `journey_stage`
 * escribir en cada punto del turno donde antes se escribía la etapa a
 * secas (`"classifying"`, `"tool_running"`, o `null` al terminar/abandonar).
 *
 * Hasta esta corrida un chat asignado NUNCA llegaba a estas líneas: la
 * apertura de `runAgentTurn` cortaba el turno entero en cuanto veía
 * `assigned_agent_id` (ver más arriba). Con D2 la escalada ya no apaga la
 * IA, así que Seba corre el turno COMPLETO en un chat que ya tiene asesor
 * —clasifica, usa herramientas, redacta— hasta que el asesor escribe de
 * verdad. Si esas escrituras siguieran poniendo `"classifying"`/
 * `"tool_running"`/`null` sin mirar quién es el dueño, la píldora
 * "Escaladas" de la bandeja (`inbox-filters.ts`, que mira el campo CRUDO
 * `journeyStage === "assigned"`, sin cruzarlo con `ai_enabled`) perdería el
 * chat apenas el turno arrancara a trabajar, y lo recuperaría recién al
 * terminar — parpadeando en cada mensaje del cliente.
 *
 * Un chat asignado escribe SIEMPRE `"assigned"`, nunca lo que el turno
 * hubiera escrito para uno sin dueño; uno sin asignar sigue exactamente
 * igual que antes.
 */
function stageFor(assignedAgentId: string | null, etapa: string | null): string | null {
  return assignedAgentId ? "assigned" : etapa;
}

/** Sufijo para la bitácora: qué quedó etiquetado, por nombre. Vacío si no había etiquetas. */
function tagSummary(tags: Tag[]): string {
  return tags.length === 0 ? "" : ` Etiquetas: ${tags.map((tag) => tag.label).join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Guarda de identidad (6/9/2026): las dos despedidas fijas que ya usaba la
// red de seguridad de devolución/queja, ahora compartidas con
// `applyIdentityGuard` — es el texto que sale cuando la guarda bloquea un
// borrador y no hay nada más seguro que mandar. Se exportan para el test
// estático de `agent.test.ts`, que las pasa por `revealsIdentity` para
// asegurarse de que la propia despedida nunca se delate.
// ---------------------------------------------------------------------------
export const DESPEDIDA_SIN_ASESOR =
  "Listo, dejé tu caso registrado para que un asesor lo revise. En cuanto haya alguien disponible te escribe por acá; gracias por la paciencia.";

/**
 * La despedida fija cuando la IA no puede seguir hablando pero SÍ hay un
 * asesor asignado (guarda de identidad bloqueada, o el tool loop se quedó
 * sin pasos antes de escalar formalmente). Hasta el 14/9/2026 (Tarea 5, "La
 * voz cercana y la espera visible") era un texto fijo sin horario — igual
 * que la despedida SIN asesor antes del Frente B4 (5/9/2026, ver
 * escalate.ts). La auditoría de esta tarea midió 170 promesas "ya te paso
 * con un asesor" en 72 h, 23 de ellas con la tienda ya cerrada y sin decir
 * cuándo volvía a abrir — la misma falla que B4 ya había cerrado del lado
 * sin asesor.
 *
 * `status` puede llegar `undefined` (compatibilidad: un outcome que nunca
 * pasó por una llamada real a `escalateConversation`, por ejemplo un mock de
 * test) y se trata como tienda abierta — mismo criterio que
 * `escalationInstruction` en tools.ts.
 *
 * Tarea 3 ("La voz cercana y la espera visible", 14/9/2026): texto reescrito
 * para sonar de mostrador — la sección "CÓMO SUENAS" del prompt (prompt.ts)
 * pide que toda despedida diga por qué se pasa el caso, qué va a pasar
 * después y agradezca la espera; las tres ramas de acá cumplen esa misma
 * regla, no solo el guion que le llega al modelo.
 */
export function despedidaConAsesor(status?: BusinessStatus): string {
  if (!status || status.open) {
    return "Dame un momentico: ya le paso tu caso a un asesor para que te ayude con esto y te escriba por acá.";
  }
  if (!status.nextOpening) {
    return "Dame un momentico: ya le paso tu caso a un asesor para que te ayude con esto en cuanto la tienda vuelva a abrir; gracias por la paciencia.";
  }
  return `Dame un momentico: ya le paso tu caso a un asesor para que te ayude con esto. Eso sí, la tienda está cerrada ahora — te escribe ${status.nextOpening.dayLabel} a partir de las ${status.nextOpening.time}; gracias por la paciencia.`;
}

/**
 * Despedida fija del segundo adjunto sin texto seguido (Tarea 6, "La voz
 * cercana y la espera visible", 14/9/2026, decisión 5): 494 fotos y 117
 * audios en 72 h, la IA repitiendo "¿qué repuesto buscas?" hasta 10 veces.
 * Cuando `mediaStreakWithoutText` (history-line.ts) ve que ya se preguntó una
 * vez y llegó OTRO adjunto sin texto, no tiene sentido volver a preguntar: se
 * pasa el caso directo, sin gastar fase 0, fase 1 ni tool loop.
 *
 * Exportada, mismo motivo que `DESPEDIDA_SIN_ASESOR`: el test estático de
 * `agent.test.ts` la pasa por `revealsIdentity`.
 */
export const DESPEDIDA_MEDIA =
  "Ya vi que me mandaste varias cosas 🙌. Para no hacerte esperar, te paso con un asesor que lo revisa y te escribe por acá.";

/**
 * `DESPEDIDA_MEDIA` ya dice "te paso con un asesor" y "te escribe por acá",
 * pero esa promesa sola no dice CUÁNDO (Decisión 6, "la promesa dice
 * cuándo"): sin asesor asignado, se completa con el mismo cierre que ya usa
 * la red de seguridad sin asesor (`DESPEDIDA_SIN_ASESOR`); con asesor
 * asignado y la tienda cerrada, se le suma la misma línea de horario que
 * `despedidaConAsesor` ya sabe armar — para no duplicar esa lógica, se le
 * pide prestada.
 */
function despedidaMedia(unassigned: boolean | undefined, status?: BusinessStatus): string {
  if (unassigned) return `${DESPEDIDA_MEDIA} ${DESPEDIDA_SIN_ASESOR}`;
  if (!status || status.open) return DESPEDIDA_MEDIA;
  if (!status.nextOpening) {
    return `${DESPEDIDA_MEDIA} Eso sí, la tienda está cerrada ahora; en cuanto vuelva a abrir, el asesor te escribe.`;
  }
  return `${DESPEDIDA_MEDIA} Eso sí, la tienda está cerrada ahora — te escribe ${status.nextOpening.dayLabel} a partir de las ${status.nextOpening.time}.`;
}

/**
 * Cerradura de identidad, en caliente, sobre el texto final del tool loop.
 *
 * El 26 y 27/8/2026, en producción, la IA escribió "Soy el asistente
 * automatizado de SBK Motorcycles" en 34 de 68 y 26 de 151 mensajes PESE A
 * que el SYSTEM_PROMPT ya se lo prohibía (sección 1, prompt.ts): la
 * prohibición vivía solo en el guion, y el modelo la rompió igual. El 28/8,
 * con el prompt reescrito, fue 0 de 702 — pero que el guion funcione hoy no
 * es una garantía para siempre: otro modelo, o un cliente que insiste
 * "¿eres un bot?", puede volver a sacarla. Esta función es la cerradura para
 * ese día: corre DESPUÉS de que el guion ya tuvo su oportunidad.
 *
 * Se aplica UNA sola vez, en `runTurnPhases`, sobre el texto que ya pasó por
 * la red de seguridad de devolución/queja y está a punto de salir por
 * `sendAgentText`. `persona` y `automatizacion` bloquean igual (decisión del
 * operador, 6/9/2026): a un cliente le da lo mismo que la IA se delate como
 * automatización o que mienta siendo "Carlos" del mostrador.
 *
 * Si el borrador calza, se pide UNA reescritura con `generateText` — nunca
 * con `ToolLoopAgent`: las herramientas ya corrieron en el tool loop de
 * arriba, y volver a dárselas acá arriesga que el modelo invoque
 * `escalarAAsesor` una segunda vez sobre una conversación que quizás ya
 * escaló. `maxRetries: 0` por el mismo motivo que el tool loop: el
 * reintento vive en el control de ritmo (rate-limit.ts), y el del SDK
 * reintenta demasiado rápido para servir de algo.
 *
 * Si la reescritura no alcanza —sigue calzando, o `generateText` falla— ese
 * texto NO sale nunca: se escala (si el turno no había escalado ya) con
 * motivo "seguimiento" y se manda una de las dos despedidas fijas de arriba.
 * El cliente nunca se queda en silencio, y el caso siempre termina en manos
 * de una persona.
 */
async function applyIdentityGuard(params: {
  supabase: SupabaseClient<Database>;
  target: TurnTarget;
  conversationId: string;
  text: string;
  outcome: EscalationOutcome;
  turnTokens: TurnTokens;
  businessHours: BusinessHours;
}): Promise<{ text: string; turnTokens: TurnTokens; marca: "reescrita" | "bloqueada" | null }> {
  const { supabase, target, conversationId, outcome, businessHours } = params;
  const text = params.text;
  let turnTokens = params.turnTokens;

  const match = revealsIdentity(text);
  if (!match) return { text, turnTokens, marca: null };

  // Se recuerda el ÚLTIMO calce visto (el original, o el de la reescritura si
  // llegó a intentarse): es el que va al registro cuando el texto termina
  // bloqueado, para que el log sirva para diagnosticar cuál de las dos frases
  // se coló.
  let ultimoCalce = match;
  let motivoFallo: "reescritura_fallida" | "sigue_calzando" = "reescritura_fallida";

  try {
    const { model, providerOptions } = getAgentModel("low");
    const result = await generateText({
      model,
      // SYSTEM_PROMPT como prefijo EXACTO: es lo único que el proveedor
      // cachea (ver prompt.ts). Un prefijo distinto por turno paga la entrada
      // completa cada vez.
      system: SYSTEM_PROMPT + "\n\n" + rewriteSuffix(match.fragmento),
      messages: [{ role: "user", content: text }],
      providerOptions,
      maxRetries: 0,
    });
    turnTokens = addTokens(turnTokens, tokensFromUsage(result.usage));

    const reescrito = (result.text ?? "").trim();
    if (reescrito) {
      const segundoCalce = revealsIdentity(reescrito);
      if (!segundoCalce) {
        log.warn("identidad_reescrita", {
          conversationId,
          categoria: match.categoria,
          fragmento: match.fragmento,
        });
        return { text: reescrito, turnTokens, marca: "reescrita" };
      }
      ultimoCalce = segundoCalce;
      motivoFallo = "sigue_calzando";
    }
    // Reescritura vacía: se trata igual que una reescritura fallida —no hay
    // un segundo calce que reportar, así que `ultimoCalce` queda el original.
  } catch {
    // El proveedor puede estar caído o sin cuota: no es un fallo nuevo del
    // turno, es la misma clase de error que ya contempla el tool loop de
    // arriba. Acá no hay nada que reintentar (maxRetries: 0 fue deliberado):
    // se trata como una reescritura que no alcanzó.
  }

  log.error("identidad_bloqueada", {
    conversationId,
    categoria: ultimoCalce.categoria,
    fragmento: ultimoCalce.fragmento,
    motivo: motivoFallo,
  });

  if (!outcome.escalated) {
    // Mismo patrón que la red de seguridad de devolución/queja de arriba: si
    // el modelo ya había escalado antes de redactar, no se escala una
    // segunda vez — solo se reemplaza el texto.
    const forced = await escalateConversation(supabase, {
      conversationId,
      contactId: target.contactId,
      motivo: "seguimiento",
      resumen: "La respuesta redactada se describía como automatizada y no pudo corregirse. Retomar el hilo.",
      businessHours,
    });
    outcome.escalated = forced.escalated;
    outcome.assignedAgentName = forced.assignedAgentName ?? undefined;
    outcome.unassigned = forced.unassigned;
    outcome.motivo = "seguimiento";
    outcome.businessStatus = forced.businessStatus;
  }

  return {
    // `outcome.businessStatus` viaja desde CUALQUIER camino que haya escalado
    // —esta misma llamada, el tool del modelo (`buildEscalateTool`, tools.ts)
    // o la red de seguridad de devolución/queja de más abajo (Tarea 5,
    // 14/9/2026)—, así que `despedidaConAsesor` siempre usa el reloj de la
    // llamada que de verdad escaló, nunca uno recalculado acá.
    text: outcome.unassigned ? DESPEDIDA_SIN_ASESOR : despedidaConAsesor(outcome.businessStatus),
    turnTokens,
    marca: "bloqueada",
  };
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
  businessHours: BusinessHours,
  /**
   * T4, "Seba atiende el mostrador" (18/9/2026, D2/D3): `assigned_agent_id`
   * del chat AL ABRIR el turno. Con D2 un escenario puede calzar en un chat
   * que YA tiene asesor —el turno entero sigue corriendo, ya no corta en la
   * apertura— y esa respuesta tampoco es una que el cliente esté esperando
   * de una persona: sale marcada `is_auto_reply` desde el mismo envío (ver
   * `esperandoAsesor`, más abajo), y `journey_stage` no puede caer a `null`
   * al terminar (`stageFor`, ver el reseteo de más abajo).
   */
  assignedAgentId: string | null
): Promise<void> {
  // Con D2 la IA sigue respondiendo en un chat que YA tiene asesor: esa
  // respuesta es la misma cortesía automática de siempre —el cliente sigue
  // esperando a la PERSONA, no a Seba— así que sale marcada desde el envío,
  // no solo cuando el escenario decide escalar de nuevo (`afterSend:
  // "escalate"`, más abajo, que tiene su propio marcado posterior porque acá
  // todavía no se sabe si va a hacer falta un asesor NUEVO).
  const esperandoAsesor = Boolean(assignedAgentId);

  // Última mirada a las guardas antes de hablarle al cliente. Si la IA se apagó
  // —o si un asesor se metió— mientras el modelo elegía el escenario, el turno
  // termina acá sin enviar y sin etiquetar ni escalar: todo lo que sigue
  // acompaña a un mensaje que no salió.
  const salida = await deliver(supabase, target, entrega, lease, tiempos, "escenario", lastCustomerMessageAt, () =>
    sendPlaybookReply(supabase, target, playbook, { isAutoReply: esperandoAsesor })
  );
  if (!salida) return;
  if (await deliveryFailed(supabase, target.conversationId, salida, assignedAgentId)) return;

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
    // real. Tarea 5 ("La voz cercana y la espera visible", 14/9/2026): hasta
    // esta tarea el UPDATE solo corría si `escalateConversation` descubría
    // que no había NADIE (`result.unassigned`) — pero la promesa "ya te paso
    // con un asesor" tampoco es una respuesta real cuando SÍ hay alguien
    // asignado (170 promesas ≥ 30 min sin cumplir en la auditoría de esta
    // tarea, 23 nunca atendidas). `escalateConversation` deja `escalated:
    // true` en TODAS sus salidas, así que la condición pasa a ser esa: se
    // marca todo lo que la IA mandó en este turno, tenga o no asesor. El
    // trigger que sumó B1 (20260905070000_auto_reply_recalcula) recalcula
    // last_reply_at/awaiting_reply al ver que is_auto_reply pasó a true. La
    // ventana "desde el último mensaje del cliente" es exacta porque dentro
    // de un turno solo escribe la IA —si un humano escribe, deliver() frena
    // el envío antes de que llegue acá— y este turno responde a lo que el
    // cliente dijo después de su último mensaje, nunca a un turno anterior.
    if (result.escalated) {
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
          // (escalada o escalada_sin_asesor) ya quedó escrito por
          // escalateConversation, y el turno sigue igual aunque este UPDATE
          // falle.
          log.error("turno_escenario_despedida_no_marcada", {
            conversationId: target.conversationId,
            detail: error.message,
          });
        } else {
          // Renombrado (Tarea 5, 14/9/2026): antes `turno_escenario_sin_asesor_marcado`,
          // porque solo se escribía sin asesor. Ahora corre con o sin él.
          log.info("turno_escenario_escalado_marcado", {
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
    .update({ journey_stage: stageFor(assignedAgentId, null), active_tool: null })
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
 * Reclama el envío de la presentación de Seba, sellando `welcome_sent_at`
 * ANTES de mandar nada — mismo patrón que `claimWelcome` (route.ts,
 * ~l.316-333): el UPDATE condicional ES la carrera entera. Bajo READ
 * COMMITTED, dos lecturas concurrentes de la misma fila reevalúan el WHERE
 * contra lo que ya escribió la primera que confirma; la segunda ve 0 filas y
 * pierde limpio, sin tocar nada. Acá no debería haber carrera real —el lock
 * de conversación ya serializa los turnos de un mismo chat—, pero el patrón
 * es barato y deja la garantía escrita en la base, no solo en el orden en que
 * el código de hoy da la casualidad de llamarlo.
 *
 * T2b, plan "Seba atiende el mostrador" (18/9/2026): desde la migración
 * 20260917010000 (T0 del mismo plan) `welcome_sent_at` dejó de significar
 * "salió la PLANTILLA de bienvenida" (WHATSAPP_WELCOME_TEMPLATE, que en
 * producción sigue vacía) y pasó a significar "Seba ya se presentó en esta
 * conversación" — `welcome_sent_at IS NULL` es la condición que decide si
 * corresponde presentarse.
 */
async function claimPresentation(supabase: SupabaseClient<Database>, conversationId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("conversations")
    .update({ welcome_sent_at: new Date().toISOString() })
    .eq("id", conversationId)
    .is("welcome_sent_at", null)
    .select("id");

  if (error) {
    log.error("turno_presentacion_reclamo_fallido", { conversationId, detail: errorText(error) });
    return false;
  }
  return (data?.length ?? 0) > 0;
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

  // T4, "Seba atiende el mostrador" (18/9/2026, D2/D3): con la escalada sin
  // apagar la IA, el turno entero corre en un chat que YA tiene asesor — la
  // apertura de `runAgentTurn` dejó de cortar en cuanto veía
  // `assigned_agent_id` (ver esa guarda, más abajo en este archivo). Todo lo
  // que la IA mande de acá en más en un chat así sigue siendo una cortesía
  // automática, no una respuesta real: el cliente espera a la PERSONA, no a
  // Seba. `esperandoAsesor` viaja a cada envío (`isAutoReply`) para que
  // `awaiting_reply` no se apague solo, y `stageFor` (ver su comentario)
  // gobierna cada escritura de `journey_stage` de acá para abajo, para que
  // el chat no se caiga de la píldora "Escaladas" mientras el turno trabaja.
  const esperandoAsesor = Boolean(convo.assigned_agent_id);

  await supabase
    .from("conversations")
    .update({ journey_stage: stageFor(convo.assigned_agent_id, "classifying"), active_tool: null })
    .eq("id", conversationId);

  const history = await loadHistory(supabase, conversationId);
  if (history.length === 0) {
    // Bug 2 / S4 (T4, corrida "La IA ve lo que llega", 8/9/2026): esto era un
    // `return` mudo — sin traspaso, y DESPUÉS de haber dejado journey_stage
    // en "classifying" arriba, sin limpiarlo. Viola la invariante "ningún
    // lead invisible" de CLAUDE.md. Caso real cea69118-5d17-4f08-84c6-
    // 925755672b87: un audio del cliente sin texto previo dejaba el
    // historial armado por loadHistory vacío, el turno desaparecía sin
    // dueño y el reconciliador lo reencoló 30 veces hasta que un asesor
    // contestó a mano.
    //
    // Desde T2 (misma corrida) un audio, foto, video, documento o sticker ya
    // producen una línea vía historyLine — el historial solo queda vacío si
    // TODO lo que llegó fue `unsupported` o notas internas. Medido en
    // producción el 7/9/2026: 0 de 269 conversaciones esperando quedarían
    // vacías tras T2. Este `if` deja de ser el camino normal y pasa a ser la
    // red de seguridad — pero la invariante exige que igual deje rastro
    // cuando el caso vuelva a darse.
    log.warn("turno_sin_contenido_legible", { conversationId });
    await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "sin_contenido_legible" });
    await resetStage(supabase, conversationId, "turno_sin_contenido_legible", convo.assigned_agent_id);
    return;
  }

  const customerMessage = lastCustomerMessage(history);

  // Requisito 1 del cliente (18/9/2026, plan "Seba atiende el mostrador",
  // decisión D1): el primer mensaje de cada conversación —nueva, o reabierta
  // tras cierre (el webhook borra el sello al reabrir, ver route.ts)— tiene
  // que ser ESTRICTAMENTE el saludo que dictó el cliente, sin que el modelo
  // lo redacte ni lo parafrasee.
  //
  // Por qué lo manda el TURNO y no el webhook: acá viven las cuatro cosas
  // que garantizan que el saludo salga bien y una sola vez — el lock de
  // conversación, `deliver()` (que vuelve a mirar el interruptor y si un
  // asesor se metió justo antes de hablar), la ventana de 24 h de Meta
  // (`withinFreeformWindow` ya corrió al abrir el turno, antes de esta
  // función) y el `TurnTarget` congelado. Mandarlo desde el webhook saltaría
  // las cuatro guardas y correría en paralelo con el propio turno, sin
  // ninguna de ellas.
  //
  // Por qué son excluyentes con la plantilla de bienvenida
  // (WHATSAPP_WELCOME_TEMPLATE, route.ts): las dos comparten la misma
  // columna. Si algún día se configurara esa variable, `claimWelcome`
  // sellaría `welcome_sent_at` ANTES de que este turno llegue a correr —el
  // webhook encola después de intentar la bienvenida— y acá abajo
  // `claimPresentation` ya no tendría nada que reclamar: Seba no saludaría
  // encima de la plantilla. Hoy esa variable sigue vacía en producción, así
  // que este es el único saludo que sale.
  let introducedThisTurn = false;
  if (convo.welcome_sent_at === null) {
    const claimed = await claimPresentation(supabase, conversationId);
    if (claimed) {
      // "Solo saludó" decide si hace falta seguir redactando: un "hola" (o
      // una cortesía de apertura) pelado ya queda completamente contestado
      // con la presentación — seguir hasta fase 0/1 y el tool loop no
      // tendría nada más que decir. `isGreetingOnly`/`isCourtesyOnly`
      // (saludo.ts) son las mismas dos preguntas que ya usa el resto del
      // turno para lo mismo, sobre texto de cliente.
      const soloSaludo =
        customerMessage !== null && (isGreetingOnly(customerMessage) || isCourtesyOnly(customerMessage));

      const salida = await deliver(
        supabase,
        target,
        entrega,
        lease,
        tiempos,
        "presentacion",
        convo.last_customer_message_at,
        () =>
          sendAgentText(supabase, target, sebaGreeting(dayBand(new Date())), {
            // `!soloSaludo`: si el cliente solo saludó, este mensaje ES la
            // respuesta completa del turno y tiene que apagar
            // `awaiting_reply` como cualquier respuesta real. Si en cambio
            // sigue una redacción de verdad, el saludo NO puede apagarla
            // todavía — si esa redacción termina escalando, el cliente
            // tiene que seguir viéndose en "Pendientes" hasta que una
            // persona le escriba (CLAUDE.md, "Toda salida de un turno que
            // escaló es is_auto_reply"): apagarla acá la encendería de
            // nuevo recién con la escalada, dejando una ventana falsa en el
            // medio.
            isAutoReply: !soloSaludo,
          })
      );

      // `claimPresentation` ya selló `welcome_sent_at` ANTES de este envío.
      // Si `deliver()` frenó (lock perdido, interruptor apagado, un asesor
      // se adelantó) o Meta rechazó el mensaje, no hubo presentación real:
      // el sello se devuelve a null — mismo patrón que Meta rechazando la
      // plantilla de bienvenida (`bienvenida_rechazada_por_meta`, route.ts,
      // ~l.391) — para que la próxima vez que el cliente escriba, Seba se
      // presente de verdad. `deliver()`/`deliveryFailed()` ya dejaron su
      // propio traspaso; acá no hace falta uno nuevo.
      if (!salida) {
        await supabase.from("conversations").update({ welcome_sent_at: null }).eq("id", conversationId);
        return;
      }
      if (await deliveryFailed(supabase, conversationId, salida, convo.assigned_agent_id)) {
        await supabase.from("conversations").update({ welcome_sent_at: null }).eq("id", conversationId);
        return;
      }

      if (soloSaludo) {
        // Sin fase 0, fase 1 ni tool loop: tres llamadas al proveedor que un
        // "hola" pelado no iba a necesitar.
        await resetStage(supabase, conversationId, "turno_presentacion_saludo", convo.assigned_agent_id);
        await logTurn(supabase, conversationId, {
          intent: null,
          action: "answered",
          summary: "Seba se presentó; el cliente solo saludó.",
          tokens: null,
          customerMessage,
        });
        return;
      }

      // Hay más que atender: el turno sigue de largo (guarda de cortesía,
      // fase 0/1, tool loop) y `buildInstructions` recibe `introducedThisTurn:
      // true` para que el modelo sepa que el saludo YA salió, en un mensaje
      // aparte, y no lo repita.
      introducedThisTurn = true;
    }
  }

  // Guarda de cortesía tras una escalada abierta (Tarea 4, "La voz cercana y
  // la espera visible", 14/9/2026, decisión 4). ANTES de fase 0 y de
  // clasificar: tras la devolución masiva del 13/9/2026, un "Ok, muchas
  // gracias" reencolado recibió la despedida fija de escalada ("¡Gracias por
  // preferirnos!") mientras la conversación seguía esperando a que un asesor
  // le escribiera — una respuesta MÁS, y ninguna de la persona que el
  // cliente en realidad espera. Si el último mensaje es solo cortesía de
  // cierre y la última escalada de esta conversación sigue abierta (ningún
  // asesor escribió después), el turno se calla: no hay pregunta nueva que
  // contestar, y CLAUDE.md prohíbe justo el `return` que no deja rastro —
  // por eso la fila de traspaso lleva el MISMO dueño que ya tenía la
  // conversación (el asesor asignado, o `unassigned` si no lo hay):
  // `awaiting_reply` no se toca, el cliente sigue esperando a la persona.
  //
  // Tarea 5 (15/9/2026): el hueco que dejaba esto anotado como deuda en
  // CLAUDE.md quedó cerrado — `escalationOpen` ya no mira SOLO la última
  // fila de `conversation_handoffs`, sino la última que CAMBIA DE MANOS
  // (`RAZONES_QUE_NO_CIERRAN_LA_ESCALADA` en handoffs.ts). Antes, un
  // `asignada` que `openTurn` graba en cada mensaje del cliente a un chat ya
  // asignado —o una segunda `pausada`, o una segunda `cortesia_tras_escalada`
  // de esta misma guarda— tapaba la `escalada` y esta guarda dejaba de
  // disparar: la IA volvía a despedirse en cada mensaje de cortesía
  // posterior al primero.
  if (customerMessage && isCourtesyOnly(customerMessage) && (await escalationOpen(supabase, conversationId))) {
    await recordHandoff(supabase, {
      conversationId,
      toKind: convo.assigned_agent_id ? "human" : "unassigned",
      toId: convo.assigned_agent_id ?? null,
      reason: "cortesia_tras_escalada",
    });
    await resetStage(supabase, conversationId, "turno_cortesia_tras_escalada", convo.assigned_agent_id);
    log.info("turno_cortesia_tras_escalada", { conversationId });
    await logTurn(supabase, conversationId, {
      intent: null,
      action: "answered",
      summary: "Cortesía con escalada abierta: no se respondió.",
      tokens: null,
      customerMessage,
    });
    return;
  }

  // Segundo adjunto sin texto seguido (Tarea 6, "La voz cercana y la espera
  // visible", 14/9/2026, decisión 5). ANTES de fase 0 y de clasificar, mismo
  // criterio que la guarda de cortesía de arriba: 494 fotos y 117 audios en
  // 72 h, con la IA repitiendo "¿qué repuesto buscas?" hasta 10 veces porque
  // nadie contaba la racha. Si el cliente ya recibió una pregunta de la IA
  // (o de un asesor, mientras no sea otro adjunto suyo) y vuelve a mandar
  // OTRO adjunto sin escribir nada, insistir una vez más no sirve: se escala
  // en código, directo, sin gastar fase 0/1 ni el tool loop —tres llamadas al
  // proveedor que un cuarto "¿qué es esto?" no iba a mejorar—.
  const racha = mediaStreakWithoutText(history);
  if (racha.adjuntos >= 2 && racha.yaPreguntamos) {
    const forced = await escalateConversation(supabase, {
      conversationId,
      contactId: target.contactId,
      motivo: "seguimiento",
      resumen: `El cliente mandó ${racha.adjuntos} adjuntos sin texto (fotos/notas de voz) y ya se le pidió que escribiera. Revisar en el chat qué mandó.`,
      businessHours,
    });

    const salida = await deliver(
      supabase,
      target,
      entrega,
      lease,
      tiempos,
      "adjuntos_sin_texto",
      convo.last_customer_message_at,
      () =>
        sendAgentText(supabase, target, despedidaMedia(forced.unassigned, forced.businessStatus), {
          isAutoReply: true,
        })
    );
    if (!salida) return;
    // `escalateConversation` ya dejó su traspaso (`escalada`/`escalada_sin_asesor`)
    // antes de este envío: si Meta lo rechaza, no se pisa con uno nuevo
    // (mismo motivo que el resto de los caminos que escalan primero y hablan
    // después, ver `deliveryFailed`).
    if (await deliveryFailed(supabase, conversationId, salida, convo.assigned_agent_id, true)) return;

    await logTurn(supabase, conversationId, {
      intent: null,
      action: "escalated",
      summary: `Segundo adjunto sin texto → ${forced.assignedAgentName ?? "(sin asesor disponible)"}.`,
      tokens: null,
      customerMessage,
    });
    return;
  }

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
  // Si la última línea del CLIENTE es un marcador de media (8/9/2026, ver
  // lastUserLineIsMarker), matchPlaybook NI SIQUIERA se llama: ningún
  // disparador de escenario calza contra "[El cliente envió una foto…]", así
  // que preguntarlo igual gastaría una llamada al proveedor de balde. La
  // clasificación de intención SÍ corre igual —define qué herramientas recibe
  // el modelo, y "otro"/"consulta_disponibilidad" siguen siendo válidos
  // aunque el último mensaje sea una foto—. El caso normal, texto DESPUÉS de
  // la foto (caso `7631718e…`), no entra acá: ahí la última línea de cliente
  // es texto y fase 0 corre con el marcador anterior en contexto.
  const ultimoEsMarcador = lastUserLineIsMarker(history);
  if (ultimoEsMarcador) {
    log.info("turno_ultimo_mensaje_sin_texto", { conversationId });
  }

  // La construcción de matchPromise vive DENTRO del callback de medir (T4,
  // 8/9/2026, ajuste del orquestador): antes se armaba afuera, así que
  // matchPlaybook ya podía estar en vuelo antes de que arrancara el
  // cronómetro de "clasificacionMs" — el tramo medía de menos. Mismo
  // comportamiento, medido desde que la llamada de verdad se dispara.
  const [match, classified] = await medir(tiempos, "clasificacionMs", () => {
    const matchPromise: Promise<PlaybookMatch> = ultimoEsMarcador
      ? Promise.resolve({ playbook: null, usage: ZERO_USAGE })
      : matchPlaybook(history, playbooks, undefined, businessHours);

    return Promise.all([
      // matchPlaybook nunca lanza: un fallo del proveedor deja el turno por el
      // flujo genérico. classifyIntent sí, y su fallo aborta el turno — así que
      // se captura acá para que no se lleve por delante un escenario que quizá
      // sí reconoció.
      matchPromise,
      classifyIntent(history).then(
        (result) => ({ ok: true as const, result }),
        (err: unknown) => ({ ok: false as const, err })
      ),
    ]);
  });

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
        businessHours,
        convo.assigned_agent_id
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
      summary: `Fallo al clasificar intención: ${errorText(classified.err)}`,
      tokens: classifiedTokens,
      customerMessage,
    });
    // Bug 2, hallazgo 2 del plan (T4, 8/9/2026): este `return` dejaba
    // journey_stage en "classifying" para siempre — el corte de red de
    // OpenRouter del 7/9/2026 a las 11:57 UTC pasó justo por acá. NO se
    // escribe un traspaso nuevo: agent_turns ya quedó con action: "error"
    // arriba, y el reconciliador recoge la conversación sola porque
    // awaiting_reply sigue en true.
    await resetStage(supabase, conversationId, "turno_clasificacion_fallida", convo.assigned_agent_id);
    return;
  }

  const intent: Intent = classified.result.intent;
  const classifyTokens = classifiedTokens;

  // Observabilidad, no una barrera (Tarea 5, 14/9/2026, mismo criterio que
  // logTurn de arriba): que la columna `intent` de la conversación no se
  // pudiera guardar no puede tumbar el turno — el cliente ya está a punto de
  // recibir su respuesta.
  {
    const { error } = await supabase.from("conversations").update({ intent }).eq("id", conversationId);
    if (error) {
      log.error("turno_intencion_no_guardada", { conversationId, detail: errorText(error) });
    }
  }

  // Fuera de tema: el turno termina acá. No se arma el tool loop —que es la
  // parte cara— y el texto sale de una constante, así que no cuesta salida.
  // A la segunda insistencia ni se responde: repetir la misma línea contra
  // alguien que insiste (o contra otro bot) es un ping-pong sin final.
  if (intent === "fuera_de_tema") {
    const repetido = alreadyRedirected(history);
    if (!repetido) {
      const salió = await deliver(
        supabase,
        target,
        entrega,
        lease,
        tiempos,
        "fuera_de_tema",
        convo.last_customer_message_at,
        // T4, "Seba atiende el mostrador" (18/9/2026): en un chat ya
        // asignado esta redirección tampoco es una respuesta real — mismo
        // criterio que el resto de las salidas de este turno.
        () => sendAgentText(supabase, target, OFF_TOPIC_REPLY, { isAutoReply: esperandoAsesor })
      );
      if (!salió) return;
      if (await deliveryFailed(supabase, conversationId, salió, convo.assigned_agent_id)) return;
    }

    await supabase
      .from("conversations")
      .update({ journey_stage: stageFor(convo.assigned_agent_id, null), active_tool: null })
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
  const deps = {
    supabase,
    conversationId,
    contactId: target.contactId,
    businessHours,
  };

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

  // Tarea 3 ("La voz cercana y la espera visible", 14/9/2026): el nombre que
  // la IA usa para sonar de mostrador, no de ventanilla. `customerFirstName`
  // devuelve `null` para lo que no parece un nombre de persona (un teléfono,
  // "SBK Motos" es la única excepción aceptada, ver customer-name.ts) y el
  // sufijo del prompt simplemente no aparece en ese caso.
  const customerName = customerFirstName(convo.contact?.display_name ?? null, convo.contact?.profile_name ?? null);

  const agent = new ToolLoopAgent({
    model,
    instructions: buildInstructions({
      intent,
      introducedThisTurn,
      missingCatalog,
      businessHours,
      customerName,
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
        .update({ journey_stage: stageFor(convo.assigned_agent_id, "tool_running"), active_tool: toolCall.toolName })
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
    // Mismo criterio que `pasos`: telemetría, nunca puede tumbar el turno que
    // está midiendo. 7/9/2026: es lo único que dirá, sin tocar el prompt del
    // redactor, qué herramienta dispara el segundo paso (T4, segunda ola).
    tiempos.herramientas = toolNamesUsed(result.steps);
    turnTokens = addTokens(classifyTokens, tokensFromUsage(result.usage));
  } catch (err) {
    await logTurn(supabase, conversationId, {
      intent,
      action: "error",
      summary: errorText(err),
      tokens: classifyTokens,
      customerMessage,
    });
    // Bug 2, hallazgo 2 del plan (T4, 8/9/2026): antes esto SOLO apagaba
    // active_tool y dejaba journey_stage en "classifying"/"tool_running"
    // congelado para siempre. Mismo criterio que la puerta de clasificación
    // fallida: sin traspaso nuevo (agent_turns ya quedó con action: "error"
    // arriba, y el reconciliador la recoge sola), pero con la etapa limpia.
    await resetStage(supabase, conversationId, "turno_tool_loop_fallido", convo.assigned_agent_id);
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
      // Corregido en la Tarea 5 (14/9/2026): esta llamada nunca había pasado
      // `businessHours` y caía al horario por defecto de escalate.ts pase lo
      // que pase en `agent_settings` — inofensivo mientras la despedida CON
      // asesor no decía la hora (siempre el mismo texto fijo), pero
      // `despedidaConAsesor` de abajo sí la necesita correcta.
      businessHours,
    });
    outcome.escalated = forced.escalated;
    outcome.assignedAgentName = forced.assignedAgentName ?? undefined;
    // Copiado también acá (anexo A1, 5/9/2026): esta es la red de seguridad,
    // no la herramienta que el modelo invoca — sin este campo, el envío de
    // abajo no tendría cómo saber si la despedida se quedó sin nadie detrás.
    outcome.unassigned = forced.unassigned;
    // Idem `businessStatus` (Tarea 5, 14/9/2026): lo necesita `despedidaConAsesor`
    // de acá abajo, y también la guarda de identidad si le toca reemplazar
    // este mismo texto más adelante en el turno.
    outcome.businessStatus = forced.businessStatus;
    // Mismo patrón que `buildEscalateTool` en tools.ts (`outcome.motivo =
    // motivo`): sin esta línea el `summary` final quedaba "Motivo:
    // undefined." (hallazgo del 6/9/2026 al integrar la guarda de identidad).
    outcome.motivo = intent;
    if (!text.trim()) {
      // Sin asesores no se promete lo que no va a pasar: nadie va a
      // contestar en un minuto si no hay nadie trabajando. Con asesor, desde
      // la Tarea 5 (14/9/2026), la despedida nombra cuándo escribe si la
      // tienda ya cerró (`despedidaConAsesor`, arriba).
      text = forced.unassigned ? DESPEDIDA_SIN_ASESOR : despedidaConAsesor(forced.businessStatus);
    }
  }

  // Guarda de identidad (6/9/2026): último control antes de hablarle al
  // cliente, sobre el texto que ya sobrevivió a la red de seguridad de
  // arriba. Solo actúa si de verdad hay algo que enviar — un turno que se
  // quedó en silencio no tiene nada que reescribir ni que bloquear.
  let identityMark: "reescrita" | "bloqueada" | null = null;
  if (text.trim()) {
    const guarded = await applyIdentityGuard({
      supabase,
      target,
      conversationId,
      text,
      outcome,
      turnTokens,
      businessHours,
    });
    text = guarded.text;
    turnTokens = guarded.turnTokens;
    identityMark = guarded.marca;
  }

  if (text.trim()) {
    // Acá es donde más se nota: entre abrir el turno y llegar a esta línea
    // pasaron el reconocimiento de escenario, la clasificación y hasta cinco
    // pasos de tool loop. Es el punto del turno más lejano al momento en que
    // se miraron las guardas al abrirlo.
    // `isAutoReply` (anexo A1, 5/9/2026; ampliado Tarea 5, "La voz cercana y
    // la espera visible", 14/9/2026): una despedida sin nadie detrás no es
    // una respuesta, y desde el 14/9/2026 la promesa de un asesor TAMPOCO lo
    // es, tenga o no asesor asignado — la auditoría de esta tarea midió 170
    // promesas "ya te paso con un asesor" con 30 minutos o más de espera, 23
    // de ellas sin cumplir nunca. Antes la condición exigía además
    // `outcome.unassigned === true`, así que una escalación CON asesor
    // apagaba `awaiting_reply` con un mensaje que no era una respuesta real:
    // el cliente desaparecía de "Pendientes" y de "Tuyas" del asesor
    // asignado, y "Con asesor" del Recorrido nunca contaba un atascado de
    // verdad. Ahora basta con `outcome.escalated`: cubre los TRES caminos
    // por los que la IA se despide al escalar —el texto fijo de la red de
    // seguridad de arriba, el que redacta el propio modelo tras leer
    // `instruccionParaTuRespuesta` de la herramienta (`tools.ts`), y la
    // despedida fija con asesor (`despedidaConAsesor`, arriba)—. El cliente
    // sigue esperando a una persona en los tres casos, así que el trigger
    // `handle_new_message` no debe apagar `awaiting_reply` con este mensaje
    // — de ahí la misma marca que ya lleva la bienvenida automática (T0.1).
    // No se toca la base: el trigger de la migración 20260905010000 ya hace
    // el resto con solo este booleano.
    //
    // T4, "Seba atiende el mostrador" (18/9/2026, D2/D3): se suma `||
    // esperandoAsesor` — con la escalada sin apagar la IA, este mismo tramo
    // corre TAMBIÉN cuando el chat ya tenía asesor ANTES de este turno (sin
    // que este turno haya escalado nada nuevo, `outcome.escalated` seguiría
    // en `false`). Esa respuesta es la misma cortesía de siempre: el cliente
    // le sigue hablando a Seba mientras espera a la PERSONA, así que tampoco
    // puede apagar `awaiting_reply`.
    const salida = await deliver(
      supabase,
      target,
      entrega,
      lease,
      tiempos,
      "redaccion",
      convo.last_customer_message_at,
      () =>
        sendAgentText(supabase, target, text.trim(), {
          isAutoReply: outcome.escalated || esperandoAsesor,
        })
    );
    if (!salida) return;
    // `outcome.escalated` es la bandera: `escalateConversation` SIEMPRE deja
    // su traspaso antes de devolver (por el tool del modelo o por la red de
    // seguridad de arriba), así que si ya está en true acá el dueño de la
    // conversación ya quedó fijado y un rechazo de Meta no debe pisarlo.
    if (await deliveryFailed(supabase, conversationId, salida, convo.assigned_agent_id, outcome.escalated)) return;
  }

  if (!outcome.escalated) {
    await supabase
      .from("conversations")
      .update({ journey_stage: stageFor(convo.assigned_agent_id, null), active_tool: null })
      .eq("id", conversationId);
  }

  // Prefijo de la bitácora (6/9/2026): así un supervisor que lee `agent_turns`
  // ve de un vistazo si este turno pasó por la guarda de identidad, sin tener
  // que cruzar con los logs de `identidad_reescrita`/`identidad_bloqueada`.
  const identityPrefix =
    identityMark === "reescrita" ? "[identidad reescrita] " : identityMark === "bloqueada" ? "[identidad bloqueada] " : "";

  await logTurn(supabase, conversationId, {
    intent,
    action: outcome.escalated ? "escalated" : "answered",
    summary:
      identityPrefix +
      (outcome.escalated
        ? `Escalado a ${outcome.assignedAgentName ?? "(sin asesor disponible)"}. Motivo: ${outcome.motivo}.`
        : text),
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
 *
 * `options.vencioEn` (7/9/2026, T0): el vencimiento con que la cola reclamó
 * este turno — lo que hace falta para separar, en `turno_tiempos`, la
 * ventana de silencio (diseño) de la espera en cola (atraso). Se queda vacío
 * en los turnos que no pasan por la cola (`api/dev/simulate-message`), y ahí
 * `debounceMs`/`colaMs` salen `null` sin que el turno se caiga por eso.
 */
export async function runAgentTurn(conversationId: string, options: { vencioEn?: number } = {}): Promise<void> {
  const supabase = createAdminClient();

  const [
    { data: canRun, error: canRunError },
    { data: conversation },
    { data: settingsRow, error: settingsError },
  ] = await Promise.all([
    // agent_can_run junta el interruptor global y el tope de gasto del día.
    // La decisión vive en la base para que sea la misma la pregunte quien la
    // pregunte, y para que el tope se levante solo al cambiar el día.
    supabase.rpc("agent_can_run"),
    supabase
      .from("conversations")
      .select(
        // Tarea 3, "La voz cercana y la espera visible" (14/9/2026):
        // display_name/profile_name viajan con el resto de la fila del
        // contacto para que la IA pueda saludar por nombre — ver
        // customer-name.ts. ai_resume_cutoff_at (Tarea 3 de "La IA no vuelve
        // a pedir lo que ya pidió", 16/9/2026): la guarda de
        // "mensaje_previo_a_devolucion" de más abajo la necesita fresca en
        // cada turno.
        "id, contact_id, ai_enabled, assigned_agent_id, welcome_sent_at, last_customer_message_at, ai_resume_cutoff_at, contact:contacts(phone_number, display_name, profile_name), channel:whatsapp_channels(phone_number_id, status)"
      )
      .eq("id", conversationId)
      .maybeSingle(),
    // Horario de atención (Frente B3, "El reloj dice la verdad", 5/9/2026):
    // se lee junto con las otras dos porque tampoco depende de ellas. Una
    // fila rota, sin permiso o sin fila cae al horario por defecto más abajo
    // — el turno nunca se cae por esto.
    supabase.from("agent_settings").select("business_hours").eq("id", true).maybeSingle(),
  ]);

  // Tarea 5 (14/9/2026): un ERROR de la RPC (base caída, red cortada) no es
  // lo mismo que una RESPUESTA que dice "no" — mismo motivo que el cambio en
  // `stillEnabled`, más abajo. Antes esto se desestructuraba con `{ data:
  // canRun }` a secas: un `error` acá dejaba `canRun` en `undefined`, que
  // `!canRun` trataba exactamente igual que un `false` genuino y el turno
  // terminaba con `turno_saltado_ia_apagada` + `agente_no_puede_correr` —un
  // corte de infraestructura disfrazado de interruptor apagado, el mismo
  // hallazgo 10 de la auditoría (13 turnos así en 72 h). Ahora lanza: la cola
  // reintenta un fallo transitorio en vez de archivarlo como una decisión.
  if (canRunError) {
    log.error("turno_interruptor_no_consultable", { conversationId, detail: errorText(canRunError) });
    throw new Error(`agent_can_run no consultable: ${errorText(canRunError)}`, { cause: canRunError });
  }

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
  // Acá abajo `canRun` es SIEMPRE una respuesta real (`true`/`false`): el
  // caso "no se pudo preguntar" ya salió arriba, antes de este punto.
  if (!canRun) {
    // Antes era un `return` mudo. Con la cola llena y la IA apagada, los
    // turnos se reclamaban y desaparecían sin dejar rastro de por qué.
    log.info("turno_saltado_ia_apagada", { conversationId });
    await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "agente_no_puede_correr" });
    return;
  }
  // T4, "Seba atiende el mostrador" (18/9/2026, D2, requisito 6 del
  // cliente): las dos guardas se FUSIONAN en una — hasta esta corrida eran
  // dos `if` separados y un chat asignado cortaba el turno SIN mirar
  // `ai_enabled` (anexo A2, 5/9/2026: antes de eso el orden era al revés,
  // ver la historia vieja más abajo). Con D2 la escalada ya NO apaga la IA
  // (`escalate.ts` deja `ai_enabled` intacto): asignar ya no significa
  // "cállate", significa "Seba sigue respondiendo hasta que el asesor
  // escriba de verdad". Por eso ahora la única condición que corta el turno
  // es `!convo.ai_enabled` — lo que la apaga es el trigger
  // `handle_agent_message_silences_ai` (migración 20260917010000, un
  // mensaje REAL del asesor) o la pausa manual, nunca la asignación por sí
  // sola. Asignado + IA encendida ya NO hace `return` acá: el turno sigue
  // de largo, y las salidas que hable la IA de acá en más se marcan
  // `is_auto_reply` (ver `esperandoAsesor` en `runTurnPhases`) para que
  // `awaiting_reply` no se apague con una cortesía automática mientras el
  // cliente sigue esperando a una persona.
  //
  // Historia vieja (anexo A2, 5/9/2026, todavía válida para por qué el
  // orden importa cuando SÍ hay que cortar): antes de ese anexo se miraba
  // primero `ai_enabled`, así que un chat con dueño y la IA apagada en él
  // —el estado normal tras una escalación o un cierre manual, no un caso
  // raro— caía en la rama de `pausada`/`unassigned` sin que importara que
  // tenía asesor: la bitácora decía "sin dueño" de una conversación que sí
  // lo tenía. Por eso, DENTRO de la rama que sí corta (`!ai_enabled`), se
  // sigue mirando primero `assigned_agent_id` para decidir el traspaso.
  if (!convo.ai_enabled) {
    if (convo.assigned_agent_id) {
      await recordHandoff(supabase, {
        conversationId,
        toKind: "human",
        reason: "asignada",
        toId: convo.assigned_agent_id,
      });
    } else {
      await recordHandoff(supabase, { conversationId, toKind: "unassigned", reason: "pausada" });
    }
    return;
  }

  // Tarea 3, "La IA no vuelve a pedir lo que ya pidió" (16/9/2026). Caso
  // real: un cliente pide un asesor -> la IA escala y se despide ("te paso
  // con un asesor") -> un asesor desasigna y reactiva la IA a mano -> en
  // menos de un minuto el reconciliador reencola la conversación, y el turno
  // corre sobre el MISMO mensaje viejo del cliente: el modelo vuelve a
  // escalar y repite la misma promesa. Es el mecanismo que el 13/9 volvió a
  // escalar 63 casos.
  //
  // Caso 5, hallado en la revisión adversarial de este plan: el cliente
  // escribe "¿ya me atienden?" MIENTRAS espera al asesor -- con la IA
  // apagada por la escalada, el webhook lo encola igual y el turno sale por
  // `pausada` (arriba), así que ese mensaje queda pendiente y es ANTERIOR a
  // la devolución. La primera versión de esta guarda (`awaiting_any_reply`,
  // comparaba contra la última SALIDA hacia el cliente) tenía cinco fallas
  // -- entre ellas, la carrera de ráfaga: si el cliente escribe mientras la
  // IA redacta, la respuesta queda fechada DESPUÉS de ese mensaje y la
  // guarda vieja lo callaba también a él. Esta versión no sufre esa carrera
  // porque compara contra un sello que SOLO se mueve con una devolución
  // humana, nunca con una salida de la IA: `ai_resume_cutoff_at` es el
  // `last_customer_message_at` del instante en que un trigger de la base
  // (`handle_conversation_ai_resume`, 20260916010000) vio la fila entrar al
  // estado "IA encendida y sin asesor". Un mensaje del cliente fechado
  // DESPUÉS de ese instante queda siempre por delante del sello, sin
  // importar cuándo salió la respuesta.
  //
  // La condición: si `last_customer_message_at` es anterior O IGUAL al
  // sello, ese mensaje ya estaba ahí cuando devolvieron el chat y no hay
  // nada nuevo que contestar. La igualdad cuenta como previo a propósito --
  // el sello se copia de ese mismo campo en el instante de la devolución,
  // así que un sello igual al último mensaje es el caso normal de "no
  // escribió nada después", no un empate a resolver a favor de la IA.
  //
  // Además del reconciliador (el camino que destapó el caso real), esta
  // guarda tapa los turnos que un mensaje viejo puede volver a disparar por
  // otras vías: los turnos diferidos por ritmo/cupo/lock que se reprograman
  // solos con `registrarDiferidos`, y los reintentos de la cola que corren
  // DESPUÉS de que alguien devolvió el chat a la IA.
  //
  // Va DESPUÉS de `pausada`: con la IA apagada en este chat, esa es la razón
  // más específica y tiene que ganar aunque también calce esta. Va ANTES de
  // `humanHasWritten`: esa guarda cuesta una consulta a `messages`, y si
  // `conversations` ya trae el sello no hace falta preguntarle nada más a la
  // base para llegar a la misma conclusión de "no hay nada nuevo que
  // contestar".
  //
  // Por qué `unassigned` y no el asesor que tenía antes de la escalada
  // (decisión del operador, 16/9/2026): el cliente sigue esperando a una
  // PERSONA que todavía no le escribió nada, así que el chat tiene que verse
  // en "Sin dueño" -- no en la bandeja de un asesor que ya lo soltó. En este
  // punto `assigned_agent_id` ya se filtró arriba (rama `asignada`), así que
  // siempre es `null` de todos modos.
  if (
    convo.ai_resume_cutoff_at &&
    convo.last_customer_message_at &&
    Date.parse(convo.last_customer_message_at) <= Date.parse(convo.ai_resume_cutoff_at)
  ) {
    log.info("turno_mensaje_previo_a_devolucion", { conversationId });
    await recordHandoff(supabase, {
      conversationId,
      toKind: "unassigned",
      reason: "mensaje_previo_a_devolucion",
    });
    return;
  }

  // Un chat que un asesor está atendiendo AHORA es de ese asesor.
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
  //
  // Hasta el 8/9/2026 la pregunta era "¿alguna vez escribió un asesor?", sin
  // ventana de tiempo — 47 de 48 conversaciones mudas del atraso medido ese
  // día tenían un humano que había escrito ALGUNA VEZ, y "Reactivar
  // respuestas automáticas" (que solo toca `ai_enabled`) no las liberaba.
  // Caso `3b654d2c-3cf8-4eef-8638-bc75e45cb10a`: un "a" de un supervisor el
  // 28/8 dejaba muda a la IA para un cliente que escribió por primera vez en
  // días el 7/9. La regla nueva (`humanClaimsChat`, human-handled.ts) mira si
  // el asesor se adelantó al último mensaje del cliente o si escribió en los
  // últimos G minutos (`AI_HUMAN_GRACE_MINUTES`, default 30) — "¿lo está
  // tocando AHORA?", no "¿lo tocó algún día?".
  if (await humanHasWritten(supabase, conversationId, convo.last_customer_message_at)) {
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
    const tiempos = newTurnTiming(convo.last_customer_message_at, options.vencioEn);
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
      // salió temprano —sin nada legible en el historial, con el interruptor
      // abajo— deja sus tramos en null y entregado: false, que también dice
      // algo (T4, 8/9/2026: esa salida ahora además deja su propio traspaso
      // en conversation_handoffs, pero turno_tiempos se sigue escribiendo
      // igual, con el mismo entregado: false de siempre).
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
