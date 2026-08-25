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

/** Con qué pagó el cliente. Se elige al cerrar la venta y después no se toca. */
export type PaymentMethod = "pago_movil" | "transferencia" | "zelle" | "cashea";

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  pago_movil: "Pago Móvil",
  transferencia: "Transferencia Bancaria",
  zelle: "Zelle",
  cashea: "Cashea",
};

/** El orden en que se ofrecen en el selector del cierre. */
export const PAYMENT_METHODS: PaymentMethod[] = ["pago_movil", "transferencia", "zelle", "cashea"];

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
  /**
   * El asesor apartó el chat a propósito para volver después, aunque no le
   * quede ningún mensaje por leer. Va aparte de `unreadCount` justamente
   * para no inventar un mensaje que no existe: el contador sigue diciendo
   * la verdad y la bandeja combina las dos cosas.
   */
  manuallyUnread: boolean;
  assignedAgent: Agent | null;
  aiEnabled: boolean;
  dealStatus: DealStatus;
  dealClosedAt: string | null;
  dealPaymentProofUrl: string | null;
  /** Monto real de la venta, tomado de las cotizaciones que el agente seleccionó al cerrar. Null si aún no se cerró con ítems. */
  dealAmount: number | null;
  dealCurrency: string | null;
  dealVerified: boolean;
  dealVerifiedAt: string | null;
  dealVerifiedBy: Agent | null;
  /** Con qué pagó el cliente. Null en las ventas cerradas antes de que existiera el campo. */
  dealPaymentMethod: PaymentMethod | null;
  /**
   * Quién cerró la venta. No es el agente asignado: el hilo puede reasignarse
   * después, o puede cerrarlo el supervisor sobre una conversación ajena.
   */
  dealClosedBy: Agent | null;
  lastCustomerMessageAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /** De quién es el último mensaje. El doble check solo aplica a los salientes. */
  lastMessageDirection: MessageDirection | null;
  /** Estado de entrega del último mensaje saliente: null en los entrantes. */
  lastMessageStatus: WhatsappMessageStatus | null;
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
  /**
   * Emoji con el que el cliente reaccionó a este mensaje. Null si no
   * reaccionó o si quitó la reacción.
   */
  reactionEmoji: string | null;
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

/**
 * `link` anexa la URL al texto (sirve para cualquier URL: catálogo web,
 * Drive, una carpeta compartida). Los otros tres hacen que Meta descargue
 * el archivo, así que exigen una URL directa al archivo y pública.
 */
export type PlaybookAttachmentType = "link" | "image" | "document" | "video";

/** `wait`: queda a la espera del cliente. `escalate`: pasa a un asesor. */
export type PlaybookAfterSend = "wait" | "escalate";

/** Respuesta predeterminada que la IA envía verbatim al reconocer el escenario. */
export interface Playbook {
  id: string;
  name: string;
  triggerDescription: string;
  responseText: string;
  attachmentUrl: string | null;
  attachmentType: PlaybookAttachmentType | null;
  afterSend: PlaybookAfterSend;
  isActive: boolean;
}

/** Herramienta del agente de IA con su interruptor del panel. Las filas las siembran las migraciones. */
export interface AgentTool {
  /** Contrato con el código (src/lib/ai/agent-tools.ts): no se renombra. */
  key: string;
  name: string;
  description: string;
  isEnabled: boolean;
}

/** Sección de la biblioteca de conocimiento. Las crea el equipo según cómo divida su información. */
export interface KnowledgeCategory {
  id: string;
  name: string;
  description: string | null;
}

/** Un tema que la IA puede consultar. El contenido es información con la que redacta, no un texto que envía verbatim. */
export interface KnowledgeEntry {
  id: string;
  categoryId: string;
  categoryName: string;
  title: string;
  content: string;
  /** Nombre del archivo (.md/.txt) del que se importó el contenido, si vino de uno. */
  sourceFilename: string | null;
  isActive: boolean;
  updatedAt: string;
}

/**
 * Cortes de la bandeja. Los tres primeros son de administración (miran el
 * trabajo de todo el equipo); los dos últimos son del asesor sobre lo suyo.
 * `filtersForRole` decide cuáles se ofrecen a quién.
 */
export type InboxFilter = "all" | "unread" | "unassigned" | "assigned" | "mine" | "mine-unread";

export type InboxSort = "recent" | "oldest";

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
  /** Escenario que resolvió el turno. Null = no coincidió ninguno y respondió el flujo genérico. */
  playbookId: string | null;
  /** Último mensaje del cliente del turno. Es lo que alimenta la lista de escenarios faltantes. */
  customerMessage: string | null;
  createdAt: string;
}

/**
 * Rendimiento de una persona del equipo, en «Control de agentes».
 *
 * Cada número viene por partida doble: el del día en curso —para ver quién
 * está cargado ahora— y el del período, para la foto sostenida.
 */
export interface AgentMetrics {
  agentId: string;
  /** Mensajes escritos a clientes. Las notas internas no cuentan: nadie las lee del otro lado. */
  messagesToday: number;
  messagesPeriod: number;
  /** Conversaciones distintas en las que escribió, más allá de las que tenga asignadas ahora. */
  conversationsToday: number;
  conversationsPeriod: number;
  salesToday: number;
  salesPeriod: number;
  /** Suma en USD de las ventas cerradas. Sale de las cotizaciones reales del chat. */
  salesAmountToday: number;
  salesAmountPeriod: number;
  /** Comprobantes verificados. Solo supervisión puede hacerlo. */
  verifiedToday: number;
  verifiedPeriod: number;
  /**
   * Mediana de segundos entre que le asignan una conversación y manda su
   * primer mensaje. Null si todavía no hay ninguna medida — el dato se
   * empezó a registrar el 22/08/2026 y no se puede reconstruir hacia atrás.
   */
  firstReplyMedianSeconds: number | null;
}

