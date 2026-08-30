export type AgentRole = "agent" | "supervisor" | "admin";

/**
 * Lo mínimo para nombrar a un asesor en una fila de lista. Las filas de la
 * bandeja viajan por decenas en cada respuesta: cargar acá el perfil completo
 * multiplicaba el payload sin que ninguna lista lo mostrara.
 */
export interface AgentRef {
  id: string;
  displayName: string;
}

export interface Agent extends AgentRef {
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

/**
 * Lo mínimo para poner un nombre en una tarjeta. El tablero y el roster
 * pintan iniciales y nombre, nada más: cargarles el avatar y las etiquetas
 * de cada contacto multiplicaba una respuesta que ya trae cientos de filas.
 */
export interface ContactName {
  id: string;
  phoneNumber: string;
  displayName: string | null;
  profileName: string | null;
}

/**
 * El contacto tal como lo pinta una fila de la bandeja: quién es y sus
 * etiquetas. La cédula y la dirección son de la ficha, no de la fila — se
 * cargan con el detalle al abrir la conversación.
 */
export interface ContactSummary extends ContactName {
  avatarUrl: string | null;
  tags: Tag[];
}

export interface Contact extends ContactSummary {
  cedulaType: CedulaType | null;
  cedulaNumber: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
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

/**
 * La fila que miran el tablero y Control de IA: en qué punto del recorrido
 * está la conversación, de quién es y hace cuánto que no se mueve.
 *
 * Es la forma más liviana, y a propósito: esas dos vistas piden TODO el
 * trabajo abierto de una vez —cientos de filas— para contar por etapa y por
 * asesor. Lo que no cuentan ni pintan no viaja: ni la vista previa del
 * último mensaje, ni el estado de entrega, ni el avatar, ni las etiquetas
 * del contacto (los reclamos llegan por `TicketTagsByContact`, que son unas
 * pocas filas en vez de una relación anidada por cada conversación).
 */
export interface BoardConversation {
  id: string;
  contact: ContactName;
  status: ConversationStatus;
  unreadCount: number;
  /**
   * El asesor apartó el chat a propósito para volver después, aunque no le
   * quede ningún mensaje por leer. Va aparte de `unreadCount` justamente
   * para no inventar un mensaje que no existe: el contador sigue diciendo
   * la verdad y la bandeja combina las dos cosas.
   */
  manuallyUnread: boolean;
  assignedAgent: AgentRef | null;
  aiEnabled: boolean;
  dealStatus: DealStatus;
  /** Viaja en la fila porque el refresco en vivo compara con él para saber si la venta cambió. */
  dealVerified: boolean;
  lastCustomerMessageAt: string | null;
  lastMessageAt: string | null;
  /**
   * Alguna vez salió de acá una respuesta que el cliente pueda leer, de un
   * asesor o de la IA. No cuentan los eventos de sistema ni las notas
   * internas.
   *
   * Es lo que separa "nadie contestó nunca" de "el último mensaje es del
   * cliente", que es lo único que sabe `awaitingReply()`. Pero es vitalicio:
   * una vez en `true` no vuelve a `false`, así que no sirve como corte de
   * "sin atender" — un chat contestado hace meses lo sigue teniendo en
   * `true` aunque hoy esté esperando de nuevo. Ese fue el plan de la entrega
   * 2 (partir la píldora "Sin contestar" por este campo); probarlo así vació
   * la píldora en producción el 28/8/2026, y la decisión de ese día lo
   * reemplazó por un corte de tiempo, no de historial: la ventana de 24 h de
   * Meta (`isStalePending`, src/lib/dashboard.ts). Ese corte de tiempo nunca
   * volvió a vivir en la bandeja —ni siquiera con el regreso de la píldora
   * "Pendientes" el 30/8/2026, que la partición de `buildInboxSections`
   * (src/lib/inbox-sections.ts) resuelve por LECTURA, no por ventana—; sigue
   * siendo terreno exclusivo del Dashboard y el `AgentHomePanel`. El campo
   * se conserva porque `neverRepliedOnly` (src/lib/data.ts) lo sigue usando
   * como herramienta disponible.
   */
  hasReply: boolean;
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

/**
 * La fila de la bandeja: lo del tablero más lo que hace falta para pintar
 * una línea de chat —la vista previa, el doble check, el avatar y las
 * etiquetas—. La bandeja carga de a 30, así que puede permitírselo.
 *
 * Todo lo demás —el canal, la ficha del contacto, el detalle de la venta—
 * vive en `Conversation` y se pide al abrir el chat, una a la vez.
 */
export interface ConversationSummary extends BoardConversation {
  contact: ContactSummary;
  lastMessagePreview: string | null;
  /** De quién es el último mensaje. El doble check solo aplica a los salientes. */
  lastMessageDirection: MessageDirection | null;
  /** Estado de entrega del último mensaje saliente: null en los entrantes. */
  lastMessageStatus: WhatsappMessageStatus | null;
}

/**
 * Qué etiquetas de reclamo tiene cada contacto, por id de contacto.
 *
 * Un reclamo es un contacto etiquetado (ver `lib/dashboard.ts`), y las
 * etiquetas de reclamo son un puñado. Traerlas aparte cuesta dos consultas
 * chicas y planas; traerlas embebidas costaba una relación anidada
 * (`contact_tags(tag:tags(...))`) que PostgREST resuelve con un lateral por
 * fila, en cada una de las cientos de filas del tablero.
 */
export type TicketTagsByContact = ReadonlyMap<string, Tag[]>;

/** La conversación completa, la que abre el chat. Se pide de a una por id. */
export interface Conversation extends ConversationSummary {
  contact: Contact;
  channel: WhatsappChannel;
  assignedAgent: Agent | null;
  dealClosedAt: string | null;
  dealPaymentProofUrl: string | null;
  /** Monto real de la venta, tomado de las cotizaciones que el agente seleccionó al cerrar. Null si aún no se cerró con ítems. */
  dealAmount: number | null;
  dealCurrency: string | null;
  dealVerifiedAt: string | null;
  dealVerifiedBy: Agent | null;
  /** Con qué pagó el cliente. Null en las ventas cerradas antes de que existiera el campo. */
  dealPaymentMethod: PaymentMethod | null;
  /**
   * Quién cerró la venta. No es el agente asignado: el hilo puede reasignarse
   * después, o puede cerrarlo el supervisor sobre una conversación ajena.
   */
  dealClosedBy: Agent | null;
}

/**
 * Una venta cerrada, para la sección Ventas. Antes esa sección cargaba el
 * histórico completo de conversaciones para quedarse con las ganadas: esto es
 * la consulta al revés — solo las vendidas, con la ficha del contacto que el
 * detalle de la venta sí muestra y sin nada de bandeja.
 */
export interface Sale {
  id: string;
  contact: Contact;
  dealStatus: DealStatus;
  dealClosedAt: string | null;
  dealPaymentProofUrl: string | null;
  dealAmount: number | null;
  dealCurrency: string | null;
  dealVerified: boolean;
  dealVerifiedAt: string | null;
  dealVerifiedBy: AgentRef | null;
  dealPaymentMethod: PaymentMethod | null;
  dealClosedBy: AgentRef | null;
  createdAt: string;
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
   * Por qué Meta no pudo entregarlo, en palabras. Null salvo cuando
   * `whatsappStatus` es 'failed' — y aun ahí puede faltar, si el fallo llegó
   * sin motivo.
   *
   * Es lo que convierte el triángulo rojo en algo accionable: "el número no
   * existe" se arregla pidiéndole el número al cliente, "pasaron 24 h" se
   * arregla esperando a que vuelva a escribir. Sin esto los dos se ven igual y
   * el asesor reintenta, que no arregla ninguno de los dos.
   */
  whatsappError: string | null;
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
  /**
   * Etiquetas que se aplican cuando este escenario responde, escale o no.
   *
   * Se llevan enteras y no como ids sueltos porque los dos lectores las
   * necesitan escritas: el panel pinta la píldora con su color, y la
   * bitácora del turno anota por nombre qué quedó etiquetado (un id en el
   * registro no le dice nada a quien lo lee).
   */
  tags: Tag[];
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
 * Cortes de la bandeja. Primera reforma (28/8/2026, mañana): de cinco
 * píldoras que distinguían leído/asignado se pasó a tres iguales para todos
 * los roles — `pending`, `mine`, `all` — porque el corte por asignación no
 * servía de guarda (ver el historial en el comentario del case `pending` que
 * tenía inbox-filters.ts) y la separación nuevo/viejo se movió a las
 * secciones por ventana de 24h.
 *
 * Segunda reforma (28/8/2026, misma tarde, pedido directo del operador):
 * `pending` se retira de la bandeja. Su corte —trabajo que lleva más de 24h
 * sin respuesta— no desaparece, sigue vivo en `dashboard.ts`
 * (`awaitingReply`/`isStalePending`) y en el AgentHomePanel; deja de ser una
 * píldora de la lista de chats. En su lugar vuelve el corte por lectura como
 * `unread` — decisión consciente, no un regreso automático a lo viejo: esta
 * vez es GLOBAL de equipo (`unreadCount > 0 || manuallyUnread`, ver
 * `isUnread` en inbox-filters.ts), no por usuario, y una conversación
 * CERRADA con mensajes sin leer sí aparece ahí — cerrar el chat no es
 * leerlo. `filtersForRole` sigue existiendo como punto de entrada por si
 * mañana un rol necesita un corte propio.
 *
 * Tercera reforma (30/8/2026, pedido directo del operador, medida contra
 * producción, no contra intuición): `pending` vuelve, y no es un regreso a
 * ciegas a lo de antes de la segunda reforma. El dato que lo trajo: contra
 * la base real, "No leídas" resultó ser un subconjunto ESTRICTO de
 * "Pendientes" (`awaiting_reply and status <> 'closed'`) — 282 filas contra
 * 51, cero filas de "No leídas" por fuera de "Pendientes". Los 231 chats
 * leídos-y-sin-responder no tenían ninguna píldora que los alcanzara: solo
 * vivían en "Todos", enterrados por el orden por recencia. `pending` entra
 * como cuarta píldora y pasa a ser la que abre la bandeja; `unread` sigue
 * exactamente como la dejó la segunda reforma.
 */
export type InboxFilter = "pending" | "unread" | "mine" | "all" | "unassigned";

export type InboxSort = "recent" | "oldest";

/** Qué categoría detectó la IA en el mensaje del cliente. */
export type AgentIntent = "consulta_disponibilidad" | "devolucion" | "queja" | "otro";

export type AgentTurnAction = "answered" | "escalated" | "error";

/** Una fila de la bitácora de turnos del agente — alimenta el feed en vivo del panel de control. */
export interface AgentTurn {
  id: string;
  conversationId: string;
  /** Con quién fue el turno. Null en los turnos de prueba, sin conversación real. */
  contactName: string | null;
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
