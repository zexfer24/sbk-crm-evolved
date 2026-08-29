import type { SupabaseClient } from "@supabase/supabase-js";
import { orExpression, pgrstLiteral } from "@/lib/ai/pgrst";
import { conversationsWrittenByHumans } from "@/lib/ai/human-handled";
import { freeformWindowCutoff, isTicketTag } from "@/lib/dashboard";
import type { ConversationCursor } from "@/lib/inbox-paging";
import { CRM_TIME_ZONE, currentDayRange } from "@/lib/time-zone";
import { failureReason } from "@/lib/whatsapp/failure-reason";
import type {
  Agent,
  AgentMetrics,
  AgentRef,
  AgentSettings,
  AgentSuggestion,
  AgentTool,
  AgentTurn,
  BoardConversation,
  Contact,
  ContactName,
  ContactSummary,
  Conversation,
  ConversationQuote,
  ConversationSummary,
  HourlyActivity,
  KnowledgeCategory,
  KnowledgeEntry,
  Message,
  ModelPricing,
  ModelUsageSummary,
  Note,
  Playbook,
  QuickReply,
  Sale,
  Tag,
  TicketTagsByContact,
  TokenUsageDay,
  TokenUsageSummary,
  WhatsappChannel,
  WhatsappTemplate,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Formas crudas de fila devueltas por Supabase (reflejan el `select` usado
// más abajo). Se reemplazará por los tipos generados (`database.types.ts`)
// cuando el schema esté estable en producción.
// ---------------------------------------------------------------------------

interface RawAgent {
  id: string;
  display_name: string;
  full_name: string | null;
  avatar_url: string | null;
  role: Agent["role"];
  is_active: boolean;
}

interface RawTag {
  id: string;
  label: string;
  color: Tag["color"];
}

export interface RawContact {
  id: string;
  phone_number: string;
  display_name: string | null;
  profile_name: string | null;
  avatar_url: string | null;
  cedula_type: Contact["cedulaType"];
  cedula_number: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  contact_tags: { tag: RawTag }[] | null;
}

interface RawChannel {
  id: string;
  label: string;
  phone_number: string;
  phone_number_id: string | null;
  status: WhatsappChannel["status"];
}

interface RawAgentRef {
  id: string;
  display_name: string;
}

interface RawContactName {
  id: string;
  phone_number: string;
  display_name: string | null;
  profile_name: string | null;
}

export interface RawContactSummary extends RawContactName {
  avatar_url: string | null;
  contact_tags: { tag: RawTag }[] | null;
}

interface RawBoardConversation {
  id: string;
  status: Conversation["status"];
  unread_count: number;
  manually_unread: boolean;
  ai_enabled: boolean;
  deal_status: Conversation["dealStatus"];
  deal_verified: boolean;
  last_customer_message_at: string | null;
  last_message_at: string | null;
  has_reply: boolean;
  created_at: string;
  journey_stage: Conversation["journeyStage"];
  intent: string | null;
  active_tool: string | null;
  welcome_sent_at: string | null;
  contact: RawContactName;
  assigned_agent: RawAgentRef | null;
}

interface RawConversationSummary extends RawBoardConversation {
  last_message_preview: string | null;
  last_message_direction: Conversation["lastMessageDirection"];
  last_message_status: Conversation["lastMessageStatus"];
  contact: RawContactSummary;
}

interface RawSale {
  id: string;
  deal_status: Conversation["dealStatus"];
  deal_closed_at: string | null;
  deal_payment_proof_url: string | null;
  deal_verified: boolean;
  deal_verified_at: string | null;
  deal_payment_method: Conversation["dealPaymentMethod"];
  created_at: string;
  order: { total_amount: number; currency: string } | null;
  contact: RawContact;
  deal_verified_by: RawAgentRef | null;
  deal_closed_by: RawAgentRef | null;
}

interface RawConversation {
  id: string;
  status: Conversation["status"];
  unread_count: number;
  manually_unread: boolean;
  ai_enabled: boolean;
  deal_status: Conversation["dealStatus"];
  deal_closed_at: string | null;
  deal_payment_proof_url: string | null;
  order: { total_amount: number; currency: string } | null;
  deal_verified: boolean;
  deal_verified_at: string | null;
  deal_verified_by: RawAgent | null;
  deal_payment_method: Conversation["dealPaymentMethod"];
  deal_closed_by: RawAgent | null;
  last_customer_message_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_direction: Conversation["lastMessageDirection"];
  last_message_status: Conversation["lastMessageStatus"];
  has_reply: boolean;
  created_at: string;
  journey_stage: Conversation["journeyStage"];
  intent: string | null;
  active_tool: string | null;
  welcome_sent_at: string | null;
  contact: RawContact;
  channel: RawChannel;
  assigned_agent: RawAgent | null;
}

interface RawMessage {
  id: string;
  conversation_id: string;
  direction: Message["direction"];
  sender_type: Message["senderType"];
  message_type: Message["messageType"];
  content: string | null;
  template_name: string | null;
  media_url: string | null;
  is_internal_note: boolean;
  whatsapp_status: Message["whatsappStatus"];
  whatsapp_error_code: number | null;
  whatsapp_error_detail: string | null;
  reaction_emoji: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  sender_agent: RawAgent | null;
}

interface RawQuickReply {
  id: string;
  label: string;
  content: string;
}

interface RawHourlyActivity {
  hour: number | string;
  inbound: number | string;
  ai: number | string;
  agent: number | string;
}

interface RawNote {
  id: string;
  contact_id: string;
  content: string;
  created_at: string;
  agent: RawAgent | null;
}

interface RawConversationQuote {
  id: string;
  product_id: string | null;
  product_name: string;
  price_usd: number;
  price_bs: number;
  bcv_rate: number;
  quoted_at: string;
}

interface RawTemplate {
  id: string;
  name: string;
  language: string;
  category: WhatsappTemplate["category"];
  body_preview: string;
  status: WhatsappTemplate["status"];
}

// ---------------------------------------------------------------------------
// Mappers: fila cruda -> tipo de dominio
// ---------------------------------------------------------------------------

function mapAgent(row: RawAgent | null): Agent | null {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    fullName: row.full_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    isActive: row.is_active,
  };
}

function mapTag(row: RawTag): Tag {
  return { id: row.id, label: row.label, color: row.color };
}

export function mapContact(row: RawContact): Contact {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    displayName: row.display_name,
    profileName: row.profile_name,
    avatarUrl: row.avatar_url,
    cedulaType: row.cedula_type,
    cedulaNumber: row.cedula_number,
    state: row.state,
    city: row.city,
    address: row.address,
    tags: (row.contact_tags ?? []).map((ct) => mapTag(ct.tag)),
  };
}

function mapAgentRef(row: RawAgentRef | null): AgentRef | null {
  if (!row) return null;
  return { id: row.id, displayName: row.display_name };
}

function mapContactName(row: RawContactName): ContactName {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    displayName: row.display_name,
    profileName: row.profile_name,
  };
}

export function mapContactSummary(row: RawContactSummary): ContactSummary {
  return {
    ...mapContactName(row),
    avatarUrl: row.avatar_url,
    tags: (row.contact_tags ?? []).map((ct) => mapTag(ct.tag)),
  };
}

function mapBoardConversation(row: RawBoardConversation): BoardConversation {
  return {
    id: row.id,
    contact: mapContactName(row.contact),
    status: row.status,
    unreadCount: row.unread_count,
    manuallyUnread: row.manually_unread,
    assignedAgent: mapAgentRef(row.assigned_agent),
    aiEnabled: row.ai_enabled,
    dealStatus: row.deal_status,
    dealVerified: row.deal_verified,
    lastCustomerMessageAt: row.last_customer_message_at,
    lastMessageAt: row.last_message_at,
    hasReply: row.has_reply,
    createdAt: row.created_at,
    journeyStage: row.journey_stage,
    intent: row.intent,
    activeTool: row.active_tool,
    welcomeSentAt: row.welcome_sent_at,
  };
}

function mapConversationSummary(row: RawConversationSummary): ConversationSummary {
  return {
    ...mapBoardConversation(row),
    contact: mapContactSummary(row.contact),
    lastMessagePreview: row.last_message_preview,
    lastMessageDirection: row.last_message_direction,
    lastMessageStatus: row.last_message_status,
  };
}

