import "server-only";
import { ToolLoopAgent, isStepCount, type LanguageModelUsage, type ModelMessage, type ToolSet } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendWhatsappText } from "@/lib/whatsapp/meta-client";
import { classifyIntent, type Intent } from "@/lib/ai/classify";
import { currentAgentModelLabel, getAgentModel } from "@/lib/ai/model";
import {
  AVAILABILITY_INSTRUCTIONS,
  COMPLAINT_INSTRUCTIONS,
  OTHER_INSTRUCTIONS,
  RETURN_INSTRUCTIONS,
} from "@/lib/ai/prompt";
import { buildCatalogTool, buildEscalateTool, buildOrderHistoryTool, type EscalationOutcome } from "@/lib/ai/tools";
import { escalateConversation } from "@/lib/ai/escalate";
import { withConversationTurnLock } from "@/lib/ai/conversation-lock";

// ---------------------------------------------------------------------------
// Orquestador del turno del agente: pipeline de dos fases (clasificar, luego
// actuar con herramientas acotadas a esa intención). Se dispara una vez por
// conversación desde el webhook de WhatsApp (ver runAgentTurnsFor).
// ---------------------------------------------------------------------------

const MAX_STEPS = 5;

interface ConversationRow {
  id: string;
  contact_id: string;
  ai_enabled: boolean;
  assigned_agent_id: string | null;
  contact: { phone_number: string };
  channel: { phone_number_id: string | null; status: string };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface TurnTokens {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function tokensFromUsage(usage: LanguageModelUsage): TurnTokens {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

function addTokens(a: TurnTokens, b: TurnTokens): TurnTokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

async function loadHistory(supabase: SupabaseClient<Database>, conversationId: string): Promise<ModelMessage[]> {
  const { data } = await supabase
    .from("messages")
    .select("sender_type, content, is_internal_note")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(30);

  const messages: ModelMessage[] = [];
  for (const row of data ?? []) {
    if (row.is_internal_note || row.sender_type === "system" || !row.content) continue;
    messages.push({ role: row.sender_type === "customer" ? "user" : "assistant", content: row.content });
  }
  return messages;
}

function instructionsFor(intent: Intent): string {
  switch (intent) {
    case "devolucion":
      return RETURN_INSTRUCTIONS;
    case "queja":
      return COMPLAINT_INSTRUCTIONS;
    case "otro":
      return OTHER_INSTRUCTIONS;
    default:
      return AVAILABILITY_INSTRUCTIONS;
  }
}

async function sendAgentReply(supabase: SupabaseClient<Database>, conversation: ConversationRow, text: string) {
  const isRealChannel = conversation.channel.status === "connected" && Boolean(conversation.channel.phone_number_id);
  let whatsappMessageId: string | null = null;
  let whatsappStatus: "sent" | null = null;

  if (isRealChannel) {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (accessToken) {
      try {
        const result = await sendWhatsappText(
          conversation.channel.phone_number_id!,
          accessToken,
          conversation.contact.phone_number,
          text
        );
        whatsappMessageId = result.whatsappMessageId;
        whatsappStatus = "sent";
      } catch (err) {
        console.error("No se pudo enviar la respuesta de la IA por WhatsApp:", err);
      }
    } else {
      console.warn(`Respuesta de la IA no enviada por WhatsApp en ${conversation.id}: falta WHATSAPP_ACCESS_TOKEN.`);
    }
  }

  await supabase.from("messages").insert({
    conversation_id: conversation.id,
    direction: "outbound",
    sender_type: "ai",
    message_type: "text",
    content: text,
    whatsapp_message_id: whatsappMessageId,
    whatsapp_status: whatsappStatus,
  });
}

async function logTurn(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  intent: Intent | null,
  action: "answered" | "escalated" | "error",
  summary: string,
  tokens: TurnTokens | null
) {
  await supabase.from("agent_turns").insert({
    conversation_id: conversationId,
    intent,
    action,
    summary: summary.slice(0, 500),
    model: currentAgentModelLabel(),
    input_tokens: tokens?.inputTokens ?? null,
    output_tokens: tokens?.outputTokens ?? null,
    total_tokens: tokens?.totalTokens ?? null,
  });
}

/** Corre el turno del agente para UNA conversación. No lanza: cualquier fallo queda registrado en agent_turns. */
export async function runAgentTurn(conversationId: string): Promise<void> {
  const supabase = createAdminClient();

  const [{ data: settings }, { data: conversation }] = await Promise.all([
    supabase.from("agent_settings").select("ai_globally_enabled").eq("id", true).maybeSingle(),
    supabase
      .from("conversations")
      .select(
        "id, contact_id, ai_enabled, assigned_agent_id, contact:contacts(phone_number), channel:whatsapp_channels(phone_number_id, status)"
      )
      .eq("id", conversationId)
      .maybeSingle(),
  ]);

  const convo = conversation as unknown as ConversationRow | null;
  if (!convo) return;

  // Guardrail duro: si algo dice que la IA no debe correr, no se llama al
  // modelo. No depende de que el prompt "se acuerde" de quedarse callado.
  if (!settings?.ai_globally_enabled || !convo.ai_enabled || convo.assigned_agent_id) return;

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

    let intent: Intent;
    let classifyTokens: TurnTokens;
    try {
      const classified = await classifyIntent(history);
      intent = classified.intent;
      classifyTokens = tokensFromUsage(classified.usage);
    } catch (err) {
      await logTurn(supabase, conversationId, null, "error", `Fallo al clasificar intención: ${errorMessage(err)}`, null);
      return;
    }

    await supabase.from("conversations").update({ intent }).eq("id", conversationId);

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
      instructions: instructionsFor(intent),
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
      await logTurn(supabase, conversationId, intent, "error", errorMessage(err), classifyTokens);
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
      outcome.assignedAgentName = forced.assignedAgentName;
      if (!text.trim()) {
        text = "Dame un momentico, ya te paso con un asesor para que te ayude con esto.";
      }
    }

    if (text.trim()) {
      await sendAgentReply(supabase, convo, text.trim());
    }

    if (!outcome.escalated) {
      await supabase.from("conversations").update({ journey_stage: null, active_tool: null }).eq("id", conversationId);
    }

    await logTurn(
      supabase,
      conversationId,
      intent,
      outcome.escalated ? "escalated" : "answered",
      outcome.escalated ? `Escalado a ${outcome.assignedAgentName ?? "(sin asesor disponible)"}. Motivo: ${outcome.motivo}.` : text,
      turnTokens
    );
  });
}

/** Corre el turno para varias conversaciones a la vez (una tanda del webhook puede tocar varias). */
export async function runAgentTurnsFor(conversationIds: Iterable<string>): Promise<void> {
  await Promise.all([...new Set(conversationIds)].map((id) => runAgentTurn(id)));
}
