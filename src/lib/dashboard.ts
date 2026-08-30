import type {
  AgentRef,
  BoardConversation,
  JourneyStageId,
  Tag,
  TicketTagsByContact,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Reclamos
//
// Un reclamo no es una entidad aparte: es un contacto etiquetado. Cualquier
// etiqueta cuyo nombre empiece por "Reclamo" cuenta como tal, y lo que va
// después del separador es la categoría ("Reclamo · Envío" -> "Envío").
// Así el equipo abre categorías nuevas desde el panel de etiquetas, sin
// tocar el código ni la base de datos.
// ---------------------------------------------------------------------------

const TICKET_PREFIX = "reclamo";
const CATEGORY_SEPARATORS = /[·:\-–—/]/;

const DIACRITICS = /[̀-ͯ]/g;

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .trim()
    .toLowerCase();
}

export function isTicketTag(tag: Tag): boolean {
  return normalize(tag.label).startsWith(TICKET_PREFIX);
}

export function ticketCategory(tag: Tag): string {
  const parts = tag.label.split(CATEGORY_SEPARATORS);
  const tail = parts.slice(1).join(" ").trim();
  return tail.length > 0 ? tail : "General";
}

/**
 * Las etiquetas de reclamo de una conversación.
 *
 * Salen de un mapa por contacto y no de la propia fila: el tablero pide
 * cientos de conversaciones de una vez, y embeberle a cada una sus etiquetas
 * cuesta un lateral por fila en PostgREST. El mapa son dos consultas planas
 * (ver `fetchTicketTags`).
 */
export function ticketTagsOf(
  conversation: Pick<BoardConversation, "contact">,
  ticketTags: TicketTagsByContact
): Tag[] {
  return ticketTags.get(conversation.contact.id) ?? [];
}

export function isTicket(
  conversation: Pick<BoardConversation, "contact">,
  ticketTags: TicketTagsByContact
): boolean {
  return ticketTagsOf(conversation, ticketTags).length > 0;
}

// ---------------------------------------------------------------------------
// Recorrido del cliente
//
// El agente de IA escribe la etapa en `journey_stage`. Mientras no lo haga,
// se deduce de lo que ya se sabe del hilo: quién habló último, si hay una
// herramienta corriendo, si la IA sigue activa y si hay asesor asignado.
// ---------------------------------------------------------------------------

export interface JourneyStage {
  id: JourneyStageId;
  label: string;
  caption: string;
  /** Minutos a partir de los cuales una conversación en esta etapa se considera atascada. */
  stallMinutes: number;
  conversations: BoardConversation[];
  stalled: number;
}

const STAGE_DEFINITIONS: Omit<JourneyStage, "conversations" | "stalled">[] = [
  {
    id: "first_contact",
    label: "Primer contacto",
    caption: "Escribe por primera vez, le toca bienvenida",
    stallMinutes: 10,
  },
  {
    id: "inquiry",
    label: "Consulta",
    caption: "Pregunta abierta esperando respuesta",
    stallMinutes: 15,
  },
  {
    id: "classifying",
    label: "Clasificando",
    caption: "La IA decide qué necesita el cliente",
    stallMinutes: 5,
  },
  {
    id: "tool_running",
    label: "Herramienta",
    caption: "La IA consulta o ejecuta una acción",
    stallMinutes: 3,
  },
  {
    id: "assigned",
    label: "Con asesor",
    caption: "Un humano lleva el caso",
    stallMinutes: 60 * 24,
  },
];

/** La última etapa se pinta como destino del recorrido, no como una más. */
export const TERMINAL_STAGE: JourneyStageId = "assigned";

/** El tablero solo muestra recorridos vivos: lo cerrado ya no está en camino. */
export function isActive(conversation: BoardConversation): boolean {
  return conversation.status !== "closed";
}

export function stageOf(conversation: BoardConversation): JourneyStageId {
  if (conversation.journeyStage) return conversation.journeyStage;

  if (conversation.assignedAgent) return "assigned";
  if (conversation.activeTool) return "tool_running";

  const waitingOnUs = awaitingReply(conversation);
  if (waitingOnUs && !conversation.welcomeSentAt) return "first_contact";
  if (waitingOnUs) return "inquiry";

  return conversation.aiEnabled ? "classifying" : "inquiry";
}