function mapSale(row: RawSale): Sale {
  return {
    id: row.id,
    contact: mapContact(row.contact),
    dealStatus: row.deal_status,
    dealClosedAt: row.deal_closed_at,
    dealPaymentProofUrl: row.deal_payment_proof_url,
    dealAmount: row.order?.total_amount ?? null,
    dealCurrency: row.order?.currency ?? null,
    dealVerified: row.deal_verified,
    dealVerifiedAt: row.deal_verified_at,
    dealVerifiedBy: mapAgentRef(row.deal_verified_by),
    dealPaymentMethod: row.deal_payment_method,
    dealClosedBy: mapAgentRef(row.deal_closed_by),
    createdAt: row.created_at,
  };
}

function mapChannel(row: RawChannel): WhatsappChannel {
  return {
    id: row.id,
    label: row.label,
    phoneNumber: row.phone_number,
    phoneNumberId: row.phone_number_id,
    status: row.status,
  };
}

function mapConversation(row: RawConversation): Conversation {
  return {
    id: row.id,
    contact: mapContact(row.contact),
    channel: mapChannel(row.channel),
    status: row.status,
    unreadCount: row.unread_count,
    manuallyUnread: row.manually_unread,
    assignedAgent: mapAgent(row.assigned_agent),
    aiEnabled: row.ai_enabled,
    dealStatus: row.deal_status,
    dealClosedAt: row.deal_closed_at,
    dealPaymentProofUrl: row.deal_payment_proof_url,
    dealAmount: row.order?.total_amount ?? null,
    dealCurrency: row.order?.currency ?? null,
    dealVerified: row.deal_verified,
    dealVerifiedAt: row.deal_verified_at,
    dealVerifiedBy: mapAgent(row.deal_verified_by),
    dealPaymentMethod: row.deal_payment_method,
    dealClosedBy: mapAgent(row.deal_closed_by),
    lastCustomerMessageAt: row.last_customer_message_at,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lastMessageDirection: row.last_message_direction,
    lastMessageStatus: row.last_message_status,
    hasReply: row.has_reply,
    createdAt: row.created_at,
    journeyStage: row.journey_stage,
    intent: row.intent,
    activeTool: row.active_tool,
    welcomeSentAt: row.welcome_sent_at,
  };
}

function mapMessage(row: RawMessage): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    senderType: row.sender_type,
    senderAgent: mapAgent(row.sender_agent),
    messageType: row.message_type,
    content: row.content,
    templateName: row.template_name,
    mediaUrl: row.media_url,
    isInternalNote: row.is_internal_note,
    whatsappStatus: row.whatsapp_status,
    whatsappError: failureReason(row.whatsapp_error_code, row.whatsapp_error_detail),
    reactionEmoji: row.reaction_emoji,
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
  };
}

function mapQuickReply(row: RawQuickReply): QuickReply {
  return { id: row.id, label: row.label, content: row.content };
}

function mapNote(row: RawNote): Note {
  return {
    id: row.id,
    contactId: row.contact_id,
    agent: mapAgent(row.agent),
    content: row.content,
    createdAt: row.created_at,
  };
}

function mapConversationQuote(row: RawConversationQuote): ConversationQuote {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    priceUsd: row.price_usd,
    priceBs: row.price_bs,
    bcvRate: row.bcv_rate,
    quotedAt: row.quoted_at,
  };
}

