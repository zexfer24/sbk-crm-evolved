import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Playbook } from "@/lib/types";
import type { TurnTarget } from "@/lib/ai/turn-target";
import { MetaApiError, metaErrorCode, sendWhatsappMedia, sendWhatsappText } from "@/lib/whatsapp/meta-client";
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
 *
 * Exportado desde T0.3: `sendAgentText`/`sendAgentMedia` ya no devuelven
 * `Promise<void>` — el turno (agent.ts) necesita mirar `whatsapp_status` para
 * registrar el traspaso `rechazado_por_meta` cuando Meta rechaza un envío que
 * ya pasó todas las guardas de `deliver()`. Antes ese rechazo quedaba escrito
 * en `messages` pero el turno seguía como si hubiera respondido: la
 * conversación quedaba sin dueño en la bitácora aunque el cliente no
 * hubiera recibido nada.
 *
 * `origenDelFallo` (S6, corrida "La IA ve lo que llega", hallazgo 4 del
 * plan, 8/9/2026): el corte de red de OpenRouter del 7/9 a las 11:57 UTC dejó
 * dos `ia_envio_fallido` con `detalle: "fetch failed"` — un `TypeError` de
 * `fetch`, no una respuesta de Meta — y `agent.ts` los trató igual que un
 * rechazo real de la Graph API, escribiendo `rechazado_por_meta`. Un corte de
 * red no es un rechazo: Meta nunca llegó a ver el mensaje. `entregar()` lo
 * distingue por el TIPO de excepción, no por si trae código: `MetaApiError`
 * significa que Meta SÍ respondió por HTTP (con o sin `code` numérico en el
 * cuerpo — un 5xx sin código sigue siendo una respuesta de Meta); cualquier
 * otra excepción (`fetch failed`, DNS, timeout, abortado) nunca tocó la Graph
 * API. `null` cuando no hubo fallo (`whatsapp_status` "sent" o no se intentó
 * nada). NO es columna de `messages` — ver `columnasDeEntrega`.
 */
export interface DeliveryOutcome {
  whatsapp_message_id: string | null;
  whatsapp_status: "sent" | "failed" | null;
  whatsapp_error_code: number | null;
  whatsapp_error_detail: string | null;
  origenDelFallo: "meta" | "red" | null;
}

/** Canal simulado: no se intentó nada, así que no hay ni éxito ni fallo que contar. */
const NO_ENVIADO: DeliveryOutcome = {
  whatsapp_message_id: null,
  whatsapp_status: null,
  whatsapp_error_code: null,
  whatsapp_error_detail: null,
  origenDelFallo: null,
};

/**
 * Las cuatro columnas de `messages` que describen una entrega, y NADA más.
 *
 * Antes de S6 los dos inserts hacían `...entrega`: esparcir el objeto entero
 * funcionaba mientras `DeliveryOutcome` tuviera exactamente esas cuatro
 * claves. Sumarle `origenDelFallo` (que no es columna — la tabla no la tiene)
 * habría roto el insert si se siguiera esparciendo tal cual. Este helper es
 * la lista explícita que hace ese acoplamiento imposible de romper por
 * accidente la próxima vez que `DeliveryOutcome` gane un campo.
 */
function columnasDeEntrega(entrega: DeliveryOutcome) {
  return {
    whatsapp_message_id: entrega.whatsapp_message_id,
    whatsapp_status: entrega.whatsapp_status,
    whatsapp_error_code: entrega.whatsapp_error_code,
    whatsapp_error_detail: entrega.whatsapp_error_detail,
  };
}

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
      origenDelFallo: null,
    };
  } catch (err) {
    // Meta respondió (con o sin código): rechazo de verdad. Cualquier otra
    // excepción nunca llegó a la Graph API — es un fallo de red, no un
    // rechazo de Meta (hallazgo 4, corte de OpenRouter del 7/9/2026).
    const origen: "meta" | "red" = err instanceof MetaApiError ? "meta" : "red";
    log.error("ia_envio_fallido", {
      conversationId: target.conversationId,
      codigo: metaErrorCode(err),
      detalle: errorText(err),
      origen,
    });
    return {
      whatsapp_message_id: null,
      whatsapp_status: "failed",
      whatsapp_error_code: metaErrorCode(err),
      whatsapp_error_detail: errorText(err),
      origenDelFallo: origen,
    };
  }
}

