import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { WINDOW_MS, isWithin24hWindow } from "@/lib/whatsapp-window";
import {
  MetaApiError,
  downloadMetaMedia,
  getMetaMediaUrl,
  metaErrorCode,
  sendWhatsappTemplate,
} from "@/lib/whatsapp/meta-client";
import { debounceSecondsFor, enqueueAgentTurns, processAfterDebounce } from "@/lib/ai/queue";
import { recordHandoff } from "@/lib/ai/handoffs";
import { MEDIA_BUCKET, mediaUrlFor } from "@/lib/storage";
import { phoneNumberFromWaId } from "@/lib/whatsapp/phone";
import { pgrstLiteral } from "@/lib/ai/pgrst";
import { log, errorText } from "@/lib/log";

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
  /**
   * Identificador del remitente. Opcional en el tipo aunque la documentación
   * lo dé por seguro: hay mensajes reales que llegan sin él, y darlo por hecho
   * es lo que metió la cadena '+undefined' en la base. Ver phoneNumberFromWaId.
   */
  from?: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WebhookMediaObject;
  video?: WebhookMediaObject;
  audio?: WebhookMediaObject;
  document?: WebhookMediaObject;
  sticker?: WebhookMediaObject;
  context?: {
    id: string;
    /**
     * Solo cuando el mensaje llega en respuesta a un anuncio "Click to
     * WhatsApp" que referenciaba un producto puntual del catálogo (distinto
     * de `message.referral`, que es el anuncio en general).
     */
    referred_product?: { catalog_id: string; product_retailer_id: string };
  };
  /** Solo en los `type: "reaction"`: a qué mensaje reacciona y con qué emoji. */
  reaction?: { message_id: string; emoji?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
  /** Solo en `type: "interactive"`: la respuesta a un botón o a un ítem de lista. */
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  /** Solo en `type: "button"`: la respuesta al botón rápido de una plantilla. */
  button?: { payload: string; text: string };
  /** Solo en `type: "order"`: un pedido armado desde el catálogo de WhatsApp. */
  order?: {
    catalog_id: string;
    product_items: { product_retailer_id: string; quantity: number; item_price: number; currency: string }[];
    text?: string;
  };
  /**
   * Solo en el mensaje que origina una conversación desde un anuncio "Click
   * to WhatsApp": de qué anuncio vino. Se guarda en `conversations.referral`,
   * no en este mensaje puntual.
   */
  referral?: {
    source_url?: string;
    source_type?: string;
    source_id?: string;
    headline?: string;
    body?: string;
    media_type?: string;
    image_url?: string;
    video_url?: string;
    ctwa_clid?: string;
  };
  /**
   * Solo viene en los `type: "unsupported"`: es el motivo por el que Meta no
   * pudo entregar el mensaje (131051 "Message type unknown", 131060 "This
   * message is currently unavailable").
   */
  errors?: { code: number; title?: string; message?: string }[];
  /**
   * Solo en `type: "system"`: un evento del CLIENTE, no un mensaje que haya
   * escrito -- el único subtipo con datos hoy es que cambió de número de
   * WhatsApp. Forma verificada contra un payload real reportado por
   * terceros el 27/6/2023: la Cloud API manda `wa_id`; la documentación
   * on-premises llama `new_wa_id` al mismo campo. `identity` es del otro
   * subtipo documentado, `customer_identity_changed`, que no trae `wa_id`.
   * Plan "El cliente que cambió de número" (6/9/2026).
   */
  system?: { body?: string; type?: string; wa_id?: string; new_wa_id?: string; identity?: string };
}

interface WebhookStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "played" | "failed";
  /**
   * Sólo en los `status: "failed"`: por qué Meta no lo entregó.
   *
   * Venía llegando desde siempre y se tiraba. Es la diferencia entre "no se
   * envió" y "el número no existe", que son dos problemas con dos arreglos
   * distintos y que hasta ahora se veían igual en la burbuja.
   */
  errors?: {
    code: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }[];
}

interface WebhookChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id: string }[];
  messages?: WebhookMessage[];
  statuses?: WebhookStatus[];
  /**
   * Errores a nivel de cuenta que Meta manda sueltos en el `value`, aparte de
   * los `errors` por mensaje (WebhookMessage) o por estado (WebhookStatus).
   */
  errors?: { code: number; title?: string; message?: string }[];
}

interface WebhookBody {
  entry?: { changes?: { field: string; value: WebhookChangeValue }[] }[];
}

// ---------------------------------------------------------------------------
// T3.4: los otros tres `field` que manda el webhook de la WABA además de
// `messages`. Ninguno de los tres trae `metadata.phone_number_id` -- por eso
// llevan su propia forma de payload en vez de sumarse a WebhookChangeValue, y
// el canal se resuelve por número de teléfono (ver resolveHealthChannel).
// ---------------------------------------------------------------------------
interface WebhookTemplateStatusValue {
  event?: string;
  message_template_id?: number;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string;
}

interface WebhookQualityValue {
  display_phone_number?: string;
  event?: string;
  current_limit?: string;
  /** No todas las versiones del webhook lo mandan; cuando existe, es más fiable que derivarlo del event. */
  quality_rating?: string;
}

interface WebhookAccountUpdateValue {
  phone_number?: string;
  event?: string;
  ban_info?: { waba_ban_state?: string; waba_ban_date?: string };
  restriction_info?: { restriction_type?: string; expiration?: string }[];
}

/**
 * El motivo del fallo, del más específico al más genérico.
 *
 * Meta manda hasta tres textos para el mismo error y no siempre los tres.
 * `error_data.details` es el que dice algo concreto ("Message failed to send
 * because there were one or more errors related to your payment method");
 * `title` es la etiqueta de catálogo. Quedarse con el primero que venga en ese
 * orden es lo que hace que la burbuja diga algo útil.
 */