function mapTemplate(row: RawTemplate): WhatsappTemplate {
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    category: row.category,
    bodyPreview: row.body_preview,
    status: row.status,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Lo común a toda fila de lista. El select completo
 * (`CONVERSATION_DETAIL_SELECT`) arrastraba siete relaciones por fila —235 KB
 * medidos en una lista de 200— para paneles que solo se abren de a una
 * conversación.
 */
const CONVERSATION_BOARD_COLUMNS = `
  id, status, unread_count, manually_unread, ai_enabled, deal_status, deal_verified,
  last_customer_message_at, last_message_at, has_reply, created_at,
  journey_stage, intent, active_tool, welcome_sent_at
`;

/**
 * La fila del tablero y de Control de IA. Un solo embebido, y plano.
 *
 * Esas vistas piden todo el trabajo abierto de una vez para contar por etapa
 * y por asesor, así que cada campo se paga cientos de veces. Fuera quedan la
 * vista previa del último mensaje (el campo más gordo, y ninguna de las dos
 * lo pinta), el estado de entrega, el avatar y —sobre todo— las etiquetas
 * del contacto: `contact_tags(tag:tags(...))` es una relación anidada que
 * PostgREST resuelve con un lateral por fila. Los reclamos llegan por
 * `fetchTicketTags`, que son dos consultas planas y chicas.
 */
const CONVERSATION_BOARD_SELECT = `
  ${CONVERSATION_BOARD_COLUMNS},
  contact:contacts(id, phone_number, display_name, profile_name),
  assigned_agent:agents!conversations_assigned_agent_id_fkey(id, display_name)
`;

/** La fila de la bandeja: la del tablero más lo que pinta una línea de chat. */
const CONVERSATION_LIST_SELECT = `
  ${CONVERSATION_BOARD_COLUMNS},
  last_message_preview, last_message_direction, last_message_status,
  contact:contacts(id, phone_number, display_name, profile_name, avatar_url,
    contact_tags(tag:tags(id, label, color))),
  assigned_agent:agents!conversations_assigned_agent_id_fkey(id, display_name)
`;

/** La conversación entera, para el chat abierto: canal, ficha del contacto y venta. */
const CONVERSATION_DETAIL_SELECT = `
  id, status, unread_count, manually_unread, ai_enabled, deal_status, deal_closed_at,
  deal_payment_proof_url, deal_verified, deal_verified_at, deal_payment_method,
  last_customer_message_at, last_message_at, last_message_preview,
  last_message_direction, last_message_status, has_reply, created_at,
  journey_stage, intent, active_tool, welcome_sent_at,
  order:orders(total_amount, currency),
  contact:contacts(id, phone_number, display_name, profile_name, avatar_url,
    cedula_type, cedula_number, state, city, address,
    contact_tags(tag:tags(id, label, color))),
  channel:whatsapp_channels(id, label, phone_number, phone_number_id, status),
  assigned_agent:agents!conversations_assigned_agent_id_fkey(id, display_name, full_name, avatar_url, role, is_active),
  deal_verified_by:agents!conversations_deal_verified_by_fkey(id, display_name, full_name, avatar_url, role, is_active),
  deal_closed_by:agents!conversations_deal_closed_by_fkey(id, display_name, full_name, avatar_url, role, is_active)
`;

// Mismo tope de filas que en `fetchMessages`, por el mismo motivo: sin
// `.range()`, PostgREST corta la respuesta al llegar a su límite y devuelve
// `error: null`. La bandeja se vería normal, sin las conversaciones más
// viejas y sin nada que delatara la pérdida.
export const CONVERSATIONS_PAGE_SIZE = 1000;

/**
 * Cuántas conversaciones carga la bandeja por tirada: lo que entra en
 * pantalla y un poco más. Al llegar al fondo se pide la siguiente tanda; lo
 * que quede más atrás también se encuentra por la búsqueda, que consulta
 * contra la base y no contra lo que ya está en pantalla.
 */
export const INBOX_PAGE_SIZE = 30;

/** Las dos columnas del orden de la bandeja, en la fila CRUDA. */
interface CursorableRow {
  id: string;
  last_message_at: string | null;
}

/**
 * El cursor que retoma DESPUÉS de esta fila. Gemelo crudo de
 * `cursorAfterPage` (src/lib/inbox-paging.ts): los dos deben dar el mismo
 * valor para la misma fila, y lo hacen porque el timestamp viaja como el
 * string crudo de Supabase — pasarlo por `Date` pierde microsegundos y
 * rompe el desempate por igualdad exacta.
 */
function cursorFromRow(row: CursorableRow): ConversationCursor {
  return { lastMessageAt: row.last_message_at, id: row.id };
}

export interface FetchConversationsOptions {
  /**
   * Cuántas conversaciones traer, de la más reciente hacia atrás.
   *
   * Sin tope se recorre lo que el filtro deje pasar, así que toda llamada
   * sin `limit` debe acotar por otro lado: `activeOnly` (el trabajo vivo,
   * que no crece con el histórico), `unassignedOnly`/`awaitingReplyOnly`
   * (subconjuntos suyos, más chicos todavía) o `contactIds`/`ids` (una lista
   * concreta).
   */
  limit?: number;
  /**
   * Desde dónde retomar: la última fila de la última página recibida
   * (`cursorAfterPage`, `src/lib/inbox-paging.ts`). Reemplaza a un `offset`
   * de posición (retirado el 29/8/2026): un cursor de posición se rompe
   * apenas una fila cruza el borde de página mientras alguien sigue bajando
   * la lista —sube al tope y corre a todas las de abajo una posición— y la
   * página siguiente, pedida por número de fila, salta justo la que cruzó.
   * Confirmado en producción: la píldora "Todos" reordenaba ~3 veces/minuto
   * y esas filas no volvían nunca (`mergeById`, en `src/lib/inbox-paging.ts`,
   * deduplica lo que llega; no recupera lo que jamás se pidió). El cursor
   * por valor no depende de la posición: pide "lo que sigue después de esta
   * fila, en este orden", así que un reordenamiento en el medio no le afecta.
   *
   * Solo gobierna la PRIMERA página interna de `fetchConversationRows`: de
   * ahí en más lo reemplaza el cursor de continuación (`cursorFromRow`,
   * calculado con la última fila de cada página interna) — el mismo
   * problema de posición que resolvió esto en la carga entre páginas
   * EXTERNAS (`crm-shell.tsx`) también existía puertas adentro, en el
   * recorrido de `>1000` filas del tablero y Control de IA (29/8/2026).
   */
  cursor?: ConversationCursor;
  /** Solo lo que no está cerrado: el tablero y el roster miran el trabajo vivo. */
  activeOnly?: boolean;
  /** Solo las que no tiene nadie: el trabajo libre, disponible para agarrar. */
  unassignedOnly?: boolean;
  /**
   * Solo aquellas cuyo último mensaje sigue siendo del cliente.
   *
   * Se apoya en la columna generada `awaiting_reply`: la condición compara dos
   * columnas de la misma fila y PostgREST solo filtra contra literales.
   */
  awaitingReplyOnly?: boolean;
  /**
   * Solo aquellas donde nunca salió una respuesta.
   *
   * Se apoya en `has_reply` (migración 20260827020000), una columna
   * vitalicia: una vez en `true` no vuelve a `false`, así que no distingue
   * "hace falta responder ahora" de "alguna vez se respondió" — un chat
   * contestado hace meses la sigue teniendo en `true` aunque hoy esté
   * esperando de nuevo. Por eso NO sirve como corte de "sin atender": ese fue
   * el plan de la entrega 2 (segmentar la píldora por `has_reply`), y
   * probarlo así vació la píldora en producción el 28/8/2026. La decisión de
   * ese día reemplazó esa entrega por la partición en `buildInboxSections`
   * (src/lib/inbox-sections.ts), que corta por la ventana de 24 h de Meta —
   * un corte de tiempo, no de historial.
   *
   * La opción se conserva como herramienta disponible; hoy ningún filtro de
   * la bandeja la usa (ver `inbox-filters.ts`).
   */
  neverRepliedOnly?: boolean;
  /**
   * Corta el subconjunto "pendiente" (pensado para usarse junto a
   * `awaitingReplyOnly`) por la ventana de 24 h de WhatsApp: `"fresh"` trae
   * lo que sigue dentro (se le puede escribir texto libre ahora mismo),
   * `"stale"` lo que ya se salió.
   *
   * Alimentaba la sección "Esperando +24 h" de `inbox-sections.ts`, que la
   * reforma de píldoras Todos/No leídas/Mías retira de la bandeja. La opción
   * queda igual que `neverRepliedOnly`: documentada y viva para quien la
   * necesite (`pendingStale` de `InboxCounts` la sigue usando para el panel
   * de inicio), sin consumidor propio en la bandeja.
   *
   * Mismo corte que `freeformWindowCutoff`/`withinFreeformWindow`
   * (src/lib/dashboard.ts) y mismo operador estricto que usa
   * `fetchBacklogCounts` más abajo: `gt` para "dentro", todo lo demás para
   * "fuera". En el instante exacto del corte `withinFreeformWindow` ya
   * devuelve `false`, así que ese instante tiene que caer del lado de
   * `"stale"` y no repetirse en los dos lados.
   *
   * `"stale"` incluye además `last_customer_message_at is null`: sin fecha
   * del cliente no hay ventana abierta, mismo criterio de "fallar cerrado"
   * que usan `withinFreeformWindow` y la partición de `buildInboxSections`.
   * En la práctica no debería darse para filas con `awaiting_reply` en
   * `true` — la columna generada exige `last_customer_message_at is not
   * null` — pero la opción es genérica y no asume que siempre se combine con
   * `awaitingReplyOnly`.
   */
  pendingWindow?: "fresh" | "stale";
  /**
   * Instante contra el que se calcula el corte de `pendingWindow`. Por
   * defecto `Date.now()`; existe para que los tests puedan fijarlo, igual que
   * en `fetchBacklogConversationIds`/`fetchBacklogCounts`.
   */
  now?: number;
  /** Solo las conversaciones de estos contactos (los reclamos, una búsqueda). */
  contactIds?: string[];
  /** Solo estas conversaciones (las coincidencias de la búsqueda por mensaje). */
  ids?: string[];
  /**
   * Solo lo que tiene algo sin leer: `unread_count > 0 OR manually_unread` —
   * la misma definición de `isUnread` que usa el frontend. Sin condición de
   * estado a propósito, igual que `assignedTo`: una conversación CERRADA con
   * mensajes sin leer sigue sin leer, así que la píldora "No leídas" también
   * la muestra.
   */
  unreadOnly?: boolean;
  /**
   * Solo las asignadas a este perfil: la píldora "Mías". Sin condición de
   * estado a propósito — es cola y archivo personal a la vez, paridad con
   * `counts.mine` y con el corte que ya vivía en memoria antes de esta
   * entrega.
   */
  assignedTo?: string;
}

/**
 * El recorrido de páginas, común a las dos formas de fila. Devuelve las filas
 * crudas para que cada llamador las mapee con lo que pidió.
 *
 * El recorrido INTERNO (las llamadas sin `limit`: tablero y Control de IA
 * vía `fetchBoardConversations`, y cualquier `fetchConversations` que junte
 * más de `CONVERSATIONS_PAGE_SIZE` filas) también avanza por cursor desde el
 * 29/8/2026: cada página interna pide `range(0, pageSize-1)` con el
 * predicado armado desde la última fila de la página anterior
 * (`cursorFromRow`), no un `range(rows.length, …)` posicional. Ese `from`
 * contaba posiciones sobre un conjunto que se movía entre peticiones — si
 * una fila SALÍA del conjunto (un chat que se cierra con `activeOnly`) entre
 * dos páginas internas, la fila que quedaba justo en el borde no la pedía
 * ninguna página: pérdida silenciosa, sin error.
 */
async function fetchConversationRows<Raw extends CursorableRow>(
  supabase: SupabaseClient,
  select: string,
  {
    limit,
    cursor,
    activeOnly,
    unassignedOnly,
    awaitingReplyOnly,
    neverRepliedOnly,
    pendingWindow,
    now,
    contactIds,
    ids,
    unreadOnly,
    assignedTo,
  }: FetchConversationsOptions
): Promise<Raw[]> {
  // `.in()` con lista vacía no es una consulta válida en PostgREST, y acá
  // además significa «nada que buscar»: no hay filas que devolver.
  if ((contactIds && contactIds.length === 0) || (ids && ids.length === 0)) return [];

  // Se calcula una sola vez, antes de paginar: recalcularlo en cada vuelta
  // del `for` movería el corte mientras la bandeja todavía está bajando
  // páginas, y una fila podría quedar "fresh" en una página y "stale" en la
  // siguiente.
  const pendingWindowCutoff = pendingWindow ? freeformWindowCutoff(now) : undefined;

  const rows: Raw[] = [];

  // El cursor de ENTRADA (`options.cursor`) gobierna solo la primera vuelta
  // de este `for`. De ahí en más lo REEMPLAZA el de continuación (calculado
  // al final de cada vuelta, con la última fila de esa página): es un punto
  // más abajo en el mismo orden total, no uno adicional — sumar los dos
  // cursores multiplicaría los términos del `.or()` sin cambiar el conjunto
  // que describen.
  let pageCursor = cursor;

  for (;;) {
    // Con tope pedido, la última página se recorta para no traer de más.
    const pageSize = limit
      ? Math.min(CONVERSATIONS_PAGE_SIZE, limit - rows.length)
      : CONVERSATIONS_PAGE_SIZE;

    // Orden canónico de la bandeja: `last_message_at desc nulls last`, y
    // `id desc` como desempate. Sin el segundo `.order()` el empate queda
    // arbitrario para PostgREST — confirmado contra la base real: hay 3
    // empates de `last_message_at` en 1.851 filas (29/8/2026) — y un cursor
    // que solo mira `last_message_at` podría repetir o saltar cualquiera de
    // esas filas empatadas entre una página y la siguiente.
    let request = supabase
      .from("conversations")
      .select(select)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false });

    if (activeOnly) request = request.neq("status", "closed");
    if (unassignedOnly) request = request.is("assigned_agent_id", null);
    if (awaitingReplyOnly) request = request.eq("awaiting_reply", true);
    if (neverRepliedOnly) request = request.eq("has_reply", false);
    if (pendingWindow === "fresh") {
      request = request.gt("last_customer_message_at", pendingWindowCutoff!);
    }
    if (contactIds) request = request.in("contact_id", contactIds);
    if (ids) request = request.in("id", ids);
    if (assignedTo) request = request.eq("assigned_agent_id", assignedTo);

    // PostgREST junta con AND los parámetros repetidos de forma poco
    // predecible: dos `.or()` en la misma consulta no son fiables
    // (`orExpression`, src/lib/ai/pgrst.ts). `pendingWindow: "stale"`,
    // `unreadOnly` y el cursor son disyunciones propias; se acumulan acá y
    // se emiten juntas en una sola llamada.
    const orGroups: string[][] = [];

    if (pendingWindow === "stale") {
      // `last_customer_message_at is null` cae acá: sin fecha del cliente no
      // hay ventana abierta (fallar cerrado), mismo criterio que
      // `withinFreeformWindow` y `buildInboxSections` (inbox-sections.ts).
      orGroups.push([
        `last_customer_message_at.lte.${pendingWindowCutoff}`,
        "last_customer_message_at.is.null",
      ]);
    }
    if (unreadOnly) orGroups.push(["unread_count.gt.0", "manually_unread.is.true"]);

    if (pageCursor) {
      const idLiteral = pgrstLiteral(pageCursor.id);
      if (pageCursor.lastMessageAt !== null) {
        const dateLiteral = pgrstLiteral(pageCursor.lastMessageAt);
        // Verificado contra PostgREST local el 29/8/2026: filas con
        // `last_message_at` estrictamente menor, o igual con `id` menor
        // (el desempate), o en la zona nula (que ordena al final y sería
        // inalcanzable desde cualquier página con cursor no-nulo si faltara
        // este tercer término).
        orGroups.push([
          `last_message_at.lt.${dateLiteral}`,
          `and(last_message_at.eq.${dateLiteral},id.lt.${idLiteral})`,
          "last_message_at.is.null",
        ]);
      } else {
        // El cursor ya está en la zona nula: lo que sigue es solo lo demás
        // sin fecha, desempatado por `id`.
        orGroups.push([`and(last_message_at.is.null,id.lt.${idLiteral})`]);
      }
    }

    if (orGroups.length > 0) request = request.or(orExpression(orGroups));

    // Siempre desde 0: lo que ya se entregó lo descarta el PREDICADO del
    // cursor, no una posición. Contar filas sobre un conjunto que se mueve
    // entre peticiones (`range(rows.length, …)`) era justo lo que perdía la
    // fila del borde cuando algo salía del conjunto activo a mitad de
    // camino. `pageSize` se sigue calculando igual arriba: el cursor
    // garantiza que las páginas no se solapan, así que el tope exacto
    // (`limit`) se preserva sin necesidad de contar posiciones.
    const { data, error } = await request.range(0, pageSize - 1);

    if (error) throw error;

    const page = (data as unknown as Raw[]) ?? [];
    rows.push(...page);

    // Página incompleta: no hay más filas que pedir.
    if (page.length < pageSize) break;
    if (limit && rows.length >= limit) break;

    // Solo se llega acá con la página COMPLETA (page.length === pageSize, y
    // pageSize >= 1): la última fila existe siempre, el cursor de
    // continuación no puede quedar nulo.
    pageCursor = cursorFromRow(page[page.length - 1]);
  }

  return rows;
}

