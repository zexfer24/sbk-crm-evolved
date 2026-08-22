import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchConversation, fetchCurrentAgent } from "@/lib/data";
import type { MessageType } from "@/lib/types";
import { signedUrlForSending } from "@/lib/media-link";
import {
  MetaApiError,
  sendWhatsappMedia,
  sendWhatsappTemplate,
  sendWhatsappText,
} from "@/lib/whatsapp/meta-client";

interface SendMessageBody {
  conversationId: string;
  kind: "text" | "template" | "media";
  content?: string;
  isInternalNote?: boolean;
  templateName?: string;
  templateLanguage?: string;
  replyToMessageId?: string | null;
  mediaUrl?: string;
  mediaType?: MessageType;
}

export async function POST(request: Request) {
  const body = (await request.json()) as SendMessageBody;
  const { conversationId, kind, content, isInternalNote, templateName, templateLanguage, mediaUrl } =
    body;
  const mediaType = body.mediaType as "image" | "video" | "audio" | "document" | undefined;
  const replyToMessageId = body.replyToMessageId ?? null;

  if (!conversationId || (kind === "text" && !content) || (kind === "media" && !mediaUrl)) {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  }

  const supabase = await createClient();
  const agent = await fetchCurrentAgent(supabase);
  if (!agent) {
    return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  }

  const conversation = await fetchConversation(supabase, conversationId);
  if (!conversation) {
    return NextResponse.json({ error: "Conversación no encontrada." }, { status: 404 });
  }

  // Nota interna: nunca sale por WhatsApp, solo queda registrada en el CRM.
  if (isInternalNote) {
    const { error } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      direction: "outbound",
      sender_type: "agent",
      sender_agent_id: agent.id,
      message_type: "text",
      content: content ?? "",
      is_internal_note: true,
      reply_to_message_id: replyToMessageId,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // Si estamos citando un mensaje que sí llegó/salió por WhatsApp de verdad,
  // resolvemos su wamid para mandar la cita como reply nativo en Meta.
  let replyToWamid: string | null = null;
  if (replyToMessageId) {
    const { data: repliedMessage } = await supabase
      .from("messages")
      .select("whatsapp_message_id")
      .eq("id", replyToMessageId)
      .maybeSingle();
    replyToWamid = repliedMessage?.whatsapp_message_id ?? null;
  }

  const isRealChannel = conversation.channel.status === "connected" && conversation.channel.phoneNumberId;
  let whatsappMessageId: string | null = null;
  let whatsappStatus: "sent" | null = null;

  if (isRealChannel) {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!accessToken) {
      return NextResponse.json(
        { error: "El canal está marcado como conectado pero falta WHATSAPP_ACCESS_TOKEN en el servidor." },
        { status: 500 }
      );
    }

    try {
      let result;
      if (kind === "template") {
        result = await sendWhatsappTemplate(
          conversation.channel.phoneNumberId!,
          accessToken,
          conversation.contact.phoneNumber,
          templateName!,
          templateLanguage ?? "es"
        );
      } else if (kind === "media") {
        // El bucket es privado: Meta necesita un enlace firmado, no la ruta
        // del CRM, que le pediría una sesión que no tiene.
        const link = await signedUrlForSending(mediaUrl!);
        if (!link) {
          return NextResponse.json(
            { error: "No se pudo preparar el archivo para enviarlo por WhatsApp." },
            { status: 500 }
          );
        }

        result = await sendWhatsappMedia(
          conversation.channel.phoneNumberId!,
          accessToken,
          conversation.contact.phoneNumber,
          mediaType as "image" | "video" | "audio" | "document",
          link,
          content,
          replyToWamid
        );
      } else {
        result = await sendWhatsappText(
          conversation.channel.phoneNumberId!,
          accessToken,
          conversation.contact.phoneNumber,
          content!,
          replyToWamid
        );
      }
      whatsappMessageId = result.whatsappMessageId;
      whatsappStatus = "sent";
    } catch (err) {
      const message =
        err instanceof MetaApiError ? err.message : "No se pudo enviar el mensaje por WhatsApp.";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  const { error } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "agent",
    sender_agent_id: agent.id,
    message_type: kind === "template" ? "template" : kind === "media" ? mediaType : "text",
    content: content ?? null,
    template_name: kind === "template" ? templateName : null,
    media_url: kind === "media" ? mediaUrl : null,
    whatsapp_message_id: whatsappMessageId,
    whatsapp_status: whatsappStatus,
    reply_to_message_id: replyToMessageId,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
