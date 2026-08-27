import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Playbook } from "@/lib/types";
import type { TurnTarget } from "@/lib/ai/turn-target";
import { metaErrorCode, sendWhatsappMedia, sendWhatsappText } from "@/lib/whatsapp/meta-client";
import { signedUrlForSending } from "@/lib/media-link";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Envío de las respuestas del agente. Vive aparte del orquestador porque el
// turno tiene dos formas de responder: el texto que redacta el modelo, y el
// texto ya escrito de un escenario (que puede llevar adjunto).
//
// Todo lo de acá recibe un TurnTarget, no una conversación suelta: el chat, el
// cliente y el número viajan juntos en un objeto congelado que se verificó al
// abrir el turno (ver turn-target.ts). Es lo que hace imposible por
// construcción combinar el texto de un turno con el destinatario de otro.
//
// En un canal simulado (demo, o sin access token) el mensaje igual se guarda
// en `messages` aunque no salga por WhatsApp: es lo que hace utilizable el
// simulador del panel de control.
// ---------------------------------------------------------------------------

export type { AgentConversation, TurnTarget } from "@/lib/ai/turn-target";

type MediaKind = "image" | "video" | "document";

function accessTokenFor(target: TurnTarget): string | null {
  const isRealChannel = target.channelStatus === "connected" && Boolean(target.phoneNumberId);
  if (!isRealChannel) return null;

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) {
    console.warn(`Respuesta de la IA no enviada por WhatsApp en ${target.conversationId}: falta WHATSAPP_ACCESS_TOKEN.`);
    return null;
  }
  return accessToken;
}

/**
 * Resultado de intentar entregar algo por WhatsApp, listo para guardar.
 *
 * El fallo se guardaba como `whatsapp_status: null`, que es el mismo valor con
 * el que nace un mensaje que va en camino: en la burbuja quedaba un relojito
 * para siempre. Un mensaje que Meta rechazó tiene que verse rechazado, y con
 * el motivo — que es lo que decide si reintentar sirve de algo.
 */
interface DeliveryOutcome {
  whatsapp_message_id: string | null;
  whatsapp_status: "sent" | "failed" | null;
  whatsapp_error_code: number | null;
  whatsapp_error_detail: string | null;
}

/** Canal simulado: no se intentó nada, así que no hay ni éxito ni fallo que contar. */
const NO_ENVIADO: DeliveryOutcome = {
  whatsapp_message_id: null,
  whatsapp_status: null,
  whatsapp_error_code: null,
  whatsapp_error_detail: null,
};

async function entregar(
  target: TurnTarget,
  enviar: (accessToken: string) => Promise<{ whatsappMessageId: string }>
): Promise<DeliveryOutcome> {
  const accessToken = accessTokenFor(target);
  if (!accessToken) return NO_ENVIADO;

  try {
    const { whatsappMessageId } = await enviar(accessToken);
    return {
      whatsapp_message_id: whatsappMessageId,
      whatsapp_status: "sent",
      whatsapp_error_code: null,
      whatsapp_error_detail: null,
    };
  } catch (err) {
    log.error("ia_envio_fallido", {
      conversationId: target.conversationId,
      codigo: metaErrorCode(err),
      detalle: errorText(err),
    });
    return {
      whatsapp_message_id: null,
      whatsapp_status: "failed",
      whatsapp_error_code: metaErrorCode(err),
      whatsapp_error_detail: errorText(err),
    };
  }
}

export async function sendAgentText(
  supabase: SupabaseClient<Database>,
  target: TurnTarget,
  text: string
): Promise<void> {
  const entrega = await entregar(target, (accessToken) =>
    sendWhatsappText(target.phoneNumberId!, accessToken, target.phoneNumber, text)
  );

  await supabase.from("messages").insert({
    conversation_id: target.conversationId,
    direction: "outbound",
    sender_type: "ai",
    message_type: "text",
    content: text,
    ...entrega,
  });
}

async function sendAgentMedia(
  supabase: SupabaseClient<Database>,
  target: TurnTarget,
  mediaType: MediaKind,
  url: string
): Promise<void> {
  // Lo más probable acá es que Meta no haya podido descargar el archivo desde
  // la URL configurada. El texto ya salió, así que el cliente no se queda sin
  // respuesta — pero el adjunto que no llegó tiene que verse como no llegado.
  const entrega = await entregar(target, async (accessToken) => {
    // El bucket es privado: Meta necesita un enlace firmado. Si el adjunto
    // apunta a una URL de fuera, se manda tal cual.
    const link = await signedUrlForSending(url);
    if (!link) throw new Error(`No se pudo preparar el adjunto ${url} para enviarlo.`);

    return sendWhatsappMedia(target.phoneNumberId!, accessToken, target.phoneNumber, mediaType, link);
  });

  await supabase.from("messages").insert({
    conversation_id: target.conversationId,
    direction: "outbound",
    sender_type: "ai",
    message_type: mediaType,
    media_url: url,
    ...entrega,
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
  target: TurnTarget,
  playbook: Playbook
): Promise<void> {
  const { attachmentUrl, attachmentType } = playbook;

  const text =
    attachmentType === "link" && attachmentUrl
      ? `${playbook.responseText}\n\n${attachmentUrl}`
      : playbook.responseText;

  await sendAgentText(supabase, target, text);

  if (attachmentUrl && attachmentType && attachmentType !== "link") {
    await sendAgentMedia(supabase, target, attachmentType, attachmentUrl);
  }
}