export async function fetchConversations(
  supabase: SupabaseClient,
  options: FetchConversationsOptions = {}
): Promise<ConversationSummary[]> {
  const rows = await fetchConversationRows<RawConversationSummary>(
    supabase,
    CONVERSATION_LIST_SELECT,
    options
  );
  return rows.map(mapConversationSummary);
}

/** La misma consulta, con la fila liviana del tablero y de Control de IA. */
export async function fetchBoardConversations(
  supabase: SupabaseClient,
  options: FetchConversationsOptions = {}
): Promise<BoardConversation[]> {
  const rows = await fetchConversationRows<RawBoardConversation>(
    supabase,
    CONVERSATION_BOARD_SELECT,
    options
  );
  return rows.map(mapBoardConversation);
}

/**
 * Una sola fila de lista, por id.
 *
 * Es la contraparte de `fetchConversation` para las vistas que solo pintan
 * filas: cuando el evento de tiempo real trae un cambio que la fila no
 * resuelve sola —cambió el asesor asignado, se cerró la venta—, esto cuesta
 * ~1 KB en vez de volver a bajar la lista entera.
 */
export async function fetchConversationRow(
  supabase: SupabaseClient,
  conversationId: string
): Promise<ConversationSummary | null> {
  const { data, error } = await supabase
    .from("conversations")
    .select(CONVERSATION_LIST_SELECT)
    .eq("id", conversationId)
    .maybeSingle();

  if (error) throw error;
  return data ? mapConversationSummary(data as unknown as RawConversationSummary) : null;
}

/** La misma fila suelta, en la forma liviana del tablero. */
export async function fetchBoardConversationRow(
  supabase: SupabaseClient,
  conversationId: string
): Promise<BoardConversation | null> {
  const { data, error } = await supabase
    .from("conversations")
    .select(CONVERSATION_BOARD_SELECT)
    .eq("id", conversationId)
    .maybeSingle();

  if (error) throw error;
  return data ? mapBoardConversation(data as unknown as RawBoardConversation) : null;
}

export async function fetchConversation(
  supabase: SupabaseClient,
  conversationId: string
): Promise<Conversation | null> {
  const { data, error } = await supabase
    .from("conversations")
    .select(CONVERSATION_DETAIL_SELECT)
    .eq("id", conversationId)
    .maybeSingle();

  if (error) throw error;
  return data ? mapConversation(data as unknown as RawConversation) : null;
}

/**
 * Los contadores de las píldoras de la bandeja. Antes se contaban sobre la
 * lista cargada; con la bandeja paginada la lista es una ventana, y contar
 * sobre una ventana miente. Esto le pregunta a la base cuatro conteos sin
 * filas (`head: true`), que cuestan lo mismo con 600 conversaciones que con
 * 60.000.
 *
 * `pending`/`pendingStale` datan de la reforma del 28/8/2026 (píldoras
 * "Pendientes"/"Lo mío"/"Todos") y ya no tienen píldora propia en la
 * bandeja —la retiró la reforma siguiente, a Todos/No leídas/Mías—, pero
 * el panel de inicio los sigue usando: se conservan intactos. `unread` es
 * el conteo de esa reforma nueva, para la píldora "No leídas".
 */
export interface InboxCounts {
  /**
   * Total de la píldora "Pendientes" (panel de inicio): `awaiting_reply and
   * status <> 'closed'`, sin condición de asesor (a propósito — ver la
   * migración 20260828020000). Cuenta contra toda la base, no contra lo que
   * la bandeja tenga cargado.
   */
  pending: number;
  /** El subconjunto de `pending` que ya se salió de la ventana de 24 h de Meta (panel de inicio). */
  pendingStale: number;
  /** Asignadas al asesor que mira la pantalla: la píldora "Mías". */
  mine: number;
  /**
   * Total de la píldora "No leídas": mismo predicado OR que `unreadOnly` de
   * `FetchConversationsOptions` (`unread_count > 0 OR manually_unread`), sin
   * condición de estado a propósito — una conversación cerrada con mensajes
   * sin leer sigue contando.
   */
  unread: number;
}

