import {
  DEFAULT_BUSINESS_HOURS,
  businessMinutesBetween,
  type BusinessHours,
} from "@/lib/business-hours";
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
// El recorrido que describe el operador (5/9/2026, "El reloj dice la
// verdad"): Primer contacto → Consulta → Clasificando → Herramienta → Con
// asesor. `journey_stage` es lo que escribe la IA en vivo, pero es un resto
// que puede quedar congelado (un turno rechazado por Meta, por ejemplo, ver
// `rejectedByMeta` en `agent.ts`/A3) o directamente pegajoso
// (`journey_stage = 'assigned'` sobrevive a que el asesor se desasigne).
// `stageOf` YA NO confía en él a ciegas: solo lo consulta donde la etapa no
// se puede deducir de otra cosa (`classifying`/`tool_running`), y siempre
// bajo `awaitingReply` — sin eso es un resto, no una etapa real.
// ---------------------------------------------------------------------------

export interface JourneyStage {
  id: JourneyStageId;
  label: string;
  caption: string;
  /**
   * Minutos a partir de los cuales una conversación en esta etapa se
   * considera atascada. `null` = nunca se atasca en esta etapa (hoy solo
   * "Primer contacto": recibió la bienvenida y el reloj de la bienvenida no
   * corre contra el cliente).
   */
  stallMinutes: number | null;
  conversations: BoardConversation[];
  stalled: number;
}

const STAGE_DEFINITIONS: Omit<JourneyStage, "conversations" | "stalled">[] = [
  {
    id: "first_contact",
    label: "Primer contacto",
    caption: "Escribió por primera vez; recibió la bienvenida y esperamos su siguiente mensaje",
    stallMinutes: null,
  },
  {
    id: "inquiry",
    label: "Consulta",
    caption: "Pregunta y espera respuesta",
    stallMinutes: 15,
  },
  {
    id: "classifying",
    label: "Clasificando",
    caption: "La IA determina qué necesita",
    stallMinutes: 5,
  },
  {
    id: "tool_running",
    label: "Herramienta",
    caption: "La IA consulta o ejecuta una herramienta",
    stallMinutes: 3,
  },
  {
    id: "assigned",
    label: "Con asesor",
    caption: "Un asesor lleva el caso",
    stallMinutes: 60,
  },
];

/** La última etapa se pinta como destino del recorrido, no como una más. */
export const TERMINAL_STAGE: JourneyStageId = "assigned";

/** El tablero solo muestra recorridos vivos: lo cerrado ya no está en camino. */
export function isActive(conversation: BoardConversation): boolean {
  return conversation.status !== "closed";
}

/**
 * Escalera de la etapa, en el orden que describe el operador (5/9/2026,
 * "El reloj dice la verdad"). Primer peldaño que cumple, gana:
 *
 * 1. Hay asesor asignado → `assigned`. Un `journey_stage = 'assigned'` SIN
 *    asesor ya no cuenta acá (el punto 3 del diagnóstico: el lead sin dueño
 *    disfrazado de atendido) — sigue bajando la escalera.
 * 2. Espera respuesta y hay una herramienta corriendo (en vivo o escrita en
 *    `journey_stage`) → `tool_running`.
 * 3. Espera respuesta, `journey_stage = 'classifying'` y la IA sigue activa
 *    → `classifying`. Sin `awaitingReply`, un `classifying`/`tool_running`
 *    escrito es un resto congelado (punto 4 del diagnóstico, ver
 *    `rejectedByMeta` en `agent.ts`) y no se honra: sigue bajando.
 * 4. No espera respuesta, recibió la bienvenida y su último mensaje es anterior
 *    (o igual) a esa bienvenida → `first_contact`: todavía no escribió su
 *    siguiente mensaje.
 * 5. Todo lo demás → `inquiry`. Cubre dos casos bien distintos a propósito:
 *    el cliente pregunta y espera (atascable) y el cliente calló tras la
 *    respuesta de la IA (no atascable, se pinta en gris) — los separa
 *    `awaitingReply`, no la etapa.
 */