/** Opciones de `sendAgentText`, todas opcionales para no romper a los llamadores existentes. */
export interface SendAgentTextOptions {
  /**
   * El mensaje es un automatismo, no una respuesta real (anexo A1, 5/9/2026):
   * misma marca que ya lleva la plantilla de bienvenida (T0.1). Hoy la usa la
   * despedida de la IA al escalar sin asesores — "ya dejé tu caso
   * registrado…" no es que alguien haya atendido al cliente, y el trigger
   * `handle_new_message` la respeta para no apagar `last_reply_at`/
   * `awaiting_reply`. Default `false`: cualquier otro texto del agente sigue
   * contando como respuesta real, como siempre.
   */
  isAutoReply?: boolean;
}

export async function sendAgentText(
  supabase: SupabaseClient<Database>,
  target: TurnTarget,
  text: string,
  opciones?: SendAgentTextOptions
): Promise<DeliveryOutcome> {
  const entrega = await entregar(target, (accessToken) =>
    sendWhatsappText(target.phoneNumberId!, accessToken, target.phoneNumber, text)
  );

  await supabase.from("messages").insert({
    conversation_id: target.conversationId,
    direction: "outbound",
    sender_type: "ai",
    message_type: "text",
    content: text,
    is_auto_reply: opciones?.isAutoReply ?? false,
    ...columnasDeEntrega(entrega),
  });

  return entrega;
}

async function sendAgentMedia(
  supabase: SupabaseClient<Database>,
  target: TurnTarget,
  mediaType: MediaKind,
  url: string
): Promise<DeliveryOutcome> {
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
    ...columnasDeEntrega(entrega),
  });

  return entrega;
}

/**
 * El texto que un escenario le pone delante al cliente, tal como sale.
 *
 * Vive aparte del envío porque hay un segundo lector: el turno lo compara
 * contra su última respuesta para no mandar dos veces el mismo escenario (ver
 * `alreadySentPlaybook` en agent.ts). Componer el enlace en dos sitios era
 * exactamente la forma de que esa comparación dejara de reconocer su propio
 * mensaje el día que uno de los dos cambiara.
 *
 * Un adjunto `link` se anexa al texto en vez de mandarse como archivo:
 * Meta solo puede adjuntar URLs que apunten directo a un archivo público, y
 * los catálogos suelen ser páginas web o carpetas compartidas.
 */
export function playbookMessageText(playbook: Playbook): string {
  const { attachmentUrl, attachmentType } = playbook;
  return attachmentType === "link" && attachmentUrl
    ? `${playbook.responseText}\n\n${attachmentUrl}`
    : playbook.responseText;
}

/**
 * Envía la respuesta de un escenario: el texto **tal cual está guardado**,
 * y el adjunto si lo tiene.
 *
 * Devuelve el `DeliveryOutcome` del TEXTO, no del adjunto (T0.3): el texto es
 * la respuesta propiamente dicha — si Meta la rechaza, el turno tiene que
 * enterarse y registrar el traspaso. El adjunto que falla ya se loguea aparte
 * dentro de `entregar()` y no deja al cliente sin respuesta (el texto salió
 * antes), así que no vale la pena complicar el tipo de retorno con los dos.
 */
export async function sendPlaybookReply(
  supabase: SupabaseClient<Database>,
  target: TurnTarget,
  playbook: Playbook
): Promise<DeliveryOutcome> {
  const { attachmentUrl, attachmentType } = playbook;

  const entrega = await sendAgentText(supabase, target, playbookMessageText(playbook));

  if (attachmentUrl && attachmentType && attachmentType !== "link") {
    await sendAgentMedia(supabase, target, attachmentType, attachmentUrl);
  }

  return entrega;
}
