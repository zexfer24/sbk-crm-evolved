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
export type DealStatus = "none" | "in_progress" | "won" | "lost";

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
