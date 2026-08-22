import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { isWithin24hWindow } from "@/lib/whatsapp-window";
import {
  MetaApiError,
  downloadMetaMedia,
  getMetaMediaUrl,
  sendWhatsappTemplate,
} from "@/lib/whatsapp/meta-client";
import { runAgentTurnsFor } from "@/lib/ai/agent";

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
  sticker?: WebhookMediaObject;
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

const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"] as const;
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
/**
 * Verifica `X-Hub-Signature-256` contra WHATSAPP_APP_SECRET. Sin ese
 * secreto configurado (ej. en desarrollo local, donde Meta nunca llega a
 * llamar este endpoint) se deja pasar sin validar, con un aviso — pero una
 * vez configurado, cualquier request sin firma válida se rechaza: cualquiera
 * que descubra la URL del webhook podría inyectar mensajes falsos.
 */
function hasValidMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (appSecret) {
    const signature = request.headers.get("x-hub-signature-256");
    if (!hasValidMetaSignature(rawBody, signature, appSecret)) {
      console.error("Webhook de WhatsApp: firma inválida o ausente, se rechaza el request.");
      return NextResponse.json({ error: "Firma inválida." }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // Sin secreto no hay forma de distinguir un evento de Meta de uno que
    // mandó cualquiera que conozca la URL. En producción eso no puede
    // quedar abierto porque alguien olvidó definir una variable: se
    // rechaza y queda registrado, en vez de procesar mensajes inventados
    // que le harían responder a la IA y consumir cuota del modelo.
    console.error(
      "Webhook de WhatsApp: WHATSAPP_APP_SECRET no configurado en producción — se rechaza el request sin procesarlo."
    );
    return NextResponse.json({ error: "Webhook mal configurado." }, { status: 503 });
  } else {
    console.warn(
      "Webhook de WhatsApp: WHATSAPP_APP_SECRET no configurado — no se valida la firma de Meta. Configúralo antes de producción."
    );
  }

  const body = JSON.parse(rawBody) as WebhookBody;
  const supabase = createAdminClient();
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const greeted = new Set<string>();
  const touchedByCustomer = new Set<string>();
  const mediaDownloadTasks: (() => Promise<void>)[] = [];

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

          if (conversationError?.code === "23505") {
            // Otra invocación concurrente de este mismo webhook (dos mensajes
            // del mismo contacto nuevo llegando casi al mismo tiempo) ganó la
            // carrera y ya creó la conversación -- se relee en vez de
            // descartar este mensaje.
            const { data: wonByOther } = await supabase
              .from("conversations")
              .select("id")
              .eq("contact_id", contact.id)
              .eq("whatsapp_channel_id", channel.id)
              .maybeSingle<{ id: string }>();

            if (!wonByOther) {
              console.error(
                "Webhook de WhatsApp: colisión al crear conversación pero no se encontró ninguna al releer",
                conversationError
              );
              continue;
            }
            conversationId = wonByOther.id;
          } else if (conversationError || !newConversation) {
            console.error("Webhook de WhatsApp: error al crear conversación", conversationError);
            continue;
          } else {
            conversationId = newConversation.id;
          }
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
        let pendingMediaId: string | null = null;

        if (message.type === "text") {
          content = message.text?.body ?? "";
        } else if ((MEDIA_TYPES as readonly string[]).includes(message.type)) {
          messageType = message.type;
          const mediaObject = message[message.type as MediaType];
          content = mediaObject?.caption ?? null;
          pendingMediaId = mediaObject?.id ?? null;
        } else {
          content = `[${message.type}] Tipo de mensaje no soportado todavía.`;
        }

        // media_url arranca en null incluso para mensajes multimedia: la
        // descarga desde Meta se hace en mediaDownloadTasks, después de
        // responder al webhook (ver el after() al final), para no arriesgar
        // el timeout de Meta (~20s) con un archivo pesado. La UI ya avisa
        // explícito si un mensaje multimedia se queda sin media_url.
        const { data: insertedMessage, error: insertError } = await supabase
          .from("messages")
          .insert({
            conversation_id: conversationId,
            direction: "inbound",
            sender_type: "customer",
            message_type: messageType,
            content,
            media_url: null,
            reply_to_message_id: replyToMessageId,
            whatsapp_message_id: message.id,
            created_at: new Date(Number(message.timestamp) * 1000).toISOString(),
          })
          .select("id")
          .single();

        if (insertError) {
          if (insertError.code === "23505") {
            // Meta reentregó este webhook (entrega "at-least-once" de la
            // Cloud API): este mensaje ya se guardó en un intento anterior.
            // No hay nada más que hacer para este mensaje puntual.
            console.info(
              `Webhook de WhatsApp: mensaje ${message.id} ya estaba guardado (reentrega de Meta), se ignora.`
            );
          } else {
            console.error("Webhook de WhatsApp: error al guardar mensaje entrante", insertError);
          }
          continue;
        }

        if (pendingMediaId && accessToken) {
          const messageDbId = insertedMessage.id;
          const convId = conversationId;
          const waMessageId = message.id;
          const mediaId = pendingMediaId;
          mediaDownloadTasks.push(async () => {
            try {
              const { url, mimeType } = await getMetaMediaUrl(mediaId, accessToken);
              const bytes = await downloadMetaMedia(url, accessToken);
              const extension = EXTENSION_BY_MIME[mimeType] ?? "bin";
              const path = `${convId}/${waMessageId}.${extension}`;

              const { error: uploadError } = await supabase.storage
                .from("whatsapp-media")
                .upload(path, bytes, { contentType: mimeType, upsert: true });

              if (uploadError) {
                console.error("Webhook de WhatsApp: error al subir media a Storage", uploadError);
                return;
              }

              const { data: publicUrl } = supabase.storage.from("whatsapp-media").getPublicUrl(path);
              await supabase.from("messages").update({ media_url: publicUrl.publicUrl }).eq("id", messageDbId);
            } catch (err) {
              console.error("Webhook de WhatsApp: error al descargar media de Meta", err);
            }
          });
        }

        touchedByCustomer.add(conversationId);

        // Una sola bienvenida por conversación aunque el cliente mande varios
        // mensajes seguidos y lleguen en el mismo lote del webhook.
        if (windowWasClosed && !greeted.has(conversationId)) {
          greeted.add(conversationId);
          await sendWelcome(supabase, channel, conversationId, phoneNumber, accessToken);
        }
      }
    }
  }

  // La descarga de media también corre después de responder a Meta —mismo
  // motivo que el turno de IA: un archivo pesado no debe arriesgar el
  // timeout del webhook (~20s), que dispararía un reintento de Meta.
  if (mediaDownloadTasks.length > 0) {
    after(() => Promise.allSettled(mediaDownloadTasks.map((task) => task())));
  }

  // El turno del agente de IA corre después de responder a Meta: el webhook
  // debe ser rápido, y una tanda con varios mensajes del cliente dispara UN
  // solo turno por conversación (no uno por mensaje).
  if (touchedByCustomer.size > 0) {
    after(() => runAgentTurnsFor(touchedByCustomer));
  }

  return NextResponse.json({ ok: true });
}
