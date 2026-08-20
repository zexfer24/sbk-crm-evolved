export type AgentRole = "agent" | "supervisor" | "admin";

export interface Agent {
  id: string;
  displayName: string;
  fullName: string | null;
  avatarUrl: string | null;
  role: AgentRole;
  isActive: boolean;
}

export type ChannelStatus = "connected" | "disconnected" | "pending";

export interface WhatsappChannel {
  id: string;
  label: string;
  phoneNumber: string;
  phoneNumberId: string | null;
  status: ChannelStatus;
}

export type TagColor = "default" | "accent" | "success" | "warning" | "danger";

export interface Tag {
  id: string;
  label: string;
  color: TagColor;
}

export type CedulaType = "V" | "E";

export interface Contact {
  id: string;
  phoneNumber: string;
  displayName: string | null;
  profileName: string | null;
  avatarUrl: string | null;
  cedulaType: CedulaType | null;
  cedulaNumber: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  tags: Tag[];
}

export type ConversationStatus = "open" | "pending" | "closed";
export type DealStatus = "none" | "in_progress" | "won" | "lost" | "returned";

/** Etapas del recorrido, en el orden en que las atraviesa un cliente. */
export type JourneyStageId =
  | "first_contact"
  | "inquiry"
  | "classifying"
  | "tool_running"
  | "assigned";

export interface Conversation {
  id: string;
  contact: Contact;
  channel: WhatsappChannel;
  status: ConversationStatus;
  unreadCount: number;
  assignedAgent: Agent | null;
  aiEnabled: boolean;
  dealStatus: DealStatus;
  dealClosedAt: string | null;
  dealPaymentProofUrl: string | null;
  dealVerified: boolean;
  dealVerifiedAt: string | null;
  dealVerifiedBy: Agent | null;
  lastCustomerMessageAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
  /** Etapa reportada por el agente de IA. Null = se deduce del resto del estado. */
  journeyStage: JourneyStageId | null;
  /** Intención detectada por la IA: compra, devolución, reclamo… */
  intent: string | null;
  /** Herramienta que la IA está ejecutando ahora mismo. */
  activeTool: string | null;
  /** Última vez que se envió el mensaje de bienvenida. */
  welcomeSentAt: string | null;
}

/** Un tramo del gráfico de 24 h: qué pasó en esa hora del día. */
export interface HourlyActivity {
  hour: number;
  inbound: number;
  ai: number;
  agent: number;
}

export type MessageDirection = "inbound" | "outbound";
export type MessageSenderType = "customer" | "agent" | "ai" | "system";
export type MessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "template"
  | "system_event";
export type WhatsappMessageStatus = "sent" | "delivered" | "read" | "failed";

export interface Message {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  senderAgent: Agent | null;
  messageType: MessageType;
  content: string | null;
  templateName: string | null;
  mediaUrl: string | null;
  isInternalNote: boolean;
  whatsappStatus: WhatsappMessageStatus | null;
  replyToMessageId: string | null;
  createdAt: string;
}

export interface Note {
  id: string;
  contactId: string;
  agent: Agent | null;
  content: string;
  createdAt: string;
}

export type TemplateCategory = "utility" | "marketing" | "authentication";
export type TemplateStatus = "approved" | "pending" | "rejected";

export interface WhatsappTemplate {
  id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  bodyPreview: string;
  status: TemplateStatus;
}

export interface QuickReply {
  id: string;
  label: string;
  content: string;
}

export type InboxFilter = "all" | "assigned";

/** Qué categoría detectó la IA en el mensaje del cliente. */
export type AgentIntent = "consulta_disponibilidad" | "devolucion" | "queja" | "otro";

export type AgentTurnAction = "answered" | "escalated" | "error";

/** Una fila de la bitácora de turnos del agente — alimenta el feed en vivo del panel de control. */
export interface AgentTurn {
  id: string;
  conversationId: string;
  intent: AgentIntent | null;
  action: AgentTurnAction;
  summary: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  createdAt: string;
}

/** Interruptor global de la IA en todo el CRM. */
export interface AgentSettings {
  aiGloballyEnabled: boolean;
}

/** Tarifa en USD por millón de tokens para un modelo — usada para calcular el costo del consumo de la IA. */
export interface ModelPricing {
  model: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  updatedAt: string;
}

/** Tokens consumidos en un día — un punto del gráfico de consumo. */
export interface TokenUsageDay {
  date: string;
  tokens: number;
}

/** Consumo acumulado de un modelo, con su costo en USD si hay tarifa cargada. */
export interface ModelUsageSummary {
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  usdCost: number | null;
}

/** Resumen de consumo de tokens para el panel de Control de IA. */
export interface TokenUsageSummary {
  totalTokens: number;
  totalUsd: number;
  byDay: TokenUsageDay[];
  byModel: ModelUsageSummary[];
}

/** Sugerencia de un asesor humano al supervisor sobre cómo mejorar el bot. */
export type AgentSuggestionStatus = "pending" | "reviewed";

export interface AgentSuggestion {
  id: string;
  agentId: string;
  agentName: string | null;
  content: string;
  status: AgentSuggestionStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}