/**
 * La ventana de texto libre de WhatsApp.
 *
 * Meta solo acepta un mensaje escrito por nosotros dentro de las 24 h
 * siguientes al último mensaje del cliente. Pasado ese punto lo único que
 * entra es una plantilla aprobada, y hoy no hay ninguna configurada
 * (WHATSAPP_WELCOME_TEMPLATE está vacía). O sea que fuera de la ventana no
 * hay nada que enviar: el intento se rechaza y el cliente no recibe nada.
 */
export const FREEFORM_WINDOW_HOURS = 24;

/** El instante a partir del cual un mensaje del cliente todavía habilita texto libre. */
export function freeformWindowCutoff(now: number = Date.now()): string {
  return new Date(now - FREEFORM_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
}

/**
 * ¿Se le puede escribir texto libre a esta conversación ahora mismo?
 *
 * Sin mensaje del cliente devuelve false. Falla cerrado a propósito: el costo
 * de equivocarse hacia el "sí" es un mensaje rechazado por Meta que el
 * cliente nunca ve, y del que solo queda una fila en `messages` diciendo que
 * salió.
 */
export function withinFreeformWindow(lastCustomerMessageAt: string | null, now: number = Date.now()): boolean {
  if (!lastCustomerMessageAt) return false;
  return new Date(lastCustomerMessageAt).getTime() > now - FREEFORM_WINDOW_HOURS * 60 * 60 * 1000;
}

/** El último mensaje del hilo sigue siendo del cliente: nadie contestó. */
export function awaitingReply(conversation: BoardConversation): boolean {
  if (!conversation.lastCustomerMessageAt) return false;
  if (!conversation.lastMessageAt) return true;
  return new Date(conversation.lastMessageAt) <= new Date(conversation.lastCustomerMessageAt);
}

/**
 * ¿Esta conversación es un "pendiente atascado" — nadie contestó y ya pasó
 * la ventana de 24 h?
 *
 * Antes de esto el Dashboard usaba su propio reloj (`minutesInStage`, que
 * mira `lastMessageAt ?? createdAt`): dos fórmulas para la misma frase, dos
 * números que podían contradecirse en pantalla. `isStalePending` unificó el
 * criterio con `withinFreeformWindow(lastCustomerMessageAt)`.
 *
 * Llegó a tener una tercera pata: hasta el 28/8/2026 (tarde) la sección
 * "Esperando +24 h" de `buildInboxSections` (inbox-sections.ts) medía la
 * misma vara, y un test de contrato las mantenía de acuerdo. Esa tarde la
 * reforma le quitó a la bandeja la píldora "Pendientes" entera —con ella se
 * fue esa sección y el test— y el criterio quedó vivo solo acá y en el
 * panel de inicio. La píldora "Pendientes" volvió a la bandeja el
 * 30/8/2026, pero partida por LECTURA (`buildInboxSections`, case
 * "pending"), no por esta ventana: `inbox-sections.ts` ya no es una pata de
 * este contrato. Las patas de hoy —`isStalePending` en memoria,
 * `fetchInboxCounts.pendingStale` y `fetchConversations({pendingWindow})`,
 * ambas en `data.ts`— las amarra `src/lib/ventana-24h-contrato.test.ts`,
 * repuesto ese mismo 30/8/2026.
 */
export function isStalePending(conversation: BoardConversation, now: number = Date.now()): boolean {
  return awaitingReply(conversation) && !withinFreeformWindow(conversation.lastCustomerMessageAt, now);
}

export function minutesInStage(conversation: BoardConversation, now: number): number {
  const since = conversation.lastMessageAt ?? conversation.createdAt;
  return (now - new Date(since).getTime()) / 60000;
}

export function buildJourney(conversations: BoardConversation[], now: number): JourneyStage[] {
  const active = conversations.filter(isActive);

  return STAGE_DEFINITIONS.map((definition) => {
    const inStage = active.filter((c) => stageOf(c) === definition.id);
    return {
      ...definition,
      conversations: inStage.sort((a, b) => minutesInStage(b, now) - minutesInStage(a, now)),
      stalled: inStage.filter((c) => minutesInStage(c, now) >= definition.stallMinutes).length,
    };
  });
}

/**
 * Qué se muestra bajo el nombre en la tarjeta: lo más útil de esa etapa.
 * En "clasificando" interesa la intención; en "herramienta", cuál corre.
 */
export function stageDetail(conversation: BoardConversation, stage: JourneyStageId): string | null {
  if (stage === "tool_running") return conversation.activeTool;
  if (stage === "classifying") return conversation.intent;
  if (stage === "assigned") return conversation.assignedAgent?.displayName ?? null;
  if (stage === "first_contact") return conversation.welcomeSentAt ? null : "sin bienvenida";
  return conversation.intent;
}

// ---------------------------------------------------------------------------
// Estadística de reclamos
// ---------------------------------------------------------------------------

export interface TicketCategoryStat {
  label: string;
  total: number;
  open: number;
  resolved: number;
}

export interface TicketAgentStat {
  agent: AgentRef;
  open: number;
}

export interface TicketStats {
  total: number;
  open: number;
  resolved: number;
  /**
   * Reclamos abiertos que además son un "pendiente atascado" —
   * `isStalePending` — bajo el mismo criterio que usa la bandeja para
   * "Esperando +24 h". Ojo: esto solo cuenta RECLAMOS (contactos
   * etiquetados "Reclamo*"), no todos los pendientes atascados del CRM.
   */
  unanswered: number;
  /** Antigüedad media, en horas, de los reclamos abiertos. */
  averageOpenHours: number;
  categories: TicketCategoryStat[];
  byAgent: TicketAgentStat[];
}

function isResolved(conversation: BoardConversation): boolean {
  return conversation.status === "closed";
}

export function buildTicketStats(
  conversations: BoardConversation[],
  now: number,
  ticketTags: TicketTagsByContact
): TicketStats {
  const tickets = conversations.filter((c) => isTicket(c, ticketTags));
  const open = tickets.filter((c) => !isResolved(c));
  const resolved = tickets.filter(isResolved);

  const categories = new Map<string, TicketCategoryStat>();
  for (const ticket of tickets) {
    for (const tag of ticketTagsOf(ticket, ticketTags)) {
      const label = ticketCategory(tag);
      const stat = categories.get(label) ?? { label, total: 0, open: 0, resolved: 0 };
      stat.total += 1;
      if (isResolved(ticket)) stat.resolved += 1;
      else stat.open += 1;
      categories.set(label, stat);
    }
  }

  const agents = new Map<string, TicketAgentStat>();
  for (const ticket of open) {
    const agent = ticket.assignedAgent;
    if (!agent) continue;
    const stat = agents.get(agent.id) ?? { agent, open: 0 };
    stat.open += 1;
    agents.set(agent.id, stat);
  }

  const totalOpenHours = open.reduce(
    (sum, c) => sum + (now - new Date(c.createdAt).getTime()) / 3600000,
    0
  );

  return {
    total: tickets.length,
    open: open.length,
    resolved: resolved.length,
    unanswered: open.filter((c) => isStalePending(c, now)).length,
    averageOpenHours: open.length > 0 ? totalOpenHours / open.length : 0,
    categories: [...categories.values()].sort((a, b) => b.total - a.total),
    byAgent: [...agents.values()].sort((a, b) => b.open - a.open),
  };
}

/** Reclamos abiertos ordenados por urgencia: primero los que llevan más tiempo callados. */
export function ticketQueue(
  conversations: BoardConversation[],
  now: number,
  ticketTags: TicketTagsByContact
): BoardConversation[] {
  return conversations
    .filter((c) => isTicket(c, ticketTags) && !isResolved(c))
    .sort((a, b) => minutesInStage(b, now) - minutesInStage(a, now));
}

// ---------------------------------------------------------------------------
// Utilidades de presentación
// ---------------------------------------------------------------------------

/** Estructural a propósito: sirve igual para la fila de bandeja, la venta o la conversación completa. */
export function contactName(conversation: {
  contact: { displayName: string | null; profileName: string | null; phoneNumber: string };
}): string {
  return (
    conversation.contact.displayName ??
    conversation.contact.profileName ??
    conversation.contact.phoneNumber
  );
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Duración compacta pensada para tarjetas estrechas: 8 m, 3 h, 2 d. */
export function compactDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return "ahora";
  if (minutes < 60) return `${Math.round(minutes)} m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}
