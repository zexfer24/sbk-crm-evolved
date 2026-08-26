import "server-only";
import { ToolLoopAgent, isStepCount, type LanguageModelUsage, type ModelMessage, type ToolSet } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Playbook, Tag } from "@/lib/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { classifyIntent, type Intent } from "@/lib/ai/classify";
import { currentAgentModelLabel, getAgentModel } from "@/lib/ai/model";
import { OFF_TOPIC_REPLY, buildInstructions } from "@/lib/ai/prompt";
import { buildCatalogTool, buildEscalateTool, buildOrderHistoryTool, type EscalationOutcome } from "@/lib/ai/tools";
import { TOOL_KEYS, fetchEnabledToolKeys } from "@/lib/ai/agent-tools";
import { buildKnowledgeTool } from "@/lib/ai/knowledge";
import { escalateConversation } from "@/lib/ai/escalate";
import { withConversationTurnLock } from "@/lib/ai/conversation-lock";
import { humanHasWritten } from "@/lib/ai/human-handled";
import { fetchActivePlaybooks, matchPlaybook } from "@/lib/ai/playbooks";
import { sendAgentText, sendPlaybookReply } from "@/lib/ai/send";
import { buildTurnTarget, type AgentConversation, type TurnTarget } from "@/lib/ai/turn-target";
import { NonRetryableTurnError, newTurnDelivery, type TurnDelivery } from "@/lib/ai/turn-delivery";
import { errorText, log } from "@/lib/log";
import { withinFreeformWindow } from "@/lib/dashboard";

