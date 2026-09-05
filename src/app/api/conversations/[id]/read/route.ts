import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { markWhatsappRead } from "@/lib/whatsapp/meta-client";

// ---------------------------------------------------------------------------
// Doble check azul hacia el cliente (T3.1, 4/9/2026).
//
// `markConversationRead` (mutations.ts) ya existía y sigue igual: es lo que
// apaga la píldora "No leídas" DENTRO del CRM. Esta ruta es un efecto aparte
// —avisarle a Meta que el asesor de verdad leyó el chat, para que a el
// cliente le aparezcan sus dos palomitas azules— y por eso `crm-shell.tsx` la
// llama JUNTO a `markConversationRead`, no en su lugar.
//
// Mismo patrón que `api/conversations/[id]/close`: sesión con el cliente
// normal, 401 sin ella. No hay RPC ni `service_role` de por medio acá —solo
// una lectura y, si el canal es real, una llamada a Meta que nunca lanza (ver
// meta-client.ts)—, así que no hace falta un cliente admin.
// ---------------------------------------------------------------------------

interface ReadConversation {
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
  const conversation = conversationRow as unknown as ReadConversation | null;

  const isRealChannel = conversation?.channel.status === "connected" && conversation.channel.phone_number_id;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  // Canal simulado, o falta la variable del token: no hay a quién avisarle.
  // Responde 200 igual — el chat de demo no tiene por qué fallar por esto.
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
    // Sin wamid no hay a qué mensaje apuntar el check: puede pasar en un chat
    // que solo tiene mensajes salientes (la IA saludó primero, por ejemplo).
    if (wamid) {
      await markWhatsappRead(conversation.channel.phone_number_id!, accessToken, wamid);
    }
  }

  return NextResponse.json({ ok: true });
}
