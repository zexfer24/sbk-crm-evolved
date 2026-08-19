import type { SupabaseClient } from "@supabase/supabase-js";
import { CRM_TIME_ZONE, currentDayRange } from "@/lib/time-zone";
import type {
  Agent,
  Contact,
  Conversation,
  HourlyActivity,
  Message,
  Note,
  QuickReply,
  Tag,
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

interface RawContact {
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

interface RawConversation {
  id: string;
  status: Conversation["status"];
  unread_count: number;
  ai_enabled: boolean;
  deal_status: Conversation["dealStatus"];
  deal_closed_at: string | null;
  last_customer_message_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
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

function mapContact(row: RawContact): Contact {
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
    assignedAgent: mapAgent(row.assigned_agent),
    aiEnabled: row.ai_enabled,
    dealStatus: row.deal_status,
    dealClosedAt: row.deal_closed_at,
    lastCustomerMessageAt: row.last_customer_message_at,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
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

const CONVERSATION_SELECT = `
  id, status, unread_count, ai_enabled, deal_status, deal_closed_at,
  last_customer_message_at, last_message_at, last_message_preview, created_at,
  journey_stage, intent, active_tool, welcome_sent_at,
  contact:contacts(id, phone_number, display_name, profile_name, avatar_url,
    cedula_type, cedula_number, state, city, address,
    contact_tags(tag:tags(id, label, color))),
  channel:whatsapp_channels(id, label, phone_number, phone_number_id, status),
  assigned_agent:agents(id, display_name, full_name, avatar_url, role, is_active)
`;

export async function fetchConversations(supabase: SupabaseClient): Promise<Conversation[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select(CONVERSATION_SELECT)
    .order("last_message_at", { ascending: false, nullsFirst: false });

  if (error) throw error;
  return (data as unknown as RawConversation[]).map(mapConversation);
}

export async function fetchConversation(
  supabase: SupabaseClient,
  conversationId: string
): Promise<Conversation | null> {
  const { data, error } = await supabase
    .from("conversations")
    .select(CONVERSATION_SELECT)
    .eq("id", conversationId)
    .maybeSingle();

  if (error) throw error;
  return data ? mapConversation(data as unknown as RawConversation) : null;
}

export async function fetchMessages(
  supabase: SupabaseClient,
  conversationId: string
): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select(
      `id, conversation_id, direction, sender_type, message_type, content, template_name,
       media_url, is_internal_note, whatsapp_status, reply_to_message_id, created_at,
       sender_agent:agents(id, display_name, full_name, avatar_url, role, is_active)`
    )
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data as unknown as RawMessage[]).map(mapMessage);
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

export async function fetchQuickReplies(supabase: SupabaseClient): Promise<QuickReply[]> {
  const { data, error } = await supabase
    .from("quick_replies")
    .select("id, label, content")
    .order("label");
  if (error) throw error;
  return (data as RawQuickReply[]).map(mapQuickReply);
}

export async function fetchCurrentAgent(supabase: SupabaseClient): Promise<Agent | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("agents")
    .select("id, display_name, full_name, avatar_url, role, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (error) throw error;
  return mapAgent(data as RawAgent | null);
}