export async function fetchInboxCounts(
  supabase: SupabaseClient,
  viewerId: string,
  now: number = Date.now()
): Promise<InboxCounts> {
  const cutoff = freeformWindowCutoff(now);
  const count = () =>
    supabase.from("conversations").select("id", { count: "exact", head: true });

  const [pending, pendingStale, mine, unread] = await Promise.all([
    count().eq("awaiting_reply", true).neq("status", "closed"),
    // Mismo predicado de "Pendientes" más el corte de ventana invertido, con
    // el mismo criterio de "fallar cerrado" que `withinFreeformWindow`: lo
    // sin fecha de cliente también cuenta como fuera de la ventana. En la
    // práctica `awaiting_reply` ya garantiza la fecha no nula (columna
    // generada), pero el filtro no depende de esa garantía.
    count()
      .eq("awaiting_reply", true)
      .neq("status", "closed")
      .or(`last_customer_message_at.lte.${cutoff},last_customer_message_at.is.null`),
    count().eq("assigned_agent_id", viewerId),
    // Al final del Promise.all para no correr los índices que ya usan los
    // tests de "pending"/"pendingStale"/"mine".
    count().or("unread_count.gt.0,manually_unread.is.true"),
  ]);

  const first = [pending, pendingStale, mine, unread].find((r) => r.error);
  if (first?.error) throw first.error;

  return {
    pending: pending.count ?? 0,
    pendingStale: pendingStale.count ?? 0,
    mine: mine.count ?? 0,
    unread: unread.count ?? 0,
  };
}

/** Tope de contactos que aporta la búsqueda por nombre o número. */
export const CONTACT_SEARCH_LIMIT = 40;

/**
 * Las conversaciones que responden a una búsqueda, estén o no cargadas en la
 * bandeja. Con la lista paginada, buscar solo sobre lo que está en pantalla
 * escondería justo lo que se busca: lo viejo. Se combinan los dos caminos
 * que ya existen —el contacto (nombre, número) acá y el contenido de los
 * mensajes vía `search_conversations_by_message`, cuyos ids llegan en
 * `messageHitIds`— y se devuelven como filas de lista normales.
 *
 * El nombre se compara como en la sección Clientes (`ilike` sin quitar
 * acentos): «jose» no encuentra a «José» si no está ya cargado en pantalla,
 * donde el filtro en memoria sí lo normaliza.
 */
export async function searchConversationSummaries(
  supabase: SupabaseClient,
  query: string,
  messageHitIds: string[]
): Promise<ConversationSummary[]> {
  const term = pgrstLiteral(`%${query}%`);

  const { data, error } = await supabase
    .from("contacts")
    .select("id")
    .or(`display_name.ilike.${term},profile_name.ilike.${term},phone_number.ilike.${term}`)
    .limit(CONTACT_SEARCH_LIMIT);

  if (error) throw error;
  const contactIds = ((data ?? []) as { id: string }[]).map((row) => row.id);

  const [byContact, byMessage] = await Promise.all([
    fetchConversations(supabase, { contactIds, limit: CONTACT_SEARCH_LIMIT }),
    fetchConversations(supabase, { ids: messageHitIds }),
  ]);

  const seen = new Set(byContact.map((c) => c.id));
  return [...byContact, ...byMessage.filter((c) => !seen.has(c.id))];
}

/**
 * Las ventas cerradas (ganadas o devueltas), más recientes primero.
 *
 * Es la consulta que la sección Ventas hacía al revés: pedía el histórico
 * completo de conversaciones para quedarse con las vendidas. El filtro ahora
 * es de la base, y la fila trae la ficha del contacto que el detalle de la
 * venta sí muestra — pero ni canal, ni etiquetas, ni nada de bandeja.
 */
const SALE_SELECT = `
  id, deal_status, deal_closed_at, deal_payment_proof_url, deal_verified,
  deal_verified_at, deal_payment_method, created_at,
  order:orders(total_amount, currency),
  contact:contacts(id, phone_number, display_name, profile_name, avatar_url,
    cedula_type, cedula_number, state, city, address),
  deal_verified_by:agents!conversations_deal_verified_by_fkey(id, display_name),
  deal_closed_by:agents!conversations_deal_closed_by_fkey(id, display_name)
`;

/**
 * Qué etiquetas de reclamo tiene cada contacto («Reclamo · …», ver
 * dashboard.ts).
 *
 * Dos consultas chicas y planas en vez de embeber `contact_tags(tag:tags())`
 * en cada fila del tablero: esa es una relación anidada que PostgREST
 * resuelve con un lateral por fila, y el tablero pide cientos. Acá el
 * catálogo de etiquetas tiene decenas de filas y los contactos con reclamo
 * son pocos. Es el mismo patrón de dos pasos que `fetchBuyerContactIds` en
 * la sección Clientes.
 *
 * El catálogo se trae entero y se filtra con `isTicketTag`, el mismo
 * criterio que usa la vista: un `ilike 'reclamo%'` en SQL no ignora los
 * acentos y se dejaría fuera una etiqueta escrita «Réclamo».
 */
export async function fetchTicketTags(supabase: SupabaseClient): Promise<TicketTagsByContact> {
  const { data: tagRows, error: tagError } = await supabase
    .from("tags")
    .select("id, label, color");

  if (tagError) throw tagError;

  const ticketTags = new Map(
    ((tagRows ?? []) as RawTag[]).map(mapTag).filter(isTicketTag).map((tag) => [tag.id, tag])
  );
  if (ticketTags.size === 0) return new Map();

  const { data: linkRows, error: linkError } = await supabase
    .from("contact_tags")
    .select("contact_id, tag_id")
    .in("tag_id", [...ticketTags.keys()]);

  if (linkError) throw linkError;

  const byContact = new Map<string, Tag[]>();
  for (const link of (linkRows ?? []) as { contact_id: string; tag_id: string }[]) {
    const tag = ticketTags.get(link.tag_id);
    if (!tag) continue;
    const current = byContact.get(link.contact_id);
    if (current) current.push(tag);
    else byContact.set(link.contact_id, [tag]);
  }

  return byContact;
}

export interface DashboardConversations {
  conversations: BoardConversation[];
  ticketTags: TicketTagsByContact;
}

/**
 * Lo que mira el tablero: el trabajo vivo (nada cerrado) más los reclamos,
 * abiertos o resueltos — la estadística de reclamos compara los dos. Ninguno
 * de los dos conjuntos crece con el histórico de conversaciones: uno es la
 * carga del día y el otro son contactos etiquetados a mano.
 */
export async function fetchDashboardConversations(
  supabase: SupabaseClient
): Promise<DashboardConversations> {
  const ticketTags = await fetchTicketTags(supabase);
  const ticketContactIds = [...ticketTags.keys()];

  const [active, tickets] = await Promise.all([
    fetchBoardConversations(supabase, { activeOnly: true }),
    fetchBoardConversations(supabase, { contactIds: ticketContactIds }),
  ]);

  const seen = new Set(active.map((c) => c.id));
  return {
    conversations: [...active, ...tickets.filter((c) => !seen.has(c.id))],
    ticketTags,
  };
}

export async function fetchSales(supabase: SupabaseClient): Promise<Sale[]> {
  const rows: RawSale[] = [];
  let from = 0;

  // Paginado por el mismo motivo que `fetchConversations`: PostgREST corta
  // en silencio. El día que las ventas pasen de mil, la sección pedirá
  // ventana propia; mientras tanto esto no las pierde.
  for (;;) {
    const { data, error } = await supabase
      .from("conversations")
      .select(SALE_SELECT)
      .in("deal_status", ["won", "returned"])
      .order("deal_closed_at", { ascending: false, nullsFirst: false })
      .range(from, from + CONVERSATIONS_PAGE_SIZE - 1);

    if (error) throw error;

    const page = (data as unknown as RawSale[]) ?? [];
    rows.push(...page);

    if (page.length < CONVERSATIONS_PAGE_SIZE) break;
    from += CONVERSATIONS_PAGE_SIZE;
  }

  return rows.map(mapSale);
}

// PostgREST (el API REST de Supabase) limita cada respuesta a un máximo de
// filas (1000 por defecto). Sin `.range()`, una conversación con más
// mensajes que ese límite se trunca en silencio (sin error). Paginamos
// explícitamente con este tamaño de página hasta agotar los resultados.
const MESSAGES_PAGE_SIZE = 1000;

const MESSAGE_SELECT = `id, conversation_id, direction, sender_type, message_type, content, template_name,
         media_url, is_internal_note, whatsapp_status, whatsapp_error_code, whatsapp_error_detail,
         reaction_emoji, reply_to_message_id, created_at,
         sender_agent:agents(id, display_name, full_name, avatar_url, role, is_active)`;

/**
 * Cuántos mensajes se pintan al abrir un chat.
 *
 * Abrir una conversación traía su historial completo: en un hilo viejo son
 * miles de filas que viajan al navegador cada vez que se hace clic, para
 * mostrar una pantalla que entra en pocas decenas. Lo anterior sigue estando
 * y se pide con `fetchMessagesBefore` al subir.
 */
