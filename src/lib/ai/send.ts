import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Playbook } from "@/lib/types";
import { sendWhatsappMedia, sendWhatsappText } from "@/lib/whatsapp/meta-client";
import { signedUrlForSending } from "@/lib/media-link";

// ---------------------------------------------------------------------------
// Envío de las respuestas del agente. Vive aparte del orquestador porque el
// turno tiene dos formas de responder: el texto que redacta el modelo, y el
// texto ya escrito de un escenario (que puede llevar adjunto).
//
// En un canal simulado (demo, o sin access token) el mensaje igual se guarda
// en `messages` aunque no salga por WhatsApp: es lo que hace utilizable el
// simulador del panel de control.
// ---------------------------------------------------------------------------

export interface AgentConversation {
  id: string;
  contact_id: string;
  ai_enabled: boolean;
  assigned_agent_id: string | null;
  /** null cuando nunca salió la plantilla de bienvenida: es lo que decide si el agente saluda. */
  welcome_sent_at: string | null;
  contact: { phone_number: string };
  channel: { phone_number_id: string | null; status: string };
}

type MediaKind = "image" | "video" | "document";

function accessTokenFor(conversation: AgentConversation): string | null {
  const isRealChannel = conversation.channel.status === "connected" && Boolean(conversation.channel.phone_number_id);
  if (!isRealChannel) return null;

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) {
    console.warn(`Respuesta de la IA no enviada por WhatsApp en ${conversation.id}: falta WHATSAPP_ACCESS_TOKEN.`);
    return null;
  }
  return accessToken;
}

export async function sendAgentText(
  supabase: SupabaseClient<Database>,
  conversation: AgentConversation,
  text: string
): Promise<void> {
  const accessToken = accessTokenFor(conversation);
  let whatsappMessageId: string | null = null;
  let whatsappStatus: "sent" | null = null;

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

async function sendAgentMedia(
  supabase: SupabaseClient<Database>,
  conversation: AgentConversation,
  mediaType: MediaKind,
  url: string
): Promise<void> {
  const accessToken = accessTokenFor(conversation);
  let whatsappMessageId: string | null = null;
  let whatsappStatus: "sent" | null = null;

  if (accessToken) {
    try {
      // El bucket es privado: Meta necesita un enlace firmado. Si el adjunto
      // apunta a una URL de fuera, se manda tal cual.
      const link = await signedUrlForSending(url);
      if (!link) throw new Error(`No se pudo preparar el adjunto ${url} para enviarlo.`);

      const result = await sendWhatsappMedia(
        conversation.channel.phone_number_id!,
        accessToken,
        conversation.contact.phone_number,
        mediaType,
        link
      );
      whatsappMessageId = result.whatsappMessageId;
      whatsappStatus = "sent";
    } catch (err) {
      // Lo más probable acá es que Meta no haya podido descargar el archivo
      // desde la URL configurada. El texto ya salió, así que el cliente no
      // se queda sin respuesta.
      console.error("No se pudo enviar el adjunto de la IA por WhatsApp:", err);
    }
  }

  await supabase.from("messages").insert({
    conversation_id: conversation.id,
    direction: "outbound",
    sender_type: "ai",
    message_type: mediaType,
    media_url: url,
    whatsapp_message_id: whatsappMessageId,
    whatsapp_status: whatsappStatus,
  });
}

/**
 * Envía la respuesta de un escenario: el texto **tal cual está guardado**,
 * y el adjunto si lo tiene.
 *
 * Un adjunto `link` se anexa al texto en vez de mandarse como archivo:
 * Meta solo puede adjuntar URLs que apunte directo a un archivo público, y
 * los catálogos suelen ser páginas web o carpetas compartidas.
 */
export async function sendPlaybookReply(
  supabase: SupabaseClient<Database>,
  conversation: AgentConversation,
  playbook: Playbook
): Promise<void> {
  const { attachmentUrl, attachmentType } = playbook;

  const text =
    attachmentType === "link" && attachmentUrl
      ? `${playbook.responseText}\n\n${attachmentUrl}`
      : playbook.responseText;

  await sendAgentText(supabase, conversation, text);

  if (attachmentUrl && attachmentType && attachmentType !== "link") {
    await sendAgentMedia(supabase, conversation, attachmentType, attachmentUrl);
  }
}
