// Cliente server-only para la WhatsApp Cloud API (Meta). Nunca importar desde
// un componente cliente: usa el access token del canal vía variables de entorno.

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

/** Deja solo dígitos: formato que la Cloud API espera para `to` (sin "+", sin espacios). */
export function toWaId(phoneNumber: string): string {
  return phoneNumber.replace(/[^\d]/g, "");
}

interface SendResult {
  whatsappMessageId: string;
}

type MediaKind = "image" | "video" | "audio" | "document";

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
  languageCode: string
): Promise<SendResult> {
  const json = await callGraphApi(phoneNumberId, accessToken, {
    to: toWaId(to),
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
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
  const mediaPayload = mediaType === "audio" ? { link } : { link, caption: caption || undefined };

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