export const CHAT_MESSAGES_WINDOW = 100;

export interface FetchMessagesOptions {
  /** Trae solo los últimos N mensajes, en orden cronológico. */
  limit?: number;
}

/**
 * Los últimos `limit` mensajes anteriores a `beforeCreatedAt`, en orden
 * cronológico. Es lo que permite acotar la ventana inicial sin esconderle
 * nada al asesor: el historial viejo se carga cuando lo pide.
 */
export async function fetchMessagesBefore(
  supabase: SupabaseClient,
  conversationId: string,
  beforeCreatedAt: string,
  limit: number = CHAT_MESSAGES_WINDOW
): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select(MESSAGE_SELECT)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .lt("created_at", beforeCreatedAt)
    .limit(limit);

  if (error) throw error;

  // Se piden DESCENDENTES —los más nuevos de ese tramo— y se invierten para
  // que la conversación se lea de arriba hacia abajo.
  return [...((data as unknown as RawMessage[]) ?? [])].reverse().map(mapMessage);
}

export async function fetchMessages(
  supabase: SupabaseClient,
  conversationId: string,
  options: FetchMessagesOptions = {}
): Promise<Message[]> {
  // Ventana: una sola consulta, sin recorrer el historial entero.
  if (options.limit) {
    const { data, error } = await supabase
      .from("messages")
      .select(MESSAGE_SELECT)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(options.limit);

    if (error) throw error;
    return [...((data as unknown as RawMessage[]) ?? [])].reverse().map(mapMessage);
  }

  const allRows: RawMessage[] = [];
  let from = 0;

  // El orden por `created_at` ya es estable para la paginación en la
  // práctica: `created_at` se asigna con `now()` al insertar y no se
  // repite entre mensajes de una misma conversación en este esquema. Si
  // en el futuro pudiera haber empates (p.ej. inserciones en lote con el
  // mismo timestamp), habría que añadir un desempate secundario por `id`
  // (que es un UUID, no ordenable de forma útil) o por una columna
  // secuencial dedicada para garantizar `.range()` consistente entre páginas.
  for (;;) {
    const to = from + MESSAGES_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("messages")
      .select(MESSAGE_SELECT)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .range(from, to);

    if (error) throw error;

    const page = (data as unknown as RawMessage[]) ?? [];
    allRows.push(...page);

    if (page.length < MESSAGES_PAGE_SIZE) break;
    from += MESSAGES_PAGE_SIZE;
  }

  return allRows.map(mapMessage);
}

export async function fetchNotes(supabase: SupabaseClient, contactId: string): Promise<Note[]> {
  const { data, error } = await supabase
    .from("notes")
    .select(
      `id, contact_id, content, created_at,
       agent:agents(id, display_name, full_name, avatar_url, role, is_active)`
    )
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data as unknown as RawNote[]).map(mapNote);
}

/** Cotizaciones reales que la IA le dio al cliente en esta conversación, más recientes primero. */
export async function fetchConversationQuotes(
  supabase: SupabaseClient,
  conversationId: string
): Promise<ConversationQuote[]> {
  const { data, error } = await supabase
    .from("conversation_quotes")
    .select("id, product_id, product_name, price_usd, price_bs, bcv_rate, quoted_at")
    .eq("conversation_id", conversationId)
    .order("quoted_at", { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data as RawConversationQuote[]).map(mapConversationQuote);
}

export async function fetchTemplates(
  supabase: SupabaseClient,
  channelId: string
): Promise<WhatsappTemplate[]> {
  const { data, error } = await supabase
    .from("templates")
    .select("id, name, language, category, body_preview, status")
    .eq("whatsapp_channel_id", channelId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data as RawTemplate[]).map(mapTemplate);
}

export async function fetchTags(supabase: SupabaseClient): Promise<Tag[]> {
  const { data, error } = await supabase.from("tags").select("id, label, color").order("label");
  if (error) throw error;
  return (data as RawTag[]).map(mapTag);
}

/**
 * Mensajes por hora de un día, ya agregados en la base de datos. Devuelve
 * siempre las 24 horas, con ceros donde no hubo movimiento, para que el
 * gráfico tenga el eje completo aunque el día vaya por la mitad.
 */
export async function fetchTodayActivity(
  supabase: SupabaseClient,
  timeZone: string = CRM_TIME_ZONE
): Promise<HourlyActivity[]> {
  const { from, to } = currentDayRange(timeZone);

  const { data, error } = await supabase.rpc("message_activity_by_hour", {
    from_ts: from.toISOString(),
    to_ts: to.toISOString(),
    tz: timeZone,
  });

  if (error) throw error;

  const byHour = new Map<number, HourlyActivity>();
  for (const row of (data ?? []) as RawHourlyActivity[]) {
    byHour.set(Number(row.hour), {
      hour: Number(row.hour),
      inbound: Number(row.inbound),
      ai: Number(row.ai),
      agent: Number(row.agent),
    });
  }

  return Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? { hour, inbound: 0, ai: 0, agent: 0 });
}

export async function fetchAgents(supabase: SupabaseClient): Promise<Agent[]> {
  const { data, error } = await supabase
    .from("agents")
    .select("id, display_name, full_name, avatar_url, role, is_active")
    .eq("is_active", true)
    .order("display_name");

  if (error) throw error;
  return (data as RawAgent[]).map((row) => mapAgent(row)!);
}

/** Roster completo (activos e inactivos) para la sección "Control de agentes". */
export async function fetchAllAgents(supabase: SupabaseClient): Promise<Agent[]> {
  const { data, error } = await supabase
    .from("agents")
    .select("id, display_name, full_name, avatar_url, role, is_active")
    .order("display_name");

  if (error) throw error;
  return (data as RawAgent[]).map((row) => mapAgent(row)!);
}

interface RawAgentMetrics {
  agent_id: string;
  mensajes_hoy: number;
  mensajes_periodo: number;
  conversaciones_hoy: number;
  conversaciones_periodo: number;
  ventas_hoy: number;
  ventas_periodo: number;
  monto_hoy: string | number;
  monto_periodo: string | number;
  verificadas_hoy: number;
  verificadas_periodo: number;
  primera_respuesta_mediana_seg: string | number | null;
}

/**
 * Rendimiento de cada persona del equipo. `days` define el período largo; el
 * dato de «hoy» siempre es el día en curso en hora de Caracas.
 */
export async function fetchAgentMetrics(supabase: SupabaseClient, days = 30): Promise<AgentMetrics[]> {
  const { data, error } = await supabase.rpc("agent_metrics", { p_days: days });
  if (error) throw error;

  // Postgres devuelve numeric como texto para no perder precisión.
  return (data as RawAgentMetrics[]).map((row) => ({
    agentId: row.agent_id,
    messagesToday: row.mensajes_hoy,
    messagesPeriod: row.mensajes_periodo,
    conversationsToday: row.conversaciones_hoy,
    conversationsPeriod: row.conversaciones_periodo,
    salesToday: row.ventas_hoy,
    salesPeriod: row.ventas_periodo,
    salesAmountToday: Number(row.monto_hoy),
    salesAmountPeriod: Number(row.monto_periodo),
    verifiedToday: row.verificadas_hoy,
    verifiedPeriod: row.verificadas_periodo,
    firstReplyMedianSeconds:
      row.primera_respuesta_mediana_seg === null ? null : Number(row.primera_respuesta_mediana_seg),
  }));
}

export async function fetchQuickReplies(supabase: SupabaseClient): Promise<QuickReply[]> {
  const { data, error } = await supabase
    .from("quick_replies")
    .select("id, label, content")
    .order("label");
  if (error) throw error;
  return (data as RawQuickReply[]).map(mapQuickReply);
}

interface RawAgentTurn {
  id: string;
  conversation_id: string;
  intent: AgentTurn["intent"];
  action: AgentTurn["action"];
  summary: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  playbook_id: string | null;
  customer_message: string | null;
  created_at: string;
  conversation: {
    contact: { display_name: string | null; profile_name: string | null; phone_number: string } | null;
  } | null;
}

// El nombre del contacto viaja con el turno: el feed lo mostraba buscando la
// conversación en la lista completa del CRM, que era justo la lista que había
// que dejar de cargar. Son 30 filas con tres campos, no un join caro.
const AGENT_TURN_COLUMNS = `id, conversation_id, intent, action, summary, model, input_tokens,
  output_tokens, total_tokens, playbook_id, customer_message, created_at,
  conversation:conversations(contact:contacts(display_name, profile_name, phone_number))`;

