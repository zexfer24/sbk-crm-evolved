import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { isWithin24hWindow } from "@/lib/whatsapp-window";
import {
  MetaApiError,
  downloadMetaMedia,
  getMetaMediaUrl,
  sendWhatsappTemplate,
} from "@/lib/whatsapp/meta-client";

// ---------------------------------------------------------------------------
// GET: handshake de verificación que exige Meta al registrar el webhook.
// https://developers.facebook.com/docs/graph-api/webhooks/getting-started
// ---------------------------------------------------------------------------
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "Verificación fallida." }, { status: 403 });
}

// ---------------------------------------------------------------------------
// Formas mínimas del payload de webhook de la WhatsApp Cloud API que usamos.
// ---------------------------------------------------------------------------
interface WebhookMediaObject {
  id: string;
  mime_type?: string;
  caption?: string;
}

interface WebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WebhookMediaObject;
  video?: WebhookMediaObject;
  audio?: WebhookMediaObject;
  document?: WebhookMediaObject;
  context?: { id: string };
}

interface WebhookStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
}

interface WebhookChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id: string }[];
  messages?: WebhookMessage[];
  statuses?: WebhookStatus[];
}

interface WebhookBody {
  entry?: { changes?: { field: string; value: WebhookChangeValue }[] }[];
}

const MEDIA_TYPES = ["image", "video", "audio", "document"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/amr": "amr",
  "application/pdf": "pdf",
};

// ---------------------------------------------------------------------------
// Bienvenida automática
//
// Meta cierra la ventana de conversación 24 h después del último mensaje del
// cliente. Cada vez que alguien escribe con la ventana cerrada —incluida la
// primera vez— se le manda la plantilla de bienvenida y se sella la fecha.
//
// La plantilla se configura con WHATSAPP_WELCOME_TEMPLATE. Sin esa variable
// no se envía nada: el CRM nunca inventa el texto que le llega a un cliente.
// ---------------------------------------------------------------------------
interface WelcomeChannel {
  id: string;
  phone_number_id: string | null;
  status: string;
}