// ---------------------------------------------------------------------------
// Orquestador del turno del agente. Tres fases, en orden:
//
//   0. Reconocer si el mensaje calza con una respuesta predeterminada. Si
//      calza, se envía ese texto tal cual y el turno termina ahí — sin
//      clasificar ni redactar.
//   1. Clasificar la intención (una de cuatro categorías genéricas).
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
    .select("sender_type, content, is_internal_note")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  const messages: ModelMessage[] = [];
  for (const row of [...(data ?? [])].reverse()) {
    if (row.is_internal_note || row.sender_type === "system" || !row.content) continue;
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
  playbook: Playbook,
  tokens: TurnTokens,
  customerMessage: string | null
): Promise<void> {
  // Se marca ANTES de enviar: si el envío falla a mitad no sabemos si el
  // mensaje salió, y ante la duda el turno deja de ser reintentable. Ver
  // turn-delivery.ts.
  entrega.intentado = true;
  await sendPlaybookReply(supabase, target, playbook);

  // Se etiqueta siempre que el escenario responda, escale o no: un escenario
  // que deja al cliente esperando también puede querer dejar marcado el caso.
  await applyPlaybookTags(supabase, target.conversationId, target.contactId, playbook.tags);

  if (playbook.afterSend === "escalate") {
    const result = await escalateConversation(supabase, {
      conversationId: target.conversationId,
      contactId: target.contactId,
      motivo: "seguimiento",
      resumen: `Respuesta automática "${playbook.name}". Falta que un asesor continúe el caso.`,
    });

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
  entrega: TurnDelivery
): Promise<void> {
  const conversationId = target.conversationId;

  await supabase
    .from("conversations")
    .update({ journey_stage: "classifying", active_tool: null })
    .eq("id", conversationId);

  const history = await loadHistory(supabase, conversationId);
  if (history.length === 0) return;

  const customerMessage = lastCustomerMessage(history);

  // Fase 0 — ¿el mensaje calza con una respuesta ya redactada? Si calza, se
  // envía tal cual y el turno termina acá: sale más rápido y más barato que
  // clasificar y redactar, y el cliente recibe el texto oficial en vez de
  // una versión que el modelo improvise.
  // Los interruptores del panel se leen junto con los escenarios: ambos
  // son configuración que el equipo cambia en vivo y el turno respeta.
  const [playbooks, enabledTools] = await Promise.all([
    fetchActivePlaybooks(supabase),
    fetchEnabledToolKeys(supabase),
  ]);
  const match = await matchPlaybook(history, playbooks);
  const matchTokens = tokensFromUsage(match.usage);

  if (match.playbook) {
    await runPlaybook(supabase, target, entrega, match.playbook, matchTokens, customerMessage);
    return;
  }

  let intent: Intent;
  let classifyTokens: TurnTokens;
  try {
    const classified = await classifyIntent(history);
    intent = classified.intent;
    classifyTokens = addTokens(matchTokens, tokensFromUsage(classified.usage));
  } catch (err) {
    // Clasificar es lo único que se reintenta ante rate limit, y si aun así
    // falla el turno termina acá SIN responder. No hay intención por defecto:
    // adivinarla mandaría un mensaje genérico a alguien que preguntó algo
    // concreto, que es peor que no contestar. El caso queda en la bitácora
    // con action "error" para que un humano lo retome.
    await logTurn(supabase, conversationId, {
      intent: null,
      action: "error",
      summary: `Fallo al clasificar intención: ${errorMessage(err)}`,
      tokens: matchTokens,
      customerMessage,
    });
    return;
  }

  await supabase.from("conversations").update({ intent }).eq("id", conversationId);

  // Fuera de tema: el turno termina acá. No se arma el tool loop —que es la
  // parte cara— y el texto sale de una constante, así que no cuesta salida.
  // A la segunda insistencia ni se responde: repetir la misma línea contra
  // alguien que insiste (o contra otro bot) es un ping-pong sin final.
  if (intent === "fuera_de_tema") {
    const repetido = alreadyRedirected(history);
    if (!repetido) {
      entrega.intentado = true;
      await sendAgentText(supabase, target, OFF_TOPIC_REPLY);
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
  const deps = { supabase, conversationId, contactId: target.contactId };

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
    const result = await agent.generate({ messages: history });
    text = result.text ?? "";
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
    if (!text.trim()) {
      // Sin asesores no se promete lo que no va a pasar: nadie va a
      // contestar en un minuto si no hay nadie trabajando.
      text = forced.unassigned
        ? "Ya dejé tu caso registrado para que lo revise un asesor. En cuanto haya alguien disponible te escriben por acá."
        : "Dame un momentico, ya te paso con un asesor para que te ayude con esto.";
    }
  }

  if (text.trim()) {
    entrega.intentado = true;
    await sendAgentText(supabase, target, text.trim());
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

  const [{ data: canRun }, { data: conversation }] = await Promise.all([
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
  ]);

  const convo = conversation as unknown as AgentConversation | null;
  if (!convo) return;

  // Guardrail duro: si algo dice que la IA no debe correr, no se llama al
  // modelo. No depende de que el prompt "se acuerde" de quedarse callado.
  if (!canRun || !convo.ai_enabled || convo.assigned_agent_id) return;

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
    throw new NonRetryableTurnError(conversationId, errorText(err), { cause: err });
  }

  // Lock por conversación: si dos webhooks casi simultáneos disparan el
  // turno para la misma conversación (típico cuando el cliente manda varios
  // mensajes seguidos), solo uno corre — el otro se salta en vez de generar
  // una respuesta duplicada o un doble escalamiento.
  await withConversationTurnLock(supabase, conversationId, async () => {
    const entrega = newTurnDelivery();
    try {
      await runTurnPhases(supabase, target, convo, entrega);
    } catch (err) {
      if (!entrega.intentado) throw err;

      // El mensaje ya salió (o pudo haber salido) y lo que falló es un paso
      // posterior: actualizar la conversación, escalar, escribir la bitácora.
      // Reintentar el turno lo reenviaría. Se registra y se abandona.
      log.error("turno_fallo_tras_envio", { conversationId, detail: errorText(err) });
      throw new NonRetryableTurnError(
        conversationId,
        `El turno falló después de intentar entregar un mensaje; no se reintenta para no duplicarlo: ${errorText(err)}`,
        { cause: err }
      );
    }
  });
}

// El disparo en lote vive ahora en src/lib/ai/queue.ts: el webhook encola y
// la cola procesa de a uno. Correr varios turnos en paralelo desde acá dejaba
// las respuestas sin registro si el proceso moría a mitad.