function metaFailureText(fallo: NonNullable<WebhookStatus["errors"]>[number]): string {
  return fallo.error_data?.details ?? fallo.message ?? fallo.title ?? `Error ${fallo.code} de Meta.`;
}

// Techo de eventos por minuto. Holgado para el tráfico de una repuestera
// —Meta agrupa varios mensajes por lote— y suficiente para cortar un bucle
// de reintentos antes de que dispare cientos de turnos de IA.
const WEBHOOK_RATE_LIMIT = Number(process.env.WHATSAPP_WEBHOOK_RATE_LIMIT ?? 120);
const WEBHOOK_RATE_WINDOW_SECONDS = 60;

/**
 * Cómo contar en el chat lo que no es texto ni un archivo.
 *
 * Antes, todo lo que no fuera texto o multimedia caía en un mismo cajón y se
 * guardaba como "[location] Tipo de mensaje no soportado todavía". Eso son
 * dos pérdidas a la vez: el dato —un cliente que manda su ubicación está
 * diciendo dónde entregarle— y la confianza, porque el asesor lee jerga que
 * no le dice qué hacer y termina ignorando el mensaje.
 */
function describirUbicacion(location: NonNullable<WebhookMessage["location"]>): string {
  const { latitude, longitude, name, address } = location;
  // El enlace primero en importancia pero al final del texto: es lo que se
  // toca, y así no parte la frase.
  const mapa = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  const donde = [name, address].filter(Boolean).join(" — ");

  return donde
    ? `📍 El cliente compartió una ubicación: ${donde} (${latitude}, ${longitude}) ${mapa}`
    : `📍 El cliente compartió una ubicación (${latitude}, ${longitude}) ${mapa}`;
}

function describirContactos(contacts: NonNullable<WebhookMessage["contacts"]>): string {
  const nombres = contacts
    .map((c) => c.name?.formatted_name ?? c.phones?.[0]?.phone)
    .filter(Boolean)
    .join(", ");

  return nombres
    ? `👤 El cliente compartió un contacto: ${nombres}`
    : "👤 El cliente compartió un contacto.";
}

/**
 * El resumen en español de un pedido armado desde el catálogo de WhatsApp.
 *
 * Meta no manda el nombre del producto, solo el `product_retailer_id` (el
 * SKU que se le dio de alta en el catálogo) — buscarlo contra `products`
 * queda fuera de esta tarea. El total se agrupa por moneda porque el pedido
 * lo permite, aunque en la práctica siempre sea una sola.
 */
