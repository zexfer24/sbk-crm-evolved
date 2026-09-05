import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { sendTypingIndicator } from "@/lib/whatsapp/meta-client";

// ---------------------------------------------------------------------------
// "Escribiendo…" hacia el cliente, del lado del asesor humano (T3.1,
// 4/9/2026). `composer.tsx` la llama al primer carácter y la renueva cada
// 20 s mientras haya texto (Meta lo apaga solo a los 25 s o al llegar la
// respuesta, lo que pase primero). El lado de la IA no pasa por acá: llama a
// `sendTypingIndicator` directo desde `agent.ts`, que corre en el servidor y
// ya tiene todo lo que hace falta a mano.
//
// Mismo patrón de sesión que `.../close` y `.../read`: 401 sin agente, canal
// simulado o sin token = no-op con 200.
// ---------------------------------------------------------------------------

interface TypingConversation {
  channel: { phone_number_id: string | null; status: string };
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: conversationId } = await context.params;

  const supabase = await createClient();
  const agent = await fetchCurrentAgent(supabase);
  if (!agent) {
    return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  }

  const { data: conversationRow } = await supabase
    .from("conversations")
    .select("channel:whatsapp_channels(phone_number_id, status)")
    .eq("id", conversationId)
    .maybeSingle();
  const conversation = conversationRow as unknown as TypingConversation | null;

  const isRealChannel = conversation?.channel.status === "connected" && conversation.channel.phone_number_id;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (isRealChannel && accessToken) {
    const { data: lastInbound } = await supabase
      .from("messages")
      .select("whatsapp_message_id")
      .eq("conversation_id", conversationId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const wamid = lastInbound?.whatsapp_message_id as string | null | undefined;
    if (wamid) {
      await sendTypingIndicator(conversation.channel.phone_number_id!, accessToken, wamid);
    }
  }

  return NextResponse.json({ ok: true });
}
