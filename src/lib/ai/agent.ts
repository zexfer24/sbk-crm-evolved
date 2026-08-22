import "server-only";
import { ToolLoopAgent, isStepCount, type LanguageModelUsage, type ModelMessage, type ToolSet } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Playbook } from "@/lib/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { classifyIntent, type Intent } from "@/lib/ai/classify";
import { currentAgentModelLabel, getAgentModel } from "@/lib/ai/model";
import { OFF_TOPIC_REPLY, buildInstructions } from "@/lib/ai/prompt";
import { buildCatalogTool, buildEscalateTool, buildOrderHistoryTool, type EscalationOutcome } from "@/lib/ai/tools";
import { escalateConversation } from "@/lib/ai/escalate";
import { withConversationTurnLock } from "@/lib/ai/conversation-lock";
import { fetchActivePlaybooks, matchPlaybook } from "@/lib/ai/playbooks";
import { sendAgentText, sendPlaybookReply, type AgentConversation } from "@/lib/ai/send";

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
 * Ejecuta una respuesta predeterminada. No llama al modelo en ningún punto:
 * el texto sale tal cual está guardado. El modelo eligió CUÁL responder;
 * nunca CÓMO se redacta.
 */
async function runPlaybook(
  supabase: SupabaseClient<Database>,
  conversation: AgentConversation,
  playbook: Playbook,
  tokens: TurnTokens,
  customerMessage: string | null
): Promise<void> {
  await sendPlaybookReply(supabase, conversation, playbook);

  if (playbook.afterSend === "escalate") {
    const result = await escalateConversation(supabase, {
      conversationId: conversation.id,
      contactId: conversation.contact_id,
      motivo: "seguimiento",
      resumen: `Respuesta automática "${playbook.name}". Falta que un asesor continúe el caso.`,
    });

    await logTurn(supabase, conversation.id, {
      intent: null,
      action: "escalated",
      summary: `Escenario "${playbook.name}" → ${result.assignedAgentName ?? "(sin asesor disponible)"}.`,
      tokens,
      playbookId: playbook.id,
      customerMessage,
    });
    return;
  }

  await supabase
    .from("conversations")
    .update({ journey_stage: null, active_tool: null })
    .eq("id", conversation.id);

  await logTurn(supabase, conversation.id, {
    intent: null,
    action: "answered",
    summary: `Escenario "${playbook.name}".`,
    tokens,
    playbookId: playbook.id,
    customerMessage,
  });
}

/** Corre el turno del agente para UNA conversación. No lanza: cualquier fallo queda registrado en agent_turns. */
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
        "id, contact_id, ai_enabled, assigned_agent_id, welcome_sent_at, contact:contacts(phone_number), channel:whatsapp_channels(phone_number_id, status)"
      )
      .eq("id", conversationId)
      .maybeSingle(),
  ]);

  const convo = conversation as unknown as AgentConversation | null;
  if (!convo) return;

  // Guardrail duro: si algo dice que la IA no debe correr, no se llama al
  // modelo. No depende de que el prompt "se acuerde" de quedarse callado.
  if (!canRun || !convo.ai_enabled || convo.assigned_agent_id) return;

  // Lock por conversación: si dos webhooks casi simultáneos disparan el
  // turno para la misma conversación (típico cuando el cliente manda varios
  // mensajes seguidos), solo uno corre — el otro se salta en vez de generar
  // una respuesta duplicada o un doble escalamiento.
  await withConversationTurnLock(supabase, conversationId, async () => {
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
    const playbooks = await fetchActivePlaybooks(supabase);
    const match = await matchPlaybook(history, playbooks);
    const matchTokens = tokensFromUsage(match.usage);

    if (match.playbook) {
      await runPlaybook(supabase, convo, match.playbook, matchTokens, customerMessage);
      return;
    }

    let intent: Intent;
    let classifyTokens: TurnTokens;
    try {
      const classified = await classifyIntent(history);
      intent = classified.intent;
      classifyTokens = addTokens(matchTokens, tokensFromUsage(classified.usage));
    } catch (err) {
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
      if (!repetido) await sendAgentText(supabase, convo, OFF_TOPIC_REPLY);

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
    const deps = { supabase, conversationId, contactId: convo.contact_id };

    const tools: ToolSet =
      intent === "devolucion"
        ? { buscarHistorialCompras: buildOrderHistoryTool(deps), escalarAAsesor: buildEscalateTool(deps, outcome) }
        : intent === "queja"
          ? { escalarAAsesor: buildEscalateTool(deps, outcome) }
          : { buscarRepuesto: buildCatalogTool(deps), escalarAAsesor: buildEscalateTool(deps, outcome) };

    const { model, providerOptions } = getAgentModel("medium");

    const agent = new ToolLoopAgent({
      model,
      instructions: buildInstructions({ intent, needsGreeting: needsGreeting(convo.welcome_sent_at, history) }),
      tools,
      stopWhen: isStepCount(MAX_STEPS),
      providerOptions,
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
        contactId: convo.contact_id,
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
      await sendAgentText(supabase, convo, text.trim());
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
  });
}

// El disparo en lote vive ahora en src/lib/ai/queue.ts: el webhook encola y
// la cola procesa de a uno. Correr varios turnos en paralelo desde acá dejaba
// las respuestas sin registro si el proceso moría a mitad.
