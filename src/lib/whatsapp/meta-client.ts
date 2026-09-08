// Cliente server-only para la WhatsApp Cloud API (Meta). Nunca importar desde
// un componente cliente: usa el access token del canal vía variables de entorno.

import { errorText, log } from "@/lib/log";
import type { WhatsappTemplateComponent } from "@/lib/whatsapp/template-variables";

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION ?? "v21.0";

export class MetaApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details: unknown
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

/**
 * Código de error de Meta dentro de un fallo de la Graph API, si vino.
 *
 * OJO: no es `status`. `status` es el HTTP —400, 401, 500— y sirve para saber
 * si reintentar. El código de Meta es lo que dice QUÉ pasó: 131026 es "ese
 * número no recibe mensajes" y 131047 es "pasaron 24 h", y los dos llegan como
 * un 400. Sin este número, los dos fallos son indistinguibles.
 */
export function metaErrorCode(err: unknown): number | null {
  if (!(err instanceof MetaApiError)) return null;
  const details = err.details as { error?: { code?: unknown } } | null | undefined;
  const code = details?.error?.code;
  return typeof code === "number" ? code : null;
}

/** Deja solo dígitos: formato que la Cloud API espera para `to` (sin "+", sin espacios). */
export function toWaId(phoneNumber: string): string {
  return phoneNumber.replace(/[^\d]/g, "");
}

interface SendResult {
  whatsappMessageId: string;
}

type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

async function callGraphApi(phoneNumberId: string, accessToken: string, body: Record<string, unknown>) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });

  const json = await res.json();

  if (!res.ok) {
    const detail = json?.error?.message ?? "Error desconocido de la Cloud API de Meta";
    throw new MetaApiError(detail, res.status, json);
  }

  return json as { messages: { id: string }[] };
}

function contextOf(replyToWamid?: string | null) {
  return replyToWamid ? { context: { message_id: replyToWamid } } : {};
}

export async function sendWhatsappText(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
  replyToWamid?: string | null
): Promise<SendResult> {
  const json = await callGraphApi(phoneNumberId, accessToken, {
    to: toWaId(to),
    type: "text",
    text: { body },
    ...contextOf(replyToWamid),
  });
  return { whatsappMessageId: json.messages[0].id };
}

export async function sendWhatsappTemplate(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  templateName: string,
  languageCode: string,
  // Parámetros posicionales del cuerpo (y de la cabecera, si la plantilla
  // lleva una): sin esto, una plantilla con variables salía con sus
  // `{{1}}`/`{{2}}` literales delante del cliente (T3.3, 5/9/2026). Opcional
  // y omitido del payload cuando la plantilla no tiene ninguna: Meta rechaza
  // `components: []` en plantillas sin parámetros.
  components?: WhatsappTemplateComponent[]
): Promise<SendResult> {
  const json = await callGraphApi(phoneNumberId, accessToken, {
    to: toWaId(to),
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components && components.length > 0 ? { components } : {}),
    },
  });
  return { whatsappMessageId: json.messages[0].id };
}

export async function sendWhatsappMedia(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  mediaType: MediaKind,
  link: string,
  caption?: string,
  replyToWamid?: string | null
): Promise<SendResult> {
  // Audio y sticker no aceptan caption: según la referencia de mensajes de la
  // Cloud API el objeto `sticker` solo lleva `id`/`link` (T3a "Seis frentes
  // del buzón", 8/9/2026 — audio ya lo evitaba desde antes). Sin verificar
  // contra Meta todavía: el primer sticker saliente en producción es la prueba.
  const mediaPayload =
    mediaType === "audio" || mediaType === "sticker" ? { link } : { link, caption: caption || undefined };

  const json = await callGraphApi(phoneNumberId, accessToken, {
    to: toWaId(to),
    type: mediaType,
    [mediaType]: mediaPayload,
    ...contextOf(replyToWamid),
  });
  return { whatsappMessageId: json.messages[0].id };
}

// ---------------------------------------------------------------------------
// Descarga de multimedia entrante (usado por el webhook).
// ---------------------------------------------------------------------------

export async function getMetaMediaUrl(
  mediaId: string,
  accessToken: string
): Promise<{ url: string; mimeType: string }> {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new MetaApiError(json?.error?.message ?? "No se pudo resolver la URL del media.", res.status, json);
  }
  return { url: json.url as string, mimeType: json.mime_type as string };
}

export async function downloadMetaMedia(url: string, accessToken: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new MetaApiError("No se pudo descargar el archivo multimedia.", res.status, null);
  const buffer = await res.arrayBuffer();
  return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------
// Señales hacia el cliente que no son mensajes (T3.1, 4/9/2026): el doble
// check azul y "escribiendo…". Van al mismo endpoint que un envío normal
// (`/messages`), pero acá el fallo NUNCA puede romper nada — un check que no
// llegó o un typing que no se disparó no le impide a la bandeja ni al turno
// de la IA seguir. Por eso, a diferencia del resto de este archivo, estas dos
// funciones no lanzan `MetaApiError`: atrapan su propio fallo y solo dejan
// constancia en el registro. El "message_id" que exige Meta en los dos casos
// es el wamid del mensaje ENTRANTE al que se está respondiendo — es cómo la
// Cloud API sabe a qué chat apunta el check o el indicador, sin volver a
// pedir el número del cliente.
// ---------------------------------------------------------------------------

async function notifyGraphApi(
  phoneNumberId: string,
  accessToken: string,
  body: Record<string, unknown>,
  evento: string
): Promise<void> {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      log.warn(evento, { status: res.status, detail: json?.error?.message ?? null });
    }
  } catch (err) {
    log.warn(evento, { detail: errorText(err) });
  }
}

/** El doble check azul: le confirma a Meta que el mensaje del cliente ya se leyó. */
export async function markWhatsappRead(phoneNumberId: string, accessToken: string, wamid: string): Promise<void> {
  await notifyGraphApi(
    phoneNumberId,
    accessToken,
    { status: "read", message_id: wamid },
    "whatsapp_marcar_leido_fallido"
  );
}

/**
 * "Escribiendo…" del lado del cliente. Meta lo apaga solo —al llegar la
 * respuesta o a los 25 s, lo que pase primero—, así que solo tiene sentido
 * dispararlo justo antes de ponerse a redactar de verdad.
 */
export async function sendTypingIndicator(phoneNumberId: string, accessToken: string, wamid: string): Promise<void> {
  await notifyGraphApi(
    phoneNumberId,
    accessToken,
    { status: "read", message_id: wamid, typing_indicator: { type: "text" } },
    "whatsapp_typing_fallido"
  );
}
