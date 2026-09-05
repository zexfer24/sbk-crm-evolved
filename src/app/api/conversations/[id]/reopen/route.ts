import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchCurrentAgent } from "@/lib/data";
import { recordHandoff } from "@/lib/ai/handoffs";
import { log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Reabrir a mano una conversación cerrada (T2.1, 5/9/2026).
//
// Mismo patrón que close/route.ts (ver su cabecera): sesión con el cliente
// normal para el UPDATE y el evento, cliente admin solo para la única RPC que
// lo exige. Quien reabre queda como dueño humano —`toKind: "human"`, no
// `"ai"`—: reabrir es un acto de un asesor, así que es a ese asesor a quien
// se le asigna, sin esperar a que la IA decida si le contesta.
// ---------------------------------------------------------------------------
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: conversationId } = await context.params;

  const supabase = await createClient();
  const agent = await fetchCurrentAgent(supabase);
  if (!agent) {
    return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  }

  const { error: updateError } = await supabase
    .from("conversations")
    .update({ status: "open" })
    .eq("id", conversationId);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const { error: eventError } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "system",
    sender_agent_id: agent.id,
    message_type: "system_event",
    content: `${agent.displayName} reabrió la conversación`,
  });
  if (eventError) {
    log.error("reabrir_conversacion_evento_fallido", { conversationId, detalle: eventError.message });
  }

  await recordHandoff(createAdminClient(), {
    conversationId,
    toKind: "human",
    toId: agent.id,
    reason: "reabierta_por_asesor",
    createdBy: "user",
  });

  return NextResponse.json({ ok: true });
}