export function stageOf(conversation: BoardConversation): JourneyStageId {
  if (conversation.assignedAgent) return "assigned";

  const waiting = awaitingReply(conversation);

  if (waiting && (conversation.activeTool || conversation.journeyStage === "tool_running")) {
    return "tool_running";
  }

  if (waiting && conversation.journeyStage === "classifying" && conversation.aiEnabled) {
    return "classifying";
  }

  if (
    !waiting &&
    conversation.welcomeSentAt &&
    conversation.lastCustomerMessageAt &&
    new Date(conversation.lastCustomerMessageAt) <= new Date(conversation.welcomeSentAt)
  ) {
    return "first_contact";
  }

  return "inquiry";
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

/**
 * Nadie dio una respuesta real desde el último mensaje del cliente.
 *
 * Compara `lastReplyAt` contra `lastCustomerMessageAt`, no `lastMessageAt`:
 * hasta el 4/9/2026 comparaba contra `lastMessageAt`, que avanzaba con
 * CUALQUIER mensaje visible —una nota interna, un evento de sistema, la
 * bienvenida automática o un envío que Meta rechazó también lo movían— y
 * apagaba "esperando respuesta" sin que el cliente hubiera recibido nada de
 * nadie. Desde la migración 20260905010000 (T0.1, "La bandeja que no
 * pierde") solo lo apaga una respuesta real de un asesor o la IA. Mismo
 * operador `<=` que usa la columna generada `awaiting_reply` en la base
 * (ver esa migración): `lastReplyAt` null cuenta como "todavía esperando",
 * igual que un `lastReplyAt` que quedó antes del último mensaje del cliente.
 */
export function awaitingReply(conversation: BoardConversation): boolean {
  if (!conversation.lastCustomerMessageAt) return false;
  if (!conversation.lastReplyAt) return true;
  return new Date(conversation.lastReplyAt) <= new Date(conversation.lastCustomerMessageAt);
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

/**
 * Reloj de la cola de reclamos (`ticketQueue`/`buildTicketStats.unanswered`
 * ya no lo usa, ese va por `isStalePending`; queda para ordenar la cola por
 * "quién lleva más tiempo callado" usando el último mensaje visible).
 *
 * YA NO es el reloj del tablero de "Atascados": medía desde `lastMessageAt`,
 * que una nota interna, un evento de sistema o una respuesta de la IA
 * reinician sin que el cliente haya hecho nada (punto 1 del diagnóstico del
 * Frente A, "El reloj dice la verdad", 5/9/2026). El tablero usa
 * `waitingMinutes`, que mide desde `lastCustomerMessageAt` y solo cuenta si
 * de verdad se espera respuesta.
 */
export function minutesInStage(conversation: BoardConversation, now: number): number {
  const since = conversation.lastMessageAt ?? conversation.createdAt;
  return (now - new Date(since).getTime()) / 60000;
}

/**
 * Minutos que el cliente lleva esperando, o `null` si no aplica: la
 * conversación está cerrada (Roberto, tabla de casos del artefacto — lo
 * cerrado ya no está "en camino", igual que `isActive`), no espera respuesta
 * (`!awaitingReply`), o directamente no hay `lastCustomerMessageAt`. El
 * reloj es UNO —`lastCustomerMessageAt`— para las cuatro etapas de la IA, de
 * pared: la IA trabaja las 24 h. Solo en "Con asesor" el tiempo se mide en
 * minutos de horario LABORAL (`businessMinutesBetween`): de noche o domingo
 * un asesor no está atascado, aunque el reloj de pared ya lleve horas
 * corriendo (Ana, misma tabla: horas de pared de sobra pero menos de 60 min
 * laborales).
 */
export function waitingMinutes(
  conversation: BoardConversation,
  now: number,
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS
): number | null {
  if (!isActive(conversation)) return null;
  if (!awaitingReply(conversation)) return null;
  if (!conversation.lastCustomerMessageAt) return null;

  const from = new Date(conversation.lastCustomerMessageAt);
  const to = new Date(now);

  if (stageOf(conversation) === "assigned") {
    return businessMinutesBetween(from, to, hours);
  }

  return (now - from.getTime()) / 60000;
}

/**
 * ¿Esta conversación está atascada? Única fórmula (Frente A, definición
 * nueva): tiene que estar esperando respuesta Y su etapa tiene un umbral Y
 * la espera ya lo superó. Si la pelota está del lado del cliente
 * (`waitingMinutes` null) o la etapa nunca se atasca (`stallMinutes` null,
 * hoy solo "Primer contacto") no hay atasco posible, esté donde esté.
 * Exportada aparte para que la UI (A4) no reimplemente esta cuenta.
 */
export function isStalled(
  conversation: BoardConversation,
  now: number,
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS
): boolean {
  const stage = STAGE_DEFINITIONS.find((definition) => definition.id === stageOf(conversation));
  const stallMinutes = stage?.stallMinutes ?? null;
  if (stallMinutes === null) return false;

  const waiting = waitingMinutes(conversation, now, hours);
  return waiting !== null && waiting >= stallMinutes;
}

export function buildJourney(
  conversations: BoardConversation[],
  now: number,
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS
): JourneyStage[] {
  const active = conversations.filter(isActive);

  return STAGE_DEFINITIONS.map((definition) => {
    const inStage = active.filter((c) => stageOf(c) === definition.id);

    // Primero las que esperan respuesta, con mayor espera arriba; después
    // las que no esperan (la pelota está del lado del cliente), por último
    // mensaje descendente — orden pedido por el operador: lo urgente arriba.
    const sorted = [...inStage].sort((a, b) => {
      const waitingA = waitingMinutes(a, now, hours);
      const waitingB = waitingMinutes(b, now, hours);

      if (waitingA !== null && waitingB !== null) return waitingB - waitingA;
      if (waitingA !== null) return -1;
      if (waitingB !== null) return 1;

      const lastA = new Date(a.lastMessageAt ?? a.createdAt).getTime();
      const lastB = new Date(b.lastMessageAt ?? b.createdAt).getTime();
      return lastB - lastA;
    });

    return {
      ...definition,
      conversations: sorted,
      stalled: inStage.filter((c) => isStalled(c, now, hours)).length,
    };
  });
}

/**
 * Qué se muestra bajo el nombre en la tarjeta: lo más útil de esa etapa.
 * En "clasificando" interesa la intención; en "herramienta", cuál corre. En
 * "Consulta" sin `awaitingReply` la pelota está del lado del cliente —lo que
 * ya respondió la IA no interesa, interesa que sigue en silencio— así que
 * ahí se pinta "sin respuesta del cliente" en vez del `intent`.
 */
export function stageDetail(conversation: BoardConversation, stage: JourneyStageId): string | null {
  if (stage === "tool_running") return conversation.activeTool;
  if (stage === "classifying") return conversation.intent;
  if (stage === "assigned") return conversation.assignedAgent?.displayName ?? null;
  if (stage === "first_contact") return "esperando su siguiente mensaje";
  if (stage === "inquiry" && !awaitingReply(conversation)) return "sin respuesta del cliente";
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