function mapAgentTurn(row: RawAgentTurn): AgentTurn {
  const contact = row.conversation?.contact ?? null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    contactName: contact ? contact.display_name ?? contact.profile_name ?? contact.phone_number : null,
    intent: row.intent,
    action: row.action,
    summary: row.summary,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    playbookId: row.playbook_id,
    customerMessage: row.customer_message,
    createdAt: row.created_at,
  };
}

/** Últimos turnos del agente de IA en todo el CRM, para el feed en vivo del panel de control. */
export async function fetchAgentTurns(supabase: SupabaseClient, limit = 30): Promise<AgentTurn[]> {
  const { data, error } = await supabase
    .from("agent_turns")
    .select(AGENT_TURN_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data as unknown as RawAgentTurn[]).map(mapAgentTurn);
}

interface RawPlaybook {
  id: string;
  name: string;
  trigger_description: string;
  response_text: string;
  attachment_url: string | null;
  attachment_type: Playbook["attachmentType"];
  after_send: Playbook["afterSend"];
  is_active: boolean;
  ai_playbook_tags: { tag: RawTag | null }[] | null;
}

const PLAYBOOK_COLUMNS =
  "id, name, trigger_description, response_text, attachment_url, attachment_type, after_send, is_active, ai_playbook_tags(tag:tags(id, label, color))";

function mapPlaybook(row: RawPlaybook): Playbook {
  return {
    id: row.id,
    name: row.name,
    triggerDescription: row.trigger_description,
    responseText: row.response_text,
    attachmentUrl: row.attachment_url,
    attachmentType: row.attachment_type,
    afterSend: row.after_send,
    isActive: row.is_active,
    // `tag` en null es la carrera entre esta consulta y alguien borrando la
    // etiqueta: la cascada se lleva la fila, así que no hay nada que mostrar.
    tags: (row.ai_playbook_tags ?? [])
      .map((link) => link.tag)
      .filter((tag): tag is RawTag => tag !== null)
      .map(mapTag),
  };
}

/** Todos los escenarios, activos e inactivos: el panel administra ambos. */
export async function fetchPlaybooks(supabase: SupabaseClient): Promise<Playbook[]> {
  const { data, error } = await supabase.from("ai_playbooks").select(PLAYBOOK_COLUMNS).order("name");
  if (error) throw error;
  // El doble paso por `unknown` es el mismo de las otras lecturas con
  // relación anidada de este archivo: PostgREST devuelve `tag` como objeto,
  // pero el tipo generado infiere un arreglo para un embebido a través de
  // una tabla puente. Ver `contact_tags(tag:tags(...))` en RawConversation.
  return (data as unknown as RawPlaybook[]).map(mapPlaybook);
}

interface RawAgentTool {
  key: string;
  name: string;
  description: string;
  is_enabled: boolean;
}

/** Los interruptores por herramienta del agente. Las filas las siembran las migraciones, no el panel. */
export async function fetchAgentTools(supabase: SupabaseClient): Promise<AgentTool[]> {
  const { data, error } = await supabase
    .from("agent_tools")
    .select("key, name, description, is_enabled")
    .order("name");

  if (error) throw error;
  return (data as RawAgentTool[]).map((row) => ({
    key: row.key,
    name: row.name,
    description: row.description,
    isEnabled: row.is_enabled,
  }));
}

interface RawKnowledgeCategory {
  id: string;
  name: string;
  description: string | null;
}

export async function fetchKnowledgeCategories(supabase: SupabaseClient): Promise<KnowledgeCategory[]> {
  const { data, error } = await supabase
    .from("knowledge_categories")
    .select("id, name, description")
    .order("name");

  if (error) throw error;
  return (data as RawKnowledgeCategory[]).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
  }));
}

interface RawKnowledgeEntry {
  id: string;
  category_id: string;
  title: string;
  content: string;
  source_filename: string | null;
  is_active: boolean;
  updated_at: string;
  category: { name: string } | null;
}

/** Todas las entradas, activas e inactivas: el panel administra ambas. La IA filtra por su cuenta (ver knowledge.ts). */
export async function fetchKnowledgeEntries(supabase: SupabaseClient): Promise<KnowledgeEntry[]> {
  const { data, error } = await supabase
    .from("knowledge_entries")
    .select("id, category_id, title, content, source_filename, is_active, updated_at, category:knowledge_categories(name)")
    .order("updated_at", { ascending: false });

  if (error) throw error;
  return (data as unknown as RawKnowledgeEntry[]).map((row) => ({
    id: row.id,
    categoryId: row.category_id,
    categoryName: row.category?.name ?? "Sin categoría",
    title: row.title,
    content: row.content,
    sourceFilename: row.source_filename,
    isActive: row.is_active,
    updatedAt: row.updated_at,
  }));
}

/**
 * Turnos que no coincidieron con ningún escenario: son los escenarios que
 * faltan por crear, dichos con las palabras reales de los clientes.
 */
export async function fetchUnmatchedTurns(supabase: SupabaseClient, limit = 20): Promise<AgentTurn[]> {
  const { data, error } = await supabase
    .from("agent_turns")
    .select(AGENT_TURN_COLUMNS)
    .is("playbook_id", null)
    .not("customer_message", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data as unknown as RawAgentTurn[]).map(mapAgentTurn);
}

interface RawModelPricing {
  model: string;
  input_price_per_million: number;
  output_price_per_million: number;
  updated_at: string;
  updated_by: string | null;
}

