// Cliente server-only para la API de WhatsApp. Nunca importar desde un
// componente cliente: usa las credenciales del proveedor vía variables de entorno.
//
// Desde el 8/10/2026 (plan "SBK CRM pasa a 360dialog") sirve a DOS proveedores:
// la Cloud API de Meta y 360dialog, que habla el mismo payload pero con otro
// host de envío, otra autenticación saliente (`D360-API-KEY` en vez de
// `Authorization: Bearer`) y otra ruta para descargar multimedia. Se perdió el
// número de Meta por facturación y el nuevo vive en 360dialog. Conserva el
// nombre `meta-client.ts` y sus funciones a propósito (D3): renombrarlo era
// ruido en seis importadores, el glosario y CLAUDE.md. Qué proveedor se usa
// lo decide `WhatsappCredentials` (`provider.ts`), no este archivo.

import { errorText, log } from "@/lib/log";
import type { WhatsappCredentials } from "@/lib/whatsapp/provider";
import type { WhatsappTemplateComponent } from "@/lib/whatsapp/template-variables";

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

/** Endpoint de envío: Meta lo ubica por número de teléfono; 360dialog lo ubica por la llave. */
function messagesUrl(phoneNumberId: string, c: WhatsappCredentials): string {
  return c.provider === "360dialog"
    ? `${c.baseUrl}/messages`
    : `https://graph.facebook.com/${c.graphVersion}/${phoneNumberId}/messages`;
}

/** Cabecera de autenticación de cada proveedor. La llave de 360dialog NUNCA va en `Authorization`. */
function authHeaders(c: WhatsappCredentials): Record<string, string> {
  return c.provider === "360dialog" ? { "D360-API-KEY": c.apiKey } : { Authorization: `Bearer ${c.accessToken}` };
}

/**
 * Texto del error de un fallo de la API. Meta manda `{ error: { message } }`;
 * 360dialog, en su 429, manda `{ error: "Too many requests for one number" }`
 * (un STRING, no un objeto) y a veces solo `meta.developer_message`. Sin cuerpo
 * legible se nombra al proveedor y el HTTP, para no mostrar "Error desconocido"
 * sin saber de quién ni por qué.
 */
function detalleDelError(json: unknown, status: number, credentials: WhatsappCredentials): string {
  const cuerpo = json as {
    error?: string | { message?: string };
    meta?: { developer_message?: string };
  } | null;
  const deError = typeof cuerpo?.error === "string" ? cuerpo.error : cuerpo?.error?.message;
  return (
    deError ??
    cuerpo?.meta?.developer_message ??
    `${credentials.provider === "360dialog" ? "360dialog" : "Meta"} respondió HTTP ${status} sin detalle`
  );
}

/**
 * Esperas entre reintentos de un 429, en ms (hasta 3 reintentos = 4 POST).
 *
 * 9/10/2026: 360dialog limita por DESTINATARIO ("Too many requests for one
 * number"): dos POST al mismo número con menos de ~1-3 s de diferencia y el
 * segundo vuelve 429, sin `Retry-After`. En producción 10 de 14 textos de un
 * asesor quedaron `failed` porque el "escribiendo…" previo se había comido el
 * cupo. Un 429 es un mensaje NO aceptado: repetirlo no duplica. Vive en la
 * capa más baja para cubrir al asesor y a la IA con el mismo código.
 */
export const ESPERAS_429_MS = [1500, 3000, 5000] as const;
const TOPE_RETRY_AFTER_MS = 10_000;

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After en segundos (>0) a ms con tope; `null` si no vino o no es numérico. */
function retryAfterMs(res: Response): number | null {
  // Defensivo: los mocks de los tests devuelven objetos sin `headers`.
  const crudo = res.headers?.get?.("retry-after");
  const segundos = crudo == null ? NaN : Number(crudo);
  if (!Number.isFinite(segundos) || segundos <= 0) return null;
  return Math.min(segundos * 1000, TOPE_RETRY_AFTER_MS);
}