/** Interruptor global de la IA en todo el CRM. */
export interface AgentSettings {
  aiGloballyEnabled: boolean;
  /** Gasto máximo por día en USD. Null = sin tope. Al alcanzarlo la IA para hasta el día siguiente. */
  dailySpendCapUsd: number | null;
  /** Gasto de la IA en el día en curso, hora de Caracas. */
  spentTodayUsd: number;
}

/** Tarifa en USD por millón de tokens para un modelo — usada para calcular el costo del consumo de la IA. */
export interface ModelPricing {
  model: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  updatedAt: string;
  updatedBy: string | null;
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

/**
 * Un repuesto que la IA le cotizó al cliente en el chat (herramienta de
 * catálogo), con el precio exacto en el momento de la cotización. Es lo que
 * el agente elige al cerrar una venta -- el monto de la venta sale de acá,
 * nunca se escribe a mano.
 */
export interface ConversationQuote {
  id: string;
  productId: string | null;
  productName: string;
  priceUsd: number;
  priceBs: number;
  bcvRate: number;
  quotedAt: string;
}

/** Resumen de consumo de tokens para el panel de Control de IA. */
export interface TokenUsageSummary {
  totalTokens: number;
  totalUsd: number;
  hasUnpricedModels: boolean;
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

// ---------------------------------------------------------------------------
// Clientes
//
// La sección Clientes no agrega tablas: reordena lo que ya existe (contacts,
// conversations, orders, order_items, notes) alrededor de la persona en vez
// de alrededor del hilo de chat.
// ---------------------------------------------------------------------------

/** Un renglón de una compra, tal como quedó registrado al cerrar la venta. */
export interface CustomerPurchaseItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

/** Una compra cerrada, ya cruzada con la conversación donde se cerró. */
export interface CustomerPurchase {
  orderId: string;
  conversationId: string;
  purchasedAt: string;
  totalAmount: number;
  currency: string;
  verified: boolean;
  items: CustomerPurchaseItem[];
}

/**
 * Lo mínimo de una conversación que necesita el resumen del cliente. Se
 * declara aparte de `Conversation` a propósito: el resumen se calcula sobre
 * cientos de filas y no necesita etiquetas, canal, agente ni mensajes.
 */
export interface CustomerConversationRow {
  id: string;
  dealStatus: DealStatus;
  dealClosedAt: string | null;
  lastMessageAt: string | null;
  orderTotal: number | null;
  orderCurrency: string | null;
  orderPurchasedAt: string | null;
}

/** Lo comercial de un cliente, calculado a partir de sus conversaciones. */
export interface CustomerActivity {
  /** Suma de las compras cerradas en USD. Las devueltas y las eliminadas no cuentan. */
  totalSpentUsd: number;
  purchaseCount: number;
  lastPurchaseAt: string | null;
  lastMessageAt: string | null;
  conversationCount: number;
  /** Conversación más reciente: a dónde lleva el botón "Abrir chat". */
  latestConversationId: string | null;
  /**
   * Hubo compras en una moneda distinta de USD, así que `totalSpentUsd` no
   * es el total real. La UI lo advierte en vez de sumar peras con manzanas.
   */
  hasNonUsdPurchases: boolean;
}

/** Una fila de la lista de Clientes. */
export interface CustomerSummary {
  contact: Contact;
  activity: CustomerActivity;
}

/** La ficha completa de un cliente. */
export interface CustomerDetail {
  contact: Contact;
  activity: CustomerActivity;
  purchases: CustomerPurchase[];
  conversations: CustomerConversationRow[];
  notes: Note[];
}

// ---------------------------------------------------------------------------
// Inventario
//
// `products` es el inventario que la herramienta de catálogo de la IA lee en
// cada turno: lo que se edite acá es lo que la IA cotiza en el próximo
// mensaje, sin recargas ni sincronizaciones intermedias.
// ---------------------------------------------------------------------------

export type ProductCurrency = "USD" | "VES";

export interface ProductCompatibility {
  id: string;
  motoBrand: string;
  motoModel: string;
}

export interface Product {
  id: string;
  name: string;
  brand: string | null;
  price: number;
  currency: ProductCurrency;
  stockQuantity: number;
  description: string | null;
  isActive: boolean;
  updatedAt: string;
  compatibility: ProductCompatibility[];
}

/**
 * Tamaño del catálogo clon de motos (familias de motor, modelos comerciales,
 * reglas de compatibilidad y jerga). No se edita desde el CRM: se importa del
 * ERP. La sección lo muestra para que se vea qué tan cargado está lo que la
 * IA usa para resolver compatibilidades.
 */
export interface MotoCatalogSummary {
  engineFamilies: number;
  commercialModels: number;
  modelEngineLinks: number;
  compatibilityRules: number;
  searchSynonyms: number;
}

/**
 * De dónde salió un renglón de la venta: de una cotización real que la IA le
 * dio al cliente en el chat, o agregado a mano por el asesor desde el
 * inventario. En los dos casos el precio viene del catálogo — nunca se
 * escribe a mano.
 */
export type SaleItemOrigin = "quote" | "inventory";

/** Un renglón de "lo que lleva el cliente" mientras se arma la venta. */
export interface SaleCartItem {
  /** Clave estable del renglón: el id de la cotización o el del producto. */
  id: string;
  origin: SaleItemOrigin;
  productId: string | null;
  description: string;
  unitPriceUsd: number;
  quantity: number;
}
