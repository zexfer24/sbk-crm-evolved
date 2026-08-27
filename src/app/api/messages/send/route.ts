import { NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { log, errorText } from "@/lib/log";
import type { MessageType } from "@/lib/types";
import { signedUrlForSending } from "@/lib/media-link";
import { isDeliverablePhoneNumber } from "@/lib/whatsapp/phone";
import {
  MetaApiError,
  metaErrorCode,
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

/** Lo único que el envío necesita de la conversación: a quién y por qué canal. */
interface SendConversation {
  id: string;
  contact: { phone_number: string };
  channel: { phone_number_id: string | null; status: string };
}

/**
 * Un fallo de Meta que puede pasar solo: un 5xx suyo o la red que no llegó
 * (ETIMEDOUT contra Meta se ve seguido desde este servidor). Un 4xx es un
 * rechazo con motivo —plantilla inválida, ventana de 24 h vencida— y
 * reintentarlo daría lo mismo.
 */
function isTransientMetaFailure(err: unknown): boolean {
  return !(err instanceof MetaApiError) || err.status >= 500;
}

/** Un solo reintento: más intentos sobre un timeout arriesgan duplicar el mensaje al cliente. */
const RETRY_DELAY_MS = 2000;

async function sendWithRetry(send: () => Promise<{ whatsappMessageId: string }>) {
  try {
    return await send();
  } catch (err) {
    if (!isTransientMetaFailure(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return await send();
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as SendMessageBody;
  const { conversationId, kind, content, isInternalNote, templateName, templateLanguage, mediaUrl } =
    body;
  const mediaType = body.mediaType as "image" | "video" | "audio" | "document" | undefined;
  const replyToMessageId = body.replyToMessageId ?? null;

  if (
    !conversationId ||
    (kind === "text" && !content) ||
    (kind === "media" && !mediaUrl) ||
    (kind === "template" && !templateName)
  ) {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  }

  const supabase = await createClient();
  const agent = await fetchCurrentAgent(supabase);
  if (!agent) {
    return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  }
  // Solo lo que hace falta para enviar: el asesor está esperando esta
  // respuesta con el mensaje ya escrito, no es momento de armar la ficha
  // completa con sus siete relaciones.
  const { data: conversationRow, error: conversationError } = await supabase
    .from("conversations")
    .select("id, contact:contacts(phone_number), channel:whatsapp_channels(phone_number_id, status)")
    .eq("id", conversationId)
    .maybeSingle();
  const conversation = conversationRow as unknown as SendConversation | null;
  if (conversationError || !conversation) {
    return NextResponse.json({ error: "Conversación no encontrada." }, { status: 404 });
  }

  // Nota interna: nunca sale por WhatsApp, solo queda registrada en el CRM.
  if (isInternalNote) {
    const { data: note, error } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        direction: "outbound",
        sender_type: "agent",
        sender_agent_id: agent.id,
        message_type: "text",
        content: content ?? "",
        is_internal_note: true,
        reply_to_message_id: replyToMessageId,
      })
      .select("id")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: note.id });
  }

  const isRealChannel = conversation.channel.status === "connected" && conversation.channel.phone_number_id;

  // Falta de configuración: mejor un error inmediato que un mensaje que se
  // guarda y muere en silencio en segundo plano.
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (isRealChannel && !accessToken) {
    return NextResponse.json(
      { error: "El canal está marcado como conectado pero falta WHATSAPP_ACCESS_TOKEN en el servidor." },
      { status: 500 }
    );
  }

  // Un chat cuyo contacto no tiene un teléfono de verdad no tiene a dónde
  // enviar, y eso no lo arregla reintentar. Se corta ANTES de insertar la
  // fila: dejar el mensaje guardado y que falle en segundo plano es lo que
  // produce el triángulo rojo que el asesor reintenta cinco veces.
  //
  // Se le dice qué hacer, no sólo que no se puede. El único arreglo posible
  // está fuera del CRM: pedirle el número al cliente por otra vía.
  if (isRealChannel && !isDeliverablePhoneNumber(conversation.contact.phone_number)) {
    log.warn("send.contacto_sin_telefono", {
      conversationId,
      // Es la razón exacta por la que no se puede enviar y no es un teléfono
      // —de serlo, no estaríamos acá— así que va entera al registro.
      guardado: conversation.contact.phone_number,
    });
    return NextResponse.json(
      {
        error:
          `Este chat no tiene un número de WhatsApp válido (quedó guardado como "${conversation.contact.phone_number}"), ` +
          "así que no hay a dónde entregar el mensaje. Pídele el número al cliente por otra vía y corrígelo en su ficha.",
      },
      { status: 422 }
    );
  }

  // El mensaje se guarda ANTES de hablar con Meta y el asesor recibe su
  // respuesta ya: con la latencia hacia Meta desde este servidor (4 s de
  // media, 14 de pico, ETIMEDOUT incluidos), esperar la Graph API tenía al
  // equipo mirando un relojito por cada mensaje. El estado nace null —el
  // mismo "en camino" del check de WhatsApp— y el envío real corre después
  // de responder: al confirmar Meta pasa a 'sent' y el check aparece por
  // realtime; si Meta lo rechaza pasa a 'failed' y la burbuja lo cuenta.
  const { data: inserted, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      direction: "outbound",
      sender_type: "agent",
      sender_agent_id: agent.id,
      message_type: kind === "template" ? "template" : kind === "media" ? mediaType : "text",
      content: content ?? null,
      template_name: kind === "template" ? templateName : null,
      media_url: kind === "media" ? mediaUrl : null,
      whatsapp_message_id: null,
      whatsapp_status: null,
      reply_to_message_id: replyToMessageId,
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (isRealChannel) {
    const messageId = inserted.id as string;
    const phoneNumberId = conversation.channel.phone_number_id!;
    const toPhoneNumber = conversation.contact.phone_number;

    after(async () => {
      try {
        // Si estamos citando un mensaje que sí llegó/salió por WhatsApp de
        // verdad, resolvemos su wamid para mandar la cita como reply nativo.
        let replyToWamid: string | null = null;
        if (replyToMessageId) {
          const { data: repliedMessage } = await supabase
            .from("messages")
            .select("whatsapp_message_id")
            .eq("id", replyToMessageId)
            .maybeSingle();
          replyToWamid = repliedMessage?.whatsapp_message_id ?? null;
        }

        let result;
        if (kind === "template") {
          result = await sendWithRetry(() =>
            sendWhatsappTemplate(phoneNumberId, accessToken!, toPhoneNumber, templateName!, templateLanguage ?? "es")
          );
        } else if (kind === "media") {
          // El bucket es privado: Meta necesita un enlace firmado, no la ruta
          // del CRM, que le pediría una sesión que no tiene.
          const link = await signedUrlForSending(mediaUrl!);
          if (!link) throw new Error("No se pudo preparar el archivo para enviarlo por WhatsApp.");

          result = await sendWithRetry(() =>
            sendWhatsappMedia(
              phoneNumberId,
              accessToken!,
              toPhoneNumber,
              mediaType as "image" | "video" | "audio" | "document",
              link,
              content,
              replyToWamid
            )
          );
        } else {
          result = await sendWithRetry(() =>
            sendWhatsappText(phoneNumberId, accessToken!, toPhoneNumber, content!, replyToWamid)
          );
        }

        const { error: updateError } = await supabase
          .from("messages")
          .update({ whatsapp_message_id: result.whatsappMessageId, whatsapp_status: "sent" })
          .eq("id", messageId);
        if (updateError) {
          // El mensaje SÍ salió pero el CRM no pudo anotarlo: se queda sin
          // check y sin wamid, así que los avisos de entrega del webhook no
          // van a encontrarlo. Queda registrado para poder explicarlo.
          log.error("send.confirm_update_failed", { messageId, detail: updateError.message });
        }
      } catch (err) {
        // El motivo se guarda con el estado, no sólo en el registro: quien
        // tiene que decidir si reintentar es el asesor que está mirando la
        // burbuja, y hasta ahora lo único que veía era un triángulo rojo.
        await supabase
          .from("messages")
          .update({
            whatsapp_status: "failed",
            whatsapp_error_code: metaErrorCode(err),
            whatsapp_error_detail: errorText(err),
          })
          .eq("id", messageId);
        log.error("send.meta_failed", {
          messageId,
          conversationId,
          kind,
          detail: errorText(err),
          metaStatus: err instanceof MetaApiError ? err.status : null,
          metaCode: metaErrorCode(err),
        });
      }
    });
  }

  // Se devuelve el id de la fila insertada: la cola de envío del navegador lo
  // usa para saber cuándo el mensaje real ya llegó al hilo y retirar el suyo.
  return NextResponse.json({ ok: true, id: inserted.id });
}