async function sendWelcome(
  supabase: SupabaseClient,
  channel: WelcomeChannel,
  conversationId: string,
  toPhoneNumber: string,
  accessToken: string | undefined
): Promise<void> {
  const templateName = process.env.WHATSAPP_WELCOME_TEMPLATE;
  if (!templateName) return;

  if (channel.status !== "connected" || !channel.phone_number_id || !accessToken) {
    console.warn(
      `Bienvenida no enviada en la conversación ${conversationId}: el canal no está conectado o falta WHATSAPP_ACCESS_TOKEN.`
    );
    return;
  }

  const language = process.env.WHATSAPP_WELCOME_TEMPLATE_LANG ?? "es";

  try {
    const { whatsappMessageId } = await sendWhatsappTemplate(
      channel.phone_number_id,
      accessToken,
      toPhoneNumber,
      templateName,
      language
    );

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      direction: "outbound",
      sender_type: "ai",
      message_type: "template",
      template_name: templateName,
      whatsapp_message_id: whatsappMessageId,
      whatsapp_status: "sent",
    });

    await supabase
      .from("conversations")
      .update({ welcome_sent_at: new Date().toISOString() })
      .eq("id", conversationId);
  } catch (err) {
    const detail = err instanceof MetaApiError ? err.message : String(err);
    console.error(`Bienvenida no enviada en la conversación ${conversationId}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// POST: eventos entrantes — mensajes nuevos de clientes y actualizaciones de
// estado (sent/delivered/read/failed) de mensajes que nosotros enviamos.
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  const body = (await request.json()) as WebhookBody;
  const supabase = createAdminClient();
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const greeted = new Set<string>();

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;

      for (const status of value.statuses ?? []) {
        await supabase
          .from("messages")
          .update({ whatsapp_status: status.status })
          .eq("whatsapp_message_id", status.id);
      }

      if (!value.messages?.length) continue;

      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const { data: channel } = await supabase
        .from("whatsapp_channels")
        .select("id, phone_number_id, status")
        .eq("phone_number_id", phoneNumberId)
        .maybeSingle<WelcomeChannel>();

      if (!channel) {
        console.warn(`Webhook de WhatsApp: no hay canal registrado para phone_number_id=${phoneNumberId}`);
        continue;
      }

      for (const message of value.messages) {
        const profileName = value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name ?? null;
        const phoneNumber = `+${message.from}`;

        const { data: contact, error: contactError } = await supabase
          .from("contacts")
          .upsert(
            { phone_number: phoneNumber, profile_name: profileName, display_name: profileName },
            { onConflict: "phone_number", ignoreDuplicates: false }
          )
          .select("id")
          .single();

        if (contactError || !contact) {
          console.error("Webhook de WhatsApp: error al upsertar contacto", contactError);
          continue;
        }

        let conversationId: string;
        // La ventana se mide con el estado previo al insert: el trigger de
        // `messages` mueve last_customer_message_at en cuanto guardamos.
        let windowWasClosed: boolean;

        const { data: existingConversation } = await supabase
          .from("conversations")
          .select("id, last_customer_message_at")
          .eq("contact_id", contact.id)
          .eq("whatsapp_channel_id", channel.id)
          .maybeSingle<{ id: string; last_customer_message_at: string | null }>();

        if (existingConversation) {
          conversationId = existingConversation.id;
          windowWasClosed = !isWithin24hWindow(existingConversation.last_customer_message_at);
        } else {
          windowWasClosed = true;
          const { data: newConversation, error: conversationError } = await supabase
            .from("conversations")
            .insert({ contact_id: contact.id, whatsapp_channel_id: channel.id })
            .select("id")
            .single();

          if (conversationError || !newConversation) {
            console.error("Webhook de WhatsApp: error al crear conversación", conversationError);
            continue;
          }
          conversationId = newConversation.id;
        }

        // Si el cliente citó uno de nuestros mensajes desde su WhatsApp,
        // reflejamos esa cita dentro del CRM.
        let replyToMessageId: string | null = null;
        if (message.context?.id) {
          const { data: repliedTo } = await supabase
            .from("messages")
            .select("id")
            .eq("whatsapp_message_id", message.context.id)
            .maybeSingle();
          replyToMessageId = repliedTo?.id ?? null;
        }

        let messageType: string = "text";
        let content: string | null = null;
        let mediaUrl: string | null = null;

        if (message.type === "text") {
          content = message.text?.body ?? "";
        } else if ((MEDIA_TYPES as readonly string[]).includes(message.type)) {
          messageType = message.type;
          const mediaObject = message[message.type as MediaType];
          content = mediaObject?.caption ?? null;

          if (mediaObject?.id && accessToken) {
            try {
              const { url, mimeType } = await getMetaMediaUrl(mediaObject.id, accessToken);
              const bytes = await downloadMetaMedia(url, accessToken);
              const extension = EXTENSION_BY_MIME[mimeType] ?? "bin";
              const path = `${conversationId}/${message.id}.${extension}`;

              const { error: uploadError } = await supabase.storage
                .from("whatsapp-media")
                .upload(path, bytes, { contentType: mimeType, upsert: true });

              if (!uploadError) {
                const { data: publicUrl } = supabase.storage.from("whatsapp-media").getPublicUrl(path);
                mediaUrl = publicUrl.publicUrl;
              } else {
                console.error("Webhook de WhatsApp: error al subir media a Storage", uploadError);
              }
            } catch (err) {
              console.error("Webhook de WhatsApp: error al descargar media de Meta", err);
            }
          }
        } else {
          content = `[${message.type}] Tipo de mensaje no soportado todavía.`;
        }

        await supabase.from("messages").insert({
          conversation_id: conversationId,
          direction: "inbound",
          sender_type: "customer",
          message_type: messageType,
          content,
          media_url: mediaUrl,
          reply_to_message_id: replyToMessageId,
          whatsapp_message_id: message.id,
          created_at: new Date(Number(message.timestamp) * 1000).toISOString(),
        });

        // Una sola bienvenida por conversación aunque el cliente mande varios
        // mensajes seguidos y lleguen en el mismo lote del webhook.
        if (windowWasClosed && !greeted.has(conversationId)) {
          greeted.add(conversationId);
          await sendWelcome(supabase, channel, conversationId, phoneNumber, accessToken);
        }
      }
    }
  }

  return NextResponse.json({ ok: true });
}
