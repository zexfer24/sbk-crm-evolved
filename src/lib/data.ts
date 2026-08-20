import type { SupabaseClient } from "@supabase/supabase-js";
import { CRM_TIME_ZONE, currentDayRange } from "@/lib/time-zone";
import type {
  Agent,
  AgentSettings,
  AgentSuggestion,
  AgentTurn,
  Contact,
  Conversation,
  HourlyActivity,
  Message,
  ModelPricing,
  ModelUsageSummary,
  Note,
  QuickReply,
  Tag,
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
  deal_payment_proof_url: string | null;
  deal_verified: boolean;
  deal_verified_at: string | null;
  deal_verified_by: RawAgent | null;
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
    dealPaymentProofUrl: row.deal_payment_proof_url,
    dealVerified: row.deal_verified,
    dealVerifiedAt: row.deal_verified_at,
    dealVerifiedBy: mapAgent(row.deal_verified_by),
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
  deal_payment_proof_url, deal_verified, deal_verified_at,
  last_customer_message_at, last_message_at, last_message_preview, created_at,
  journey_stage, intent, active_tool, welcome_sent_at,
  contact:contacts(id, phone_number, display_name, profile_name, avatar_url,
    cedula_type, cedula_number, state, city, address,
    contact_tags(tag:tags(id, label, color))),
  channel:whatsapp_channels(id, label, phone_number, phone_number_id, status),
  assigned_agent:agents!conversations_assigned_agent_id_fkey(id, display_name, full_name, avatar_url, role, is_active),
  deal_verified_by:agents!conversations_deal_verified_by_fkey(id, display_name, full_name, avatar_url, role, is_active)
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

/** Roster completo (activos e inactivos) para la sección "Control de agentes". */
export async function fetchAllAgents(supabase: SupabaseClient): Promise<Agent[]> {
  const { data, error } = await supabase
    .from("agents")
    .select("id, display_name, full_name, avatar_url, role, is_active")
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
  created_at: string;
}

function mapAgentTurn(row: RawAgentTurn): AgentTurn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    intent: row.intent,
    action: row.action,
    summary: row.summary,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    createdAt: row.created_at,
  };
}

/** Últimos turnos del agente de IA en todo el CRM, para el feed en vivo del panel de control. */
export async function fetchAgentTurns(supabase: SupabaseClient, limit = 30): Promise<AgentTurn[]> {
  const { data, error } = await supabase
    .from("agent_turns")
    .select("id, conversation_id, intent, action, summary, model, input_tokens, output_tokens, total_tokens, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data as RawAgentTurn[]).map(mapAgentTurn);
}

interface RawModelPricing {
  model: string;
  input_price_per_million: number;
  output_price_per_million: number;
  updated_at: string;
}

function mapModelPricing(row: RawModelPricing): ModelPricing {
  return {
    model: row.model,
    inputPricePerMillion: row.input_price_per_million,
    outputPricePerMillion: row.output_price_per_million,
    updatedAt: row.updated_at,
  };
}

/** Tarifa por millón de tokens de cada modelo visto, para calcular costo en $USD. */
export async function fetchModelPricing(supabase: SupabaseClient): Promise<ModelPricing[]> {
  const { data, error } = await supabase
    .from("model_pricing")
    .select("model, input_price_per_million, output_price_per_million, updated_at")
    .order("model");

  if (error) throw error;
  return (data as RawModelPricing[]).map(mapModelPricing);
}

interface RawTokenUsageRow {
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  created_at: string;
}

/**
 * Consumo de tokens de los últimos `days` días: total, costo en $USD según
 * model_pricing, serie diaria (últimos 14 días, zero-filled) y desglose por
 * modelo. Se agrega en JS sobre las filas crudas, igual que el resto de
 * data.ts — sin vistas SQL nuevas.
 */
export async function fetchTokenUsageSummary(supabase: SupabaseClient, days = 30): Promise<TokenUsageSummary> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [{ data: turnsData, error: turnsError }, pricing] = await Promise.all([
    supabase
      .from("agent_turns")
      .select("model, input_tokens, output_tokens, total_tokens, created_at")
      .gte("created_at", since.toISOString()),
    fetchModelPricing(supabase),
  ]);

  if (turnsError) throw turnsError;

  const priceByModel = new Map(pricing.map((p) => [p.model, p]));
  const rows = (turnsData as RawTokenUsageRow[]).filter((row) => row.total_tokens !== null);

  const byDayMap = new Map<string, number>();
  const byModelMap = new Map<string, { inputTokens: number; outputTokens: number; totalTokens: number }>();

  for (const row of rows) {
    const day = row.created_at.slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) ?? 0) + (row.total_tokens ?? 0));

    const modelKey = row.model ?? "desconocido";
    const current = byModelMap.get(modelKey) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    current.inputTokens += row.input_tokens ?? 0;
    current.outputTokens += row.output_tokens ?? 0;
    current.totalTokens += row.total_tokens ?? 0;
    byModelMap.set(modelKey, current);
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

  return { totalTokens, totalUsd, byDay, byModel };
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

export async function fetchAgentSettings(supabase: SupabaseClient): Promise<AgentSettings> {
  const { data, error } = await supabase
    .from("agent_settings")
    .select("ai_globally_enabled")
    .eq("id", true)
    .single();

  if (error) throw error;
  return { aiGloballyEnabled: data.ai_globally_enabled };
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