function describirPedido(order: NonNullable<WebhookMessage["order"]>): string {
  const items = order.product_items ?? [];
  const totalPorMoneda = new Map<string, number>();
  const lineas = items.map((item) => {
    const moneda = item.currency || "USD";
    const precio = Number(item.item_price) || 0;
    totalPorMoneda.set(moneda, (totalPorMoneda.get(moneda) ?? 0) + item.quantity * precio);
    return `- ${item.quantity}x ${item.product_retailer_id} (${moneda} ${precio.toFixed(2)} c/u)`;
  });

  const totales = [...totalPorMoneda.entries()]
    .map(([moneda, total]) => `${moneda} ${total.toFixed(2)}`)
    .join(", ");

  const encabezado =
    items.length === 1
      ? "🛒 El cliente envió un pedido del catálogo (1 producto):"
      : `🛒 El cliente envió un pedido del catálogo (${items.length} productos):`;

  return [encabezado, ...lineas, totales ? `Total: ${totales}` : null].filter(Boolean).join("\n");
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
//
// La decisión de "¿ya se saludó?" es de la base, no de esta invocación
// (29/8/2026): antes vivía en un Set en memoria del POST, y dos webhooks casi
// simultáneos de Meta para un contacto nuevo son dos invocaciones con dos
// Sets — ambas veían la ventana cerrada y mandaban la plantilla dos veces.
// Ver claimWelcome.
// ---------------------------------------------------------------------------
interface WelcomeChannel {
  id: string;
  phone_number_id: string | null;
  status: string;
}

/**
 * Reclama el envío de la bienvenida sellando `welcome_sent_at` ANTES de
 * enviar nada. El UPDATE condicional es la carrera entera: dos invocaciones
 * concurrentes mandan la misma consulta, y Postgres —bajo READ COMMITTED—
 * reevalúa el WHERE contra la fila ya actualizada por la primera que
 * confirma; la segunda ve 0 filas afectadas y pierde limpio, sin tocar nada.
 *
 * El corte de 24h en el `.or()` (welcome_sent_at nulo O sellado hace más de
 * 24h) no bloquea el re-saludo legítimo: cuando `windowWasClosed` es true por
 * haber pasado 24h sin mensajes del cliente, el sello anterior —si lo hay—
 * también tiene más de 24h, así que sigue calificando.
 *
 * Falla cerrado: un error de red o de la base al reclamar no manda la
 * plantilla. Un reclamo que no se puede verificar no es un reclamo.
 */
async function claimWelcome(supabase: SupabaseClient, conversationId: string): Promise<boolean> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - WINDOW_MS).toISOString();

  const { data, error } = await supabase
    .from("conversations")
    .update({ welcome_sent_at: now.toISOString() })
    .eq("id", conversationId)
    .or(`welcome_sent_at.is.null,welcome_sent_at.lt.${pgrstLiteral(staleBefore)}`)
    .select("id");

  if (error) {
    log.error("bienvenida_reclamo_fallido", { conversationId, detalle: errorText(error) });
    return false;
  }

  return (data?.length ?? 0) > 0;
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

  // Las comprobaciones de configuración van ANTES del reclamo: una plantilla
  // sin configurar o un canal desconectado no debe sellar la fecha — si se
  // arregla la configuración después, ese cliente tiene que poder recibir la
  // bienvenida igual.
  if (channel.status !== "connected" || !channel.phone_number_id || !accessToken) {
    log.warn("bienvenida_canal_no_disponible", { conversationId });
    return;
  }

  const claimed = await claimWelcome(supabase, conversationId);
  if (!claimed) {
    log.info("bienvenida_ya_reclamada", { conversationId });
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
      // No cuenta como respuesta real (T0.1, 20260905010000): el trigger
      // handle_new_message no mueve last_reply_at para un is_auto_reply, así
      // que la bienvenida nunca apaga "esperando respuesta" por sí sola.
      is_auto_reply: true,
    });

    // Sin update final: el sello ya quedó puesto al reclamar, arriba.
  } catch (err) {
    if (err instanceof MetaApiError) {
      // Meta contestó rechazando la plantilla: no salió nada. Se devuelve el
      // sello a null para que el próximo mensaje del cliente pueda
      // reintentar la bienvenida.
      await supabase.from("conversations").update({ welcome_sent_at: null }).eq("id", conversationId);
      log.error("bienvenida_rechazada_por_meta", { conversationId, codigo: metaErrorCode(err) ?? err.status });
    } else {
      // Fallo de red, timeout, o el insert de la fila de mensaje: no hay
      // forma de saber si la plantilla salió. Misma doctrina que
      // turn-delivery.ts — ante la duda se da por salido, así que el sello
      // se queda puesto.
      log.error("bienvenida_fallo_ambiguo", { conversationId, detalle: errorText(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// T3.4: salud del número y estado de plantillas.
//
// `message_template_status_update`, `phone_number_quality_update` y
// `account_update` viajan por el mismo webhook de la WABA que `messages`,
// pero -- a diferencia de `messages` -- ninguno trae
// `metadata.phone_number_id`: los dos últimos traen un número de teléfono en
// texto libre (`display_phone_number`/`phone_number`), que Meta a veces
// formatea distinto al que se guardó al registrar el canal (con o sin '+',
// con espacios); el primero no trae número en absoluto, porque una
// plantilla es de la cuenta de negocio (WABA), no de un número puntual.
// ---------------------------------------------------------------------------

/** Solo dígitos, para comparar números de teléfono sin depender del formato. */
function soloDigitos(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/**
 * Resuelve a qué canal pertenece un evento de calidad/cuenta: primero por
 * coincidencia de dígitos contra `whatsapp_channels.phone_number`, y si no
 * hay coincidencia -- o el evento no trae número, como pasa siempre con
 * `message_template_status_update`, que no llega hasta acá -- por el único
 * canal `connected`. Null si no hay ninguno de los dos.
 */
async function resolveHealthChannel(
  supabase: SupabaseClient,
  phoneNumberLike: string | null | undefined
): Promise<string | null> {
  const { data: rows } = await supabase.from("whatsapp_channels").select("id, phone_number, status");
  const channels = (rows as { id: string; phone_number: string; status: string }[] | null) ?? [];

  const digits = soloDigitos(phoneNumberLike);
  if (digits) {
    const match = channels.find((c) => soloDigitos(c.phone_number) === digits);
    if (match) return match.id;
  }

  const connected = channels.find((c) => c.status === "connected");
  return connected?.id ?? null;
}

/**
 * `phone_number_quality_update` no siempre manda un `quality_rating`
 * explícito (verificado contra la documentación de Meta, 5/9/2026: el campo
 * estable es `event` + `current_limit`). Cuando falta, se deriva del evento:
 * FLAGGED es la señal roja de verdad; UNFLAGGED/UPGRADE son la mejora;
 * DOWNGRADE es la advertencia intermedia.
 */
function deriveQualityRating(event: string | undefined): string | null {
  switch (event) {
    case "FLAGGED":
      return "RED";
    case "UNFLAGGED":
    case "UPGRADE":
      return "GREEN";
    case "DOWNGRADE":
      return "YELLOW";
    default:
      return null;
  }
}

async function handleQualityUpdate(supabase: SupabaseClient, value: WebhookQualityValue): Promise<void> {
  const channelId = await resolveHealthChannel(supabase, value.display_phone_number);
  if (!channelId) {
    log.warn("calidad_numero_sin_canal", { telefono: value.display_phone_number ?? null });
    return;
  }

  const qualityRating = value.quality_rating ?? deriveQualityRating(value.event);

  const { error } = await supabase
    .from("whatsapp_channels")
    .update({
      quality_rating: qualityRating,
      messaging_limit: value.current_limit ?? null,
      health_updated_at: new Date().toISOString(),
    })
    .eq("id", channelId);

  if (error) {
    console.error("Webhook de WhatsApp: error al guardar la calidad del número", error);
    return;
  }

  // FLAGGED es Meta avisando que el número está en riesgo de perder límite de
  // mensajería o de ser restringido; RED es la misma señal ya resuelta a
  // rating. Se registra en error porque es exactamente lo que hace que un
  // número dejé de entregar sin que nadie lo note hasta el reclamo de un
  // cliente.
  if (value.event === "FLAGGED" || qualityRating === "RED") {
    log.error("calidad_numero_degradada", {
      canalId: channelId,
      evento: value.event ?? null,
      calidad: qualityRating,
      limite: value.current_limit ?? null,
    });
  }
}

async function handleAccountUpdate(supabase: SupabaseClient, value: WebhookAccountUpdateValue): Promise<void> {
  const channelId = await resolveHealthChannel(supabase, value.phone_number);
  if (!channelId) {
    log.warn("cuenta_whatsapp_sin_canal", { telefono: value.phone_number ?? null });
    return;
  }

  const hayRestriccion = Boolean(value.ban_info || value.restriction_info?.length);
  const accountRestrictions = hayRestriccion
    ? { ban_info: value.ban_info ?? null, restriction_info: value.restriction_info ?? null }
    : null;

  const { error } = await supabase
    .from("whatsapp_channels")
    .update({
      account_restrictions: accountRestrictions,
      health_updated_at: new Date().toISOString(),
    })
    .eq("id", channelId);

  if (error) {
    console.error("Webhook de WhatsApp: error al guardar la restricción de cuenta", error);
    return;
  }

  // VERIFIED_ACCOUNT es la única noticia buena de este evento; el resto
  // (restricción, violación, deshabilitada) es justo lo que un asesor no
  // puede ver por ningún otro lado hasta que el número deja de enviar.
  if (value.event && value.event !== "VERIFIED_ACCOUNT") {
    log.error("cuenta_whatsapp_restringida", { canalId: channelId, evento: value.event });
  }
}

/**
 * Mapea el `event` de Meta al valor cerrado que admite `templates.status`
 * (CHECK ampliado en 20260905060000 para admitir 'paused'/'disabled', que
 * antes de esta migración no existían). `PENDING_DELETION`/`IN_APPEAL`/
 * `DELETED` no tienen un estado propio a propósito: mientras se apela o se
 * borra, la plantilla sigue mostrando el último estado real que sí importa
 * para decidir si se puede enviar (aprobada/pausada/rechazada/deshabilitada).
 */
function mapTemplateStatus(event: string | undefined): string | null {
  switch (event) {
    case "APPROVED":
      return "approved";
    case "PENDING":
      return "pending";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "DISABLED":
      return "disabled";
    default:
      return null;
  }
}

async function handleTemplateStatusUpdate(
  supabase: SupabaseClient,
  value: WebhookTemplateStatusValue
): Promise<void> {
  const { message_template_name: name, message_template_language: language, event, reason } = value;
  if (!name || !language) return;

  const status = mapTemplateStatus(event);
  if (!status) {
    log.info("plantilla_evento_sin_mapeo", { name, language, evento: event ?? null });
    return;
  }

  const { error } = await supabase.from("templates").update({ status }).eq("name", name).eq("language", language);

  if (error) {
    console.error("Webhook de WhatsApp: error al actualizar el estado de la plantilla", error);
    return;
  }

  // Pausada, deshabilitada o rechazada son las tres formas en las que una
  // plantilla deja de poder enviarse -- y sin este aviso, el primer síntoma
  // era un envío rechazado por Meta con un código que no dice "tu plantilla
  // se cayó", sino un 132001/132012 genérico.
  if (status === "paused" || status === "disabled" || status === "rejected") {
    log.error("plantilla_estado_degradado", { name, language, evento: event ?? null, motivo: reason ?? null });
  }
}

// ---------------------------------------------------------------------------
// `type: "system"`: el cliente cambió de número de WhatsApp (u otro evento de
// sistema que Meta avisa sin que el cliente haya escrito nada).
//
// Plan "El cliente que cambió de número" (6/9/2026), decisiones del operador:
//   D1 — el contacto sigue al número nuevo. Conversación, historial, pines,
//        pedido y bitácora cuelgan de `contact_id`, así que mover solo
//        `contacts.phone_number` alcanza sin tocar nada más.
//   D2 — si el número nuevo ya tiene contacto, no se fusiona nada: fusionar
//        dos historiales es una decisión de persona. Queda dicho en el
//        evento y en `log.error("webhook_cambio_numero_conflicto")`.
//   D3 — (atendido en la rama `unsupported`, no acá).
//   D4 — la frase del 131026 (`meta-client.ts`) manda al asesor a este aviso.
// ---------------------------------------------------------------------------

/**
 * `phoneNumberViejo` es el número con el que YA existe (o no) contacto y
 * conversación en el CRM -- lo resuelve el llamador desde `message.from`
 * antes de saber si hace falta algo más. Sin contacto o sin conversación
 * para ese número no hay nada que mover: un cambio de número de alguien que
 * nunca escribió no crea nada, queda solo en el log
 * (`webhook_system_sin_conversacion`).
 */
async function handleSystemMessage(
  supabase: SupabaseClient,
  channel: WelcomeChannel,
  phoneNumberViejo: string,
  system: NonNullable<WebhookMessage["system"]>,
  whatsappMessageId: string
): Promise<void> {
  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("phone_number", phoneNumberViejo)
    .maybeSingle<{ id: string }>();

  if (!contact) {
    log.info("webhook_system_sin_conversacion", {
      whatsappMessageId,
      motivo: "sin_contacto",
      tipo: system.type ?? null,
    });
    return;
  }

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("contact_id", contact.id)
    .eq("whatsapp_channel_id", channel.id)
    .maybeSingle<{ id: string }>();

  if (!conversation) {
    log.info("webhook_system_sin_conversacion", {
      whatsappMessageId,
      motivo: "sin_conversacion",
      tipo: system.type ?? null,
    });
    return;
  }

  const conversationId = conversation.id;

  // Un `wa_id`/`new_wa_id` que no resulta ser un teléfono válido se trata
  // como un `system.type` desconocido (supuesto del orquestador, 6/9/2026):
  // no hay a dónde mover el contacto.
  const nuevo =
    system.type === "user_changed_number" ? phoneNumberFromWaId(system.wa_id ?? system.new_wa_id) : null;

  if (nuevo) {
    const { data: contactoExistente } = await supabase
      .from("contacts")
      .select("id")
      .eq("phone_number", nuevo)
      .maybeSingle<{ id: string }>();

    let conflictoConId = contactoExistente?.id ?? null;
    let contactoMovido = false;

    if (!contactoExistente) {
      const { error: updateError } = await supabase
        .from("contacts")
        .update({ phone_number: nuevo })
        .eq("id", contact.id);

      if (!updateError) {
        contactoMovido = true;
      } else if (updateError.code === "23505") {
        // D2: otro webhook ganó la carrera y ya movió a alguien más a este
        // número entre el SELECT de arriba y este UPDATE -- se relee para
        // dejar el id correcto en la bitácora.
        const { data: ganador } = await supabase
          .from("contacts")
          .select("id")
          .eq("phone_number", nuevo)
          .maybeSingle<{ id: string }>();
        conflictoConId = ganador?.id ?? null;
      } else {
        // No debería pasar -- 23505 es el único error esperable en este
        // UPDATE puntual -- pero uno inesperado tampoco puede perder el
        // aviso: se deja sin mover (más seguro que fingir un movimiento sin
        // confirmar) y queda registrado aparte del conflicto de verdad.
        log.error("webhook_cambio_numero_error", { conversationId, detalle: errorText(updateError) });
      }
    }

    const conflicto = !contactoMovido;
    const content = conflicto
      ? `El cliente cambió su número de WhatsApp a ${nuevo}, que ya tiene conversación en el CRM`
      : `El cliente cambió su número de WhatsApp a ${nuevo}`;

    if (conflicto) {
      log.error("webhook_cambio_numero_conflicto", {
        conversationId,
        previo: phoneNumberViejo,
        nuevo,
        contactoExistenteId: conflictoConId,
      });
    }

    const { error: insertError } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        direction: "outbound",
        sender_type: "system",
        message_type: "system_event",
        content,
        payload: {
          type: "system",
          systemType: "user_changed_number",
          previousPhone: phoneNumberViejo,
          newPhone: nuevo,
        } as Json,
      })
      .select("id")
      .single();

    if (insertError) {
      log.error("webhook_system_evento_no_guardado", { conversationId, detalle: errorText(insertError) });
    }

    log.info("webhook_cliente_cambio_numero", {
      conversationId,
      previo: phoneNumberViejo,
      nuevo,
      contactoMovido,
    });
    return;
  }

  // `customer_identity_changed`, un `system.type` nuevo que todavía no se
  // atiende puntual, o `user_changed_number` con un número que no resultó
  // válido: se deja el aviso en el hilo, sin tocar ningún dato.
  const content = system.body ? `WhatsApp avisó: ${system.body}` : "WhatsApp envió un aviso de sistema";

  const { error: insertError } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      direction: "outbound",
      sender_type: "system",
      message_type: "system_event",
      content,
      payload: { type: "system", systemType: system.type ?? null } as Json,
    })
    .select("id")
    .single();

  if (insertError) {
    log.error("webhook_system_evento_no_guardado", { conversationId, detalle: errorText(insertError) });
  }

  log.info("webhook_system_evento_desconocido", { conversationId, tipo: system.type ?? null });
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
      log.error("webhook_firma_invalida");
      return NextResponse.json({ error: "Firma inválida." }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // Sin secreto no hay forma de distinguir un evento de Meta de uno que
    // mandó cualquiera que conozca la URL. En producción eso no puede
    // quedar abierto porque alguien olvidó definir una variable: se
    // rechaza y queda registrado, en vez de procesar mensajes inventados
    // que le harían responder a la IA y consumir cuota del modelo.
    log.error("webhook_sin_secreto_en_produccion");
    return NextResponse.json({ error: "Webhook mal configurado." }, { status: 503 });
  } else {
    log.warn("webhook_sin_verificacion_de_firma");
  }

  const body = JSON.parse(rawBody) as WebhookBody;
  const supabase = createAdminClient();

  // Freno de avalancha. Se responde 200 igual que en el camino normal: un
  // 429 haría que Meta reintente el mismo lote, que es justo lo contrario de
  // lo que se busca. El evento se descarta y queda el registro.
  const { data: allowed } = await supabase.rpc("rate_limit_allow", {
    p_bucket: "whatsapp-webhook",
    p_limit: WEBHOOK_RATE_LIMIT,
    p_window_seconds: WEBHOOK_RATE_WINDOW_SECONDS,
  });

  if (allowed === false) {
    log.warn("webhook_limitado", { limite: WEBHOOK_RATE_LIMIT, ventanaSegundos: WEBHOOK_RATE_WINDOW_SECONDS });
    return NextResponse.json({ ok: true, throttled: true });
  }
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  /**
   * Conversaciones que recibieron un mensaje en este lote, con la ventana de
   * silencio que le toca a cada una.
   *
   * El valor es el del ÚLTIMO mensaje del lote para esa conversación: si el
   * cliente arrancó con "buenas" y cerró con la pregunta completa, lo que vale
   * es cómo terminó la ráfaga, no cómo empezó.
   */
  const touchedByCustomer = new Map<string, number>();
  const mediaDownloadTasks: (() => Promise<void>)[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // T3.4: los otros tres `field` de la WABA (salud del número y estado
      // de plantillas). No traen mensajes de cliente: se atienden aparte y
      // no entran al resto del bucle, que sigue siendo el camino de
      // 'messages'.
      if (change.field === "message_template_status_update") {
        await handleTemplateStatusUpdate(supabase, change.value as unknown as WebhookTemplateStatusValue);
        continue;
      }
      if (change.field === "phone_number_quality_update") {
        await handleQualityUpdate(supabase, change.value as unknown as WebhookQualityValue);
        continue;
      }
      if (change.field === "account_update") {
        await handleAccountUpdate(supabase, change.value as unknown as WebhookAccountUpdateValue);
        continue;
      }

      if (change.field !== "messages") continue;
      const value = change.value;

      // Errores de cuenta que Meta manda sueltos en el `value` (distintos de
      // los que van dentro de un mensaje o de un estado puntual). Antes no se
      // miraban en absoluto: quedaban en el JSON crudo del webhook, que nadie
      // lee salvo que ya sospeche que algo falló.
      for (const errorDeValue of value.errors ?? []) {
        log.error("webhook_error_meta", {
          codigo: errorDeValue.code,
          detalle: errorDeValue.message ?? errorDeValue.title ?? null,
        });
      }

      for (const status of value.statuses ?? []) {
        const fallo = status.status === "failed" ? status.errors?.[0] : undefined;
        // Se limpian cuando el estado no es 'failed': si un mensaje llegara a
        // remontar, un motivo viejo colgado debajo sería peor que ninguno.
        const { data: afectados, error: statusUpdateError } = await supabase
          .from("messages")
          .update({
            whatsapp_status: status.status,
            whatsapp_error_code: fallo?.code ?? null,
            whatsapp_error_detail: fallo ? metaFailureText(fallo) : null,
          })
          .eq("whatsapp_message_id", status.id)
          .select("id, conversation_id");

        if (statusUpdateError) {
          // Antes este `error` se tiraba en silencio: un fallo acá (por
          // ejemplo el trigger que impide retroceder el doble check) no
          // frenaba el webhook, pero tampoco quedaba ningún rastro de que
          // el estado de un mensaje no se pudo actualizar.
          log.error("webhook_error_actualizar_estado", {
            whatsappMessageId: status.id,
            detalle: errorText(statusUpdateError),
          });
        }

        if (fallo) {
          // Este era el registro que faltaba: el fallo de entrega sólo existía
          // como una columna con la palabra 'failed'. Para diagnosticarlo había
          // que llegar por la base de datos.
          log.error("mensaje_no_entregado", {
            whatsappMessageId: status.id,
            conversationId: afectados?.[0]?.conversation_id ?? null,
            codigo: fallo.code,
            detalle: metaFailureText(fallo),
          });
        }
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
        // `unsupported` no es algo que el cliente haya escrito: es Meta
        // avisando de que hay algo que su API no sabe representar. Llega,
        // entre otros casos, junto a las fotos cuando el cliente manda
        // varias de una vez — y ahí las fotos vienen en el mismo lote y se
        // guardan perfectamente, así que el aviso no aporta nada.
        //
        // Guardarlo ponía en el chat una burbuja con jerga ("[unsupported]
        // Tipo de mensaje no soportado todavía") que el asesor no sabe qué
        // hacer con ella, y que además se mete entre las fotos y le parte la
        // galería. Queda en el log del servidor, que es donde sirve.
        // Una reacción no es un mensaje: es algo que le pasa a un mensaje que
        // ya está en el hilo. Meta la manda como evento aparte, diciendo a
        // cuál reacciona y con qué emoji, así que se guarda pegada a esa fila
        // en vez de abrir una burbuja nueva — igual que se ve en WhatsApp.
        //
        // El emoji vacío es cómo Meta dice que la quitaron: vuelve a null.
        if (message.type === "reaction" && message.reaction) {
          const emoji = message.reaction.emoji?.trim() || null;
          const { error: reactionError } = await supabase
            .from("messages")
            .update({ reaction_emoji: emoji })
            .eq("whatsapp_message_id", message.reaction.message_id);

          if (reactionError) {
            console.error("Webhook de WhatsApp: error al guardar la reacción", reactionError);
          }
          // No se encola turno de IA: reaccionar con un pulgar no es una
          // pregunta que haya que contestar.
          continue;
        }

        if (message.type === "unsupported") {
          const motivo = message.errors?.[0];
          console.info(
            `Webhook de WhatsApp: Meta marcó el mensaje ${message.id} como no representable` +
              (motivo ? ` (${motivo.code}: ${motivo.title ?? "sin título"})` : "") +
              ". No se guarda: no es contenido del cliente."
          );
          continue;
        }

        // Un remitente que no es un teléfono no entra. Esta línea era
        // `const phoneNumber = \`+${message.from}\`` y con `from` ausente
        // producía la cadena '+undefined', que se guardaba como si fuera un
        // número: un chat que se ve, que se abre y al que es imposible
        // entregarle nada. Uno de 1.197 contactos quedó así.
        //
        // Se descarta el mensaje en vez de inventarle una identidad al
        // remitente. Un contacto en este CRM ES un teléfono de WhatsApp —de
        // ahí cuelgan la conversación, el envío y la ventana de 24 h— y
        // sostener a medias uno que no lo es produce justo lo que se está
        // arreglando: un chat sin salida que el asesor descubre reintentando.
        //
        // El registro lleva el identificador crudo. No es PII: se llega acá
        // precisamente porque no es un teléfono, y sin él la próxima vez habría
        // que volver a decodificar wamids a mano para saber qué pasó.
        const phoneNumber = phoneNumberFromWaId(message.from);
        if (!phoneNumber) {
          log.error("webhook_remitente_sin_telefono", {
            whatsappMessageId: message.id,
            tipo: message.type,
            remitente: message.from ?? null,
          });
          continue;
        }

        // El cliente cambió de número de WhatsApp (u otro aviso de sistema
        // sin texto de cliente detrás). Entra ANTES del upsert de contacto:
        // este mensaje no crea nada nuevo, solo mueve o anota sobre lo que ya
        // existe con el número VIEJO (`phoneNumber`, recién validado arriba).
        // Ver handleSystemMessage.
        if (message.type === "system") {
          await handleSystemMessage(supabase, channel, phoneNumber, message.system ?? {}, message.id);
          continue;
        }

        const profileName = value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name ?? null;

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
          .select("id, last_customer_message_at, status, ai_enabled, assigned_agent_id, referral")
          .eq("contact_id", contact.id)
          .eq("whatsapp_channel_id", channel.id)
          .maybeSingle<{
            id: string;
            last_customer_message_at: string | null;
            status: string;
            ai_enabled: boolean;
            assigned_agent_id: string | null;
            referral: unknown;
          }>();

        if (existingConversation) {
          conversationId = existingConversation.id;
          windowWasClosed = !isWithin24hWindow(existingConversation.last_customer_message_at);

          // T2.1 (5/9/2026): un asesor había cerrado este chat y el cliente
          // volvió a escribir. Antes esto se guardaba igual, pero la fila
          // seguía en `status = 'closed'` -- invisible para "Pendientes"
          // (status <> 'closed') y para cualquier otra píldora que descuente
          // lo cerrado -- así que el mensaje entraba al hilo sin que nadie se
          // enterara de que hacía falta contestar. Se reabre ANTES del
          // insert de más abajo, para que ese mensaje ya caiga sobre una
          // conversación abierta.
          if (existingConversation.status === "closed") {
            const { error: reopenError } = await supabase
              .from("conversations")
              .update({ status: "open" })
              .eq("id", conversationId);

            if (reopenError) {
              console.error(
                "Webhook de WhatsApp: error al reabrir conversación cerrada",
                reopenError
              );
            } else {
              await supabase
                .from("messages")
                .insert({
                  conversation_id: conversationId,
                  direction: "outbound",
                  sender_type: "system",
                  message_type: "system_event",
                  content: "El cliente volvió a escribir",
                })
                .select("id")
                .single();

              // La IA sigue en el estado en que quedó al cerrar el chat: el
              // sistema no la reactiva sola. Anexo A2 (5/9/2026): si la IA
              // seguía encendida, vuelve a ella (`ai`, como siempre); si no,
              // pero el chat YA tenía asesor (`assigned_agent_id`), la
              // conversación es SUYA -- se le devuelve con `human` + su id,
              // no `unassigned` -- porque ese es el estado normal tras una
              // escalación o un cierre manual, y decir "sin dueño" ahí era
              // mentira de la bitácora, no una decisión. Solo sin ninguna de
              // las dos cosas queda de verdad sin dueño. `recordHandoff`
              // nunca lanza, así que esto no arriesga la respuesta al webhook.
              await recordHandoff(supabase, {
                conversationId,
                ...(existingConversation.ai_enabled
                  ? { toKind: "ai" }
                  : existingConversation.assigned_agent_id
                    ? { toKind: "human", toId: existingConversation.assigned_agent_id }
                    : { toKind: "unassigned" }),
                reason: "reabierta_por_cliente",
              });
            }
          }
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

        // El anuncio "Click to WhatsApp" del que vino esta conversación
        // (message.referral, distinto de context.referred_product más abajo:
        // ese es un producto puntual, esto es el anuncio en general). Meta lo
        // manda en el mensaje que origina el hilo. Se guarda en la
        // conversación, no en el mensaje, porque el banner de la cabecera del
        // chat necesita mostrarlo aunque el asesor esté viendo un mensaje
        // posterior. El guardado es a lo sumo una vez por conversación
        // (`existingConversation?.referral` ya puesto corta el resto): sin
        // esa guarda, una reentrega de Meta (entrega "at-least-once") o un
        // segundo mensaje del mismo lote con el mismo `referral` volvería a
        // insertar el evento de sistema.
        if (message.referral && !existingConversation?.referral) {
          const referral = {
            sourceUrl: message.referral.source_url ?? null,
            sourceType: message.referral.source_type ?? null,
            sourceId: message.referral.source_id ?? null,
            headline: message.referral.headline ?? null,
            body: message.referral.body ?? null,
            mediaType: message.referral.media_type ?? null,
            imageUrl: message.referral.image_url ?? null,
            videoUrl: message.referral.video_url ?? null,
            ctwaClid: message.referral.ctwa_clid ?? null,
            receivedAt: new Date().toISOString(),
          };

          const { error: referralError } = await supabase
            .from("conversations")
            .update({ referral })
            .eq("id", conversationId);

          if (referralError) {
            console.error("Webhook de WhatsApp: error al guardar el referral del anuncio", referralError);
          } else {
            await supabase
              .from("messages")
              .insert({
                conversation_id: conversationId,
                direction: "outbound",
                sender_type: "system",
                message_type: "system_event",
                content: `Llegó desde el anuncio "${referral.headline ?? referral.sourceUrl ?? "sin título"}"`,
              })
              .select("id")
              .single();
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
        /**
         * Lo que el cliente TECLEÓ, que no siempre es `content`.
         *
         * De acá sale la ventana de silencio, y la diferencia importa: el texto
         * con el que el CRM representa una ubicación compartida lo escribimos
         * nosotros, así que mirarlo para adivinar si el cliente terminó de
         * escribir no dice nada. Sin texto propio se espera la ventana larga.
         */
        let customerText: string | null = null;
        /**
         * Datos crudos del tipo de mensaje que no tienen columna propia (T3.2,
         * 20260905050000): qué botón/ítem respondió, el payload de la
         * plantilla, los ítems de un pedido, o el tipo real de Meta cuando
         * `messageType` cae a 'unsupported'.
         */
        let payload: Record<string, unknown> | null = null;

        if (message.type === "text") {
          content = message.text?.body ?? "";
          customerText = content;
        } else if ((MEDIA_TYPES as readonly string[]).includes(message.type)) {
          messageType = message.type;
          const mediaObject = message[message.type as MediaType];
          content = mediaObject?.caption ?? null;
          customerText = content;
          pendingMediaId = mediaObject?.id ?? null;
        } else if (message.type === "location" && message.location) {
          content = describirUbicacion(message.location);
        } else if (message.type === "contacts" && message.contacts?.length) {
          content = describirContactos(message.contacts);
        } else if (message.type === "interactive" && message.interactive) {
          // Respuesta a un botón o a un ítem de lista de un mensaje
          // interactivo que le mandamos. `id`/`title` son del botón o de la
          // fila de la lista, según cuál haya venido.
          const reply =
            message.interactive.type === "list_reply"
              ? message.interactive.list_reply
              : message.interactive.button_reply;
          if (reply) {
            messageType = "interactive";
            content = `Respondió: ${reply.title}`;
            customerText = reply.title;
            payload = { type: message.interactive.type, id: reply.id };
          } else {
            messageType = "unsupported";
            payload = { type: message.type };
          }
        } else if (message.type === "button" && message.button) {
          // Respuesta al botón rápido de una PLANTILLA (distinto del botón de
          // un mensaje interactivo): mismo tratamiento en el chat, pero el
          // payload que trae es el configurado en la plantilla, no un id de
          // Meta -- se guarda aparte para no confundir los dos orígenes.
          messageType = "interactive";
          content = `Respondió: ${message.button.text}`;
          customerText = message.button.text;
          payload = { type: "button", template: message.button.payload };
        } else if (message.type === "order" && message.order) {
          messageType = "order";
          content = describirPedido(message.order);
          customerText = message.order.text ?? null;
          payload = {
            catalogId: message.order.catalog_id,
            productItems: message.order.product_items,
          };
        } else {
          // Queda algo que el CRM todavía no sabe pintar —una encuesta, un
          // mensaje de un tipo nuevo que Meta agregó—. Antes esto se
          // guardaba con una frase fija en `content`; ahora `content` queda
          // null y el tipo real de Meta va en `payload.type` (F10), sin
          // inventar prosa sobre algo que no se entiende. El asesor tiene el
          // mismo chat en su teléfono.
          messageType = "unsupported";
          payload = { type: message.type };
        }

        // Un anuncio "Click to WhatsApp" que referenciaba un producto
        // puntual del catálogo (distinto de message.referral, que es el
        // anuncio en general y ya se atendió arriba, a nivel de
        // conversación). Se funde con el payload que ya se haya calculado
        // para este mensaje, sea cual sea su tipo.
        if (message.context?.referred_product) {
          payload = {
            ...(payload ?? {}),
            referredProduct: {
              catalogId: message.context.referred_product.catalog_id,
              productRetailerId: message.context.referred_product.product_retailer_id,
            },
          };
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
            payload: payload as Json | null,
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
                .from(MEDIA_BUCKET)
                .upload(path, bytes, { contentType: mimeType, upsert: true });

              if (uploadError) {
                console.error("Webhook de WhatsApp: error al subir media a Storage", uploadError);
                return;
              }

              await supabase.from("messages").update({ media_url: mediaUrlFor(path) }).eq("id", messageDbId);
            } catch (err) {
              console.error("Webhook de WhatsApp: error al descargar media de Meta", err);
            }
          });
        }

        touchedByCustomer.set(conversationId, debounceSecondsFor(customerText));

        // La decisión de si ya se saludó es de la base (claimWelcome sobre
        // welcome_sent_at), no de la memoria de esta invocación: así una
        // sola bienvenida sobrevive tanto a varios mensajes del cliente en
        // el mismo lote como a dos invocaciones concurrentes del webhook
        // (29/8/2026).
        if (windowWasClosed) await sendWelcome(supabase, channel, conversationId, phoneNumber, accessToken);
      }
    }
  }

  // La descarga de media también corre después de responder a Meta —mismo
  // motivo que el turno de IA: un archivo pesado no debe arriesgar el
  // timeout del webhook (~20s), que dispararía un reintento de Meta.
  if (mediaDownloadTasks.length > 0) {
    after(() => Promise.allSettled(mediaDownloadTasks.map((task) => task())));
  }

  // El turno se encola ANTES de responder a Meta y se procesa después: el
  // webhook sigue siendo rápido, pero si el proceso muere a mitad del turno
  // la conversación queda pendiente en la cola en vez de perderse. Una tanda
  // con varios mensajes del mismo cliente deja un solo pendiente.
  if (touchedByCustomer.size > 0) {
    // Con la IA apagada no se encola. Antes se encolaba igual y los turnos se
    // reclamaban para salir por la puerta de atrás de runAgentTurn: trabajo
    // invisible, y una cola que crecía mientras el dueño creía tener la IA
    // parada. Se pregunta una vez por lote, no una por conversación.
    const { data: canRun } = await supabase.rpc("agent_can_run");
    if (!canRun) {
      log.info("webhook_no_encola_ia_apagada", { conversaciones: touchedByCustomer.size });

      // El mensaje ya quedó guardado arriba, pero sin turno nadie queda a
      // cargo de estas conversaciones: se deja la fila que dice que el
      // sistema soltó esto y por qué, en vez de que el lead desaparezca sin
      // rastro. `recordHandoff` nunca lanza, así que no hace falta try/catch
      // acá ni arriesga la respuesta rápida a Meta.
      //
      // Razón única `agente_no_puede_correr` a propósito: `agent_can_run()`
      // ya fusiona en un solo booleano "IA apagada globalmente" y "tope de
      // gasto del día alcanzado" (ver 20260822010000_ai_daily_spend_cap.sql);
      // separarlas acá exigiría otra consulta en este camino caliente.
      await Promise.all(
        [...touchedByCustomer.keys()].map((conversationId) =>
          recordHandoff(supabase, {
            conversationId,
            toKind: "unassigned",
            reason: "agente_no_puede_correr",
          })
        )
      );

      return NextResponse.json({ ok: true });
    }

    // Se espera la ventana de silencio antes de atender: Meta manda un POST
    // por mensaje, y sin esperar el cliente recibiría una respuesta por
    // frase, cada una sin el contexto de las siguientes.
    //
    // Las dos ventanas se encolan y se drenan por separado. Una sola pasada
    // no sirve: si esperara la corta, las de la ventana larga todavía no
    // habrían vencido y se quedarían para el cron —cinco minutos— y si
    // esperara la larga, las cortas habrían perdido justo lo que se les
    // ahorró. Ver debounceSecondsFor.
    //
    // A cada pasada se le pasa el tamaño de SU grupo: entre las dos drenan
    // como mucho lo que este webhook encoló, que es lo que evita que un
    // mensaje entrante se lleve por delante el atraso de otros.
    const porVentana = new Map<number, string[]>();
    for (const [conversationId, ventana] of touchedByCustomer) {
      const grupo = porVentana.get(ventana);
      if (grupo) grupo.push(conversationId);
      else porVentana.set(ventana, [conversationId]);
    }

    for (const [ventana, conversaciones] of porVentana) {
      await enqueueAgentTurns(conversaciones, { debounceSeconds: ventana });
      after(() => processAfterDebounce(conversaciones.length, ventana));
    }
  }

  return NextResponse.json({ ok: true });
}