function mapModelPricing(row: RawModelPricing): ModelPricing {
  return {
    model: row.model,
    inputPricePerMillion: row.input_price_per_million,
    outputPricePerMillion: row.output_price_per_million,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** Tarifa por millón de tokens de cada modelo visto, para calcular costo en $USD. */
export async function fetchModelPricing(supabase: SupabaseClient): Promise<ModelPricing[]> {
  const { data, error } = await supabase
    .from("model_pricing")
    .select("model, input_price_per_million, output_price_per_million, updated_at, updated_by")
    .order("model");

  if (error) throw error;
  return (data as RawModelPricing[]).map(mapModelPricing);
}

interface RawAgentTokenUsageRow {
  day: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/**
 * Consumo de tokens de los últimos `days` días: total, costo en $USD según
 * model_pricing, serie diaria (últimos 14 días, zero-filled) y desglose por
 * modelo. Se agrega en Postgres vía la función `agent_token_usage` (una fila
 * por día×modelo) para no depender del límite de filas de PostgREST.
 */
export async function fetchTokenUsageSummary(supabase: SupabaseClient, days = 30): Promise<TokenUsageSummary> {
  const [{ data: usageData, error: usageError }, pricing] = await Promise.all([
    supabase.rpc("agent_token_usage", { days }),
    fetchModelPricing(supabase),
  ]);

  if (usageError) throw usageError;

  const priceByModel = new Map(pricing.map((p) => [p.model, p]));
  const rows = usageData as RawAgentTokenUsageRow[];

  const byDayMap = new Map<string, number>();
  const byModelMap = new Map<string, { inputTokens: number; outputTokens: number; totalTokens: number }>();

  for (const row of rows) {
    byDayMap.set(row.day, (byDayMap.get(row.day) ?? 0) + row.total_tokens);

    const current = byModelMap.get(row.model) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    current.inputTokens += row.input_tokens;
    current.outputTokens += row.output_tokens;
    current.totalTokens += row.total_tokens;
    byModelMap.set(row.model, current);
  }

  const byDay: TokenUsageDay[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = date.toISOString().slice(0, 10);
    byDay.push({ date: key, tokens: byDayMap.get(key) ?? 0 });
  }

  function usdCost(model: string, inputTokens: number, outputTokens: number): number | null {
    const price = priceByModel.get(model);
    if (!price) return null;
    return (inputTokens / 1_000_000) * price.inputPricePerMillion + (outputTokens / 1_000_000) * price.outputPricePerMillion;
  }

  const byModel: ModelUsageSummary[] = Array.from(byModelMap.entries())
    .map(([model, usage]) => ({
      model,
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usdCost: usdCost(model, usage.inputTokens, usage.outputTokens),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const totalTokens = byModel.reduce((sum, m) => sum + m.totalTokens, 0);
  const totalUsd = byModel.reduce((sum, m) => sum + (m.usdCost ?? 0), 0);
  const hasUnpricedModels = byModel.some((m) => m.usdCost === null);

  return { totalTokens, totalUsd, hasUnpricedModels, byDay, byModel };
}

interface RawAgentSuggestion {
  id: string;
  agent_id: string;
  content: string;
  status: AgentSuggestion["status"];
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  agent: RawAgent | null;
}

function mapAgentSuggestion(row: RawAgentSuggestion): AgentSuggestion {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent?.display_name ?? null,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  };
}

/** Sugerencias de mejora del bot dejadas por asesores para el supervisor, más recientes primero. */
export async function fetchAgentSuggestions(supabase: SupabaseClient, limit = 50): Promise<AgentSuggestion[]> {
  const { data, error } = await supabase
    .from("agent_suggestions")
    .select(
      `id, agent_id, content, status, created_at, reviewed_at, reviewed_by,
       agent:agents!agent_suggestions_agent_id_fkey(id, display_name, full_name, avatar_url, role, is_active)`
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data as unknown as RawAgentSuggestion[]).map(mapAgentSuggestion);
}

// ---------------------------------------------------------------------------
// El atraso que la IA puede atender al encenderse
//
// Encender el interruptor global NO tocaba nada de lo que ya estaba
// esperando: enqueueAgentTurns solo se llama desde el webhook, o sea cuando
// entra un mensaje nuevo. La IA arrancaba a contestarle a quien escribiera de
// ahí en adelante y el atraso se quedaba intacto.
//
// El corte lo resuelve Postgres con la columna generada `awaiting_reply` y el
// índice parcial `conversations_free_unanswered_idx`, cuyo predicado son
// exactamente las tres primeras condiciones de acá.
// ---------------------------------------------------------------------------

/**
 * Trabajo libre sin contestar que la IA tiene permitido tomar: nadie
 * respondió, nadie lo tomó, no está cerrado y la IA está encendida en ese
 * chat. Falta el corte de la ventana, que lo pone cada llamador porque los
 * dos lados —dentro y fuera— se cuentan por separado.
 */
function unansweredFreeWork(
  supabase: SupabaseClient,
  select: string,
  options?: { count: "exact"; head: true }
) {
  return supabase
    .from("conversations")
    .select(select, options)
    .eq("awaiting_reply", true)
    .is("assigned_agent_id", null)
    .neq("status", "closed")
    .eq("ai_enabled", true);
}

/**
 * Las conversaciones a las que la IA le va a escribir si se enciende ahora.
 *
 * El corte de las 24 h va en el WHERE y no en una comprobación posterior a
 * propósito: fuera de la ventana Meta rechaza el texto libre, y lo que no
 * entra por esta consulta no puede recibir nada. Que sea una condición del
 * `WHERE` significa que no hay una rama del código donde alguien pueda
 * saltársela.
 *
 * El orden es el más reciente primero: quien escribió hace un rato tiene
 * muchas más chances de seguir del otro lado del teléfono que quien escribió
 * hace veintitrés horas. Se ordena por `last_message_at` y no por
 * `last_customer_message_at` porque en una conversación sin contestar son el
 * mismo instante, y así el índice parcial también sirve para ordenar.
 */
export async function fetchBacklogConversationIds(
  supabase: SupabaseClient,
  now: number = Date.now()
): Promise<string[]> {
  const { data, error } = await unansweredFreeWork(supabase, "id")
    .gt("last_customer_message_at", freeformWindowCutoff(now))
    .order("last_message_at", { ascending: false, nullsFirst: false });

  if (error) throw error;
  const ids = ((data ?? []) as unknown as { id: string }[]).map((row) => row.id);

  // Las tres condiciones de arriba no distinguen un chat sin atender de uno
  // que una persona está atendiendo: los asesores contestan sin asignarse la
  // conversación, y "el último mensaje es del cliente" describe igual de bien
  // a alguien que respondió "Ok" a su asesor. El 26 de agosto de 2026 eso
  // metió 22 chats atendidos en una tanda de 139. Ver human-handled.ts.
  //
  // La guarda de verdad está en el turno, que es por donde pasan todos los
  // caminos. Esto es lo que evita llenar la cola de trabajo que el turno va a
  // descartar uno por uno — y, sobre todo, lo que hace que el número del
  // diálogo de encendido diga la verdad: al dueño se le dijo 139 cuando 22 de
  // esas eran de sus asesores.
  const deHumanos = await conversationsWrittenByHumans(supabase, ids);
  return ids.filter((id) => !deHumanos.has(id));
}

export interface BacklogCounts {
  /** Se les puede escribir ahora mismo. Es el número que el diálogo de encendido tiene que decir. */
  inWindow: number;
  /**
   * Están esperando igual, pero fuera de la ventana de 24 h. No se les
   * escribe. Se cuenta y se muestra porque es la prueba de que la guarda
   * está viva: el día que esto diga cero habiendo conversaciones viejas sin
   * contestar, algo se rompió.
   */
  outOfWindow: number;
}

/** Los dos números del diálogo, contados en la base y no estimados sobre lo que el navegador tenga cargado. */
export async function fetchBacklogCounts(
  supabase: SupabaseClient,
  now: number = Date.now()
): Promise<BacklogCounts> {
  const cutoff = freeformWindowCutoff(now);

  // Se piden los ids y no un count(*) porque el número que importa —el que
  // lee el dueño antes de pulsar— tiene que descontar los chats que ya tocó
  // una persona, y eso no se puede expresar en un `head: true`. Son un puñado
  // de filas: el índice parcial deja adentro solo el trabajo libre pendiente.
  const [dentro, fuera] = await Promise.all([
    unansweredFreeWork(supabase, "id").gt("last_customer_message_at", cutoff),
    unansweredFreeWork(supabase, "id", { count: "exact", head: true }).lte("last_customer_message_at", cutoff),
  ]);

  if (dentro.error) throw dentro.error;
  if (fuera.error) throw fuera.error;

  const idsDentro = ((dentro.data ?? []) as unknown as { id: string }[]).map((row) => row.id);
  const deHumanos = await conversationsWrittenByHumans(supabase, idsDentro);

  return {
    inWindow: idsDentro.filter((id) => !deHumanos.has(id)).length,
    outOfWindow: fuera.count ?? 0,
  };
}

export async function fetchAgentSettings(supabase: SupabaseClient): Promise<AgentSettings> {
  const [{ data, error }, { data: spentToday }] = await Promise.all([
    supabase.from("agent_settings").select("ai_globally_enabled, daily_spend_cap_usd").eq("id", true).single(),
    supabase.rpc("agent_spend_today"),
  ]);

  if (error) throw error;
  return {
    aiGloballyEnabled: data.ai_globally_enabled,
    dailySpendCapUsd: data.daily_spend_cap_usd === null ? null : Number(data.daily_spend_cap_usd),
    spentTodayUsd: Number(spentToday ?? 0),
  };
}

/**
 * Quién está usando el CRM.
 *
 * Sale de la sesión que ya viaja en la cookie y no de `auth.getUser()`, que
 * es una llamada a GoTrue de ~841 ms de media (medido: 300 ms–3,5 s, 53–82 %
 * de un núcleo) en cada carga de página.
 *
 * No es más débil: el id de la cookie solo se usa para CONSULTAR, y esa
 * consulta viaja con el mismo token a PostgREST, que verifica su firma y
 * aplica RLS. Con una cookie inventada la consulta se rechaza y no vuelve
 * ninguna fila; con una cookie legítima, `sub` no se puede cambiar sin
 * romper la firma. El agente que se devuelve sale de la base, no del token.
 */
export async function fetchCurrentAgent(supabase: SupabaseClient): Promise<Agent | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;

  const { data, error } = await supabase
    .from("agents")
    .select("id, display_name, full_name, avatar_url, role, is_active")
    .eq("id", session.user.id)
    .maybeSingle();

  if (error) throw error;
  return mapAgent(data as RawAgent | null);
}

/**
 * La última tasa del BCV que haya guardada, por fecha de vigencia.
 *
 * A diferencia de `getBcvRate`, esto no sale a leer bcv.org.ve: solo consulta
 * la tabla, así que se puede llamar desde el navegador. Lo usa el cierre de
 * venta, que necesita la tasa para pasar a dólares un repuesto con precio en
 * bolívares. Devuelve 0 si todavía no hay ninguna tasa cargada.
 */
export async function fetchLatestBcvRate(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from("exchange_rates")
    .select("usd_to_ves")
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return 0;
  return Number((data as { usd_to_ves: number }).usd_to_ves) || 0;
}