async function callGraphApi(phoneNumberId: string, credentials: WhatsappCredentials, body: Record<string, unknown>) {
  const url = messagesUrl(phoneNumberId, credentials);
  const init = {
    method: "POST",
    headers: {
      ...authHeaders(credentials),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  };

  let res = await fetch(url, init);
  for (let intento = 1; res.status === 429 && intento <= ESPERAS_429_MS.length; intento++) {
    log.warn("whatsapp_429_reintento", { intento, provider: credentials.provider });
    await esperar(retryAfterMs(res) ?? ESPERAS_429_MS[intento - 1]);
    res = await fetch(url, init);
  }

  // D8: un 401 de 360dialog por llave inválida puede no ser JSON; sin el
  // catch eso reventaba con un SyntaxError en vez de un MetaApiError con status.
  const json = await res.json().catch(() => null);

  if (!res.ok) {
    throw new MetaApiError(detalleDelError(json, res.status, credentials), res.status, json);
  }

  return json as { messages: { id: string }[] };
}

function contextOf(replyToWamid?: string | null) {
  return replyToWamid ? { context: { message_id: replyToWamid } } : {};
}

export async function sendWhatsappText(
  phoneNumberId: string,
  credentials: WhatsappCredentials,
  to: string,
  body: string,
  replyToWamid?: string | null
): Promise<SendResult> {
  const json = await callGraphApi(phoneNumberId, credentials, {
    to: toWaId(to),
    type: "text",
    text: { body },
    ...contextOf(replyToWamid),
  });
  return { whatsappMessageId: json.messages[0].id };
}

export async function sendWhatsappTemplate(
  phoneNumberId: string,
  credentials: WhatsappCredentials,
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
  const json = await callGraphApi(phoneNumberId, credentials, {
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
  credentials: WhatsappCredentials,
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

  const json = await callGraphApi(phoneNumberId, credentials, {
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
  credentials: WhatsappCredentials
): Promise<{ url: string; mimeType: string }> {
  const endpoint =
    credentials.provider === "360dialog"
      ? `${credentials.baseUrl}/${mediaId}`
      : `https://graph.facebook.com/${credentials.graphVersion}/${mediaId}`;
  const res = await fetch(endpoint, { headers: authHeaders(credentials) });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new MetaApiError(json?.error?.message ?? "No se pudo resolver la URL del media.", res.status, json);
  }
  return { url: json.url as string, mimeType: json.mime_type as string };
}

const HOST_MULTIMEDIA_DE_META = "lookaside.fbsbx.com";

/**
 * Convierte la URL de multimedia que entrega 360dialog (host de Meta, a veces
 * con las barras escapadas como `https:\/\/…`) a la URL de 360dialog desde la
 * que SÍ se puede descargar con su llave. D4: la llave solo viaja a
 * `baseUrl`; si, ya reescrita, la URL no tiene el mismo origen, lanza — una
 * URL que viene en el payload del webhook no puede llevarse la llave a otro host.
 */
export function rewriteD360MediaUrl(url: string, baseUrl: string): string {
  const fueraDelHost = () => new Error("URL de multimedia fuera del host de 360dialog");

  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url.replace(/\\/g, ""));
    base = new URL(baseUrl);
  } catch {
    throw fueraDelHost();
  }

  const reescrita =
    parsed.hostname === HOST_MULTIMEDIA_DE_META ? new URL(`${parsed.pathname}${parsed.search}`, base.origin) : parsed;

  if (reescrita.origin !== base.origin) throw fueraDelHost();
  return reescrita.toString();
}

export async function downloadMetaMedia(url: string, credentials: WhatsappCredentials): Promise<Uint8Array> {
  // En 360dialog la reescritura (y su chequeo de origen) corre ANTES del fetch:
  // una URL rechazada no hace ninguna petición ni expone la llave.
  const destino = credentials.provider === "360dialog" ? rewriteD360MediaUrl(url, credentials.baseUrl) : url;
  const res = await fetch(destino, { headers: authHeaders(credentials) });
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
  credentials: WhatsappCredentials,
  body: Record<string, unknown>,
  evento: string
): Promise<void> {
  try {
    const res = await fetch(messagesUrl(phoneNumberId, credentials), {
      method: "POST",
      headers: {
        ...authHeaders(credentials),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      log.warn(evento, { status: res.status, detail: detalleDelError(json, res.status, credentials) });
    }
  } catch (err) {
    log.warn(evento, { detail: errorText(err) });
  }
}

/** El doble check azul: le confirma a Meta que el mensaje del cliente ya se leyó. */
export async function markWhatsappRead(
  phoneNumberId: string,
  credentials: WhatsappCredentials,
  wamid: string
): Promise<void> {
  await notifyGraphApi(
    phoneNumberId,
    credentials,
    { status: "read", message_id: wamid },
    "whatsapp_marcar_leido_fallido"
  );
}

/**
 * "Escribiendo…" del lado del cliente. Meta lo apaga solo —al llegar la
 * respuesta o a los 25 s, lo que pase primero—, así que solo tiene sentido
 * dispararlo justo antes de ponerse a redactar de verdad.
 */
export async function sendTypingIndicator(
  phoneNumberId: string,
  credentials: WhatsappCredentials,
  wamid: string
): Promise<void> {
  await notifyGraphApi(
    phoneNumberId,
    credentials,
    { status: "read", message_id: wamid, typing_indicator: { type: "text" } },
    "whatsapp_typing_fallido"
  );
}
