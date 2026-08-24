import type { Agent, AgentRole, Conversation, InboxFilter, InboxSort } from "@/lib/types";
import { contactName } from "@/lib/dashboard";
import { normalizeForSearch } from "@/lib/message-search";

/**
 * Qué bandejas ve cada quien.
 *
 * El administrador supervisa el trabajo de todos, así que necesita cortes por
 * estado global: qué falta por leer, qué no tiene dueño, qué ya está repartido.
 * El asesor no administra a nadie — sus cortes son sobre lo suyo.
 */
const ADMIN_FILTERS: InboxFilter[] = ["all", "unread", "unassigned", "assigned"];
const AGENT_FILTERS: InboxFilter[] = ["all", "mine", "mine-unread"];

export function filtersForRole(role: AgentRole): InboxFilter[] {
  return role === "agent" ? AGENT_FILTERS : ADMIN_FILTERS;
}

export const INBOX_FILTER_LABELS: Record<InboxFilter, string> = {
  all: "Todos",
  unread: "Sin leer",
  unassigned: "Sin asignar",
  assigned: "Asignados",
  mine: "Míos",
  "mine-unread": "Míos sin leer",
};

export const INBOX_SORT_LABELS: Record<InboxSort, string> = {
  recent: "Más recientes primero",
  oldest: "Más viejos primero",
};

export interface InboxCriteria {
  filter: InboxFilter;
  search: string;
  /**
   * Conversaciones donde el texto buscado aparece dentro de algún mensaje.
   * Lo resuelve Postgres, no el navegador: acá solo llegan los ids. Null
   * mientras la consulta está en vuelo o cuando no hay nada que buscar.
   */
  messageHitIds?: ReadonlySet<string> | null;
  /** Etiqueta elegida en la barra de etiquetas. Null = sin filtrar por etiqueta. */
  tagId: string | null;
  sort: InboxSort;
  /** Quién está mirando la bandeja: define qué es "mío". */
  viewer: Agent;
}

function matchesFilter(conversation: Conversation, filter: InboxFilter, viewer: Agent): boolean {
  const isMine = conversation.assignedAgent?.id === viewer.id;
  const isUnread = conversation.unreadCount > 0 || conversation.manuallyUnread;

  switch (filter) {
    case "all":
      return true;
    case "unread":
      return isUnread;
    case "unassigned":
      return conversation.assignedAgent === null;
    case "assigned":
      return conversation.assignedAgent !== null;
    case "mine":
      return isMine;
    case "mine-unread":
      return isMine && isUnread;
  }
}

/**
 * Tres formas de encontrar un chat: por quién es, por su número, o por algo
 * que se dijo adentro. Las dos primeras se resuelven acá con lo que ya está en
 * memoria; la tercera llega resuelta desde la base.
 *
 * El nombre se compara sin acentos igual que los mensajes: quien busca "jose"
 * espera encontrar a José.
 */
function matchesSearch(
  conversation: Conversation,
  query: string,
  messageHitIds: ReadonlySet<string> | null | undefined
): boolean {
  if (!query) return true;
  if (normalizeForSearch(contactName(conversation)).includes(query)) return true;
  if (conversation.contact.phoneNumber.toLowerCase().includes(query)) return true;
  return messageHitIds?.has(conversation.id) ?? false;
}

function matchesTag(conversation: Conversation, tagId: string | null): boolean {
  if (!tagId) return true;
  return conversation.contact.tags.some((tag) => tag.id === tagId);
}

/**
 * Una conversación sin mensajes no tiene fecha con la que competir. En vez de
 * dejarla flotar (un null ordena distinto en cada motor), se manda siempre al
 * final: da igual si se está mirando lo más nuevo o lo más viejo, ahí no hay
 * nada que leer.
 */
function sortValue(conversation: Conversation): number | null {
  if (!conversation.lastMessageAt) return null;
  const time = new Date(conversation.lastMessageAt).getTime();
  return Number.isNaN(time) ? null : time;
}

export function applyInboxFilters(
  conversations: Conversation[],
  { filter, search, tagId, sort, viewer, messageHitIds }: InboxCriteria
): Conversation[] {
  const query = normalizeForSearch(search).trim();

  const list = conversations.filter(
    (conversation) =>
      matchesFilter(conversation, filter, viewer) &&
      matchesTag(conversation, tagId) &&
      matchesSearch(conversation, query, messageHitIds)
  );

  // Copia: ordenar in situ reordenaría la lista que vive en el estado de React.
  return list.slice().sort((a, b) => {
    const left = sortValue(a);
    const right = sortValue(b);

    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;

    return sort === "recent" ? right - left : left - right;
  });
}
