import type { Agent, AgentRole, ConversationSummary, InboxFilter, InboxSort } from "@/lib/types";
import { awaitingReply, contactName } from "@/lib/dashboard";
import { normalizeForSearch } from "@/lib/message-search";

/**
 * Qué bandejas ve cada quien.
 *
 * El administrador supervisa el trabajo de todos, así que necesita cortes por
 * estado global: qué falta por leer, qué no tiene dueño, qué ya está repartido.
 * El asesor no administra a nadie — sus cortes son sobre lo suyo.
 *
 * `unanswered` es la excepción y va en las dos listas: no es un corte de
 * supervisión ni de propiedad sino la pila de la que se agarra el próximo
 * chat, y eso le sirve igual al que reparte que al que atiende. Va segundo
 * porque se usa como se usa "Todos" —para elegir qué abrir—, no al final
 * junto a los cortes de administración.
 */
const ADMIN_FILTERS: InboxFilter[] = ["all", "unanswered", "unread", "unassigned", "assigned"];
const AGENT_FILTERS: InboxFilter[] = ["all", "unanswered", "mine", "mine-unread"];

export function filtersForRole(role: AgentRole): InboxFilter[] {
  return role === "agent" ? AGENT_FILTERS : ADMIN_FILTERS;
}

export const INBOX_FILTER_LABELS: Record<InboxFilter, string> = {
  all: "Todos",
  // Sin el "Todos" delante: al lado de "Sin leer" y "Sin asignar" no agrega
  // significado, y la bandeja mide 316px — cinco píldoras ya van al límite.
  unanswered: "Sin contestar",
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

function matchesFilter(conversation: ConversationSummary, filter: InboxFilter, viewer: Agent): boolean {
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
    // Trabajo que se puede agarrar ahora mismo: nadie contestó y nadie lo
    // tomó. Se vuelve a comprobar acá aunque la base ya haya filtrado, porque
    // la lista mezcla filas de la consulta con filas vivas de la bandeja: si
    // alguien toma el chat —o le contesta— mientras la lista está abierta,
    // sale solo.
    //
    // Hubo un intento de sumar `!hasReply` a esta condición (80b66b5), para no
    // mostrar al fondo de la lista chats que un asesor ya había respondido a
    // mano —sin asignárselos, que es como trabajan— y a los que el cliente
    // solo contestó "Ok". La intención era buena, pero `hasReply` es un flag
    // vitalicio: lo enciende cualquier salida que no sea del sistema —la IA,
    // el asesor, hasta la plantilla de bienvenida automática que sale con la
    // IA apagada— y nunca se apaga, y el backfill lo dejó encendido en casi
    // todo el histórico. Con esa condición sumada, "Sin contestar" quedó
    // vacío en producción el 28/8/2026: el pendiente real —la IA contestó
    // hace días, el cliente volvió a escribir, nadie respondió eso— quedaba
    // oculto para siempre. La respuesta pendiente se define solo con
    // `awaitingReply` (último mensaje del hilo es del cliente); segmentar por
    // `hasReply` —para no tapar con lo viejo lo recién llegado— es trabajo de
    // la píldora, no de este filtro excluyente.
    case "unanswered":
      return (
        conversation.assignedAgent === null &&
        conversation.status !== "closed" &&
        awaitingReply(conversation)
      );
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
  conversation: ConversationSummary,
  query: string,
  messageHitIds: ReadonlySet<string> | null | undefined
): boolean {
  if (!query) return true;
  if (normalizeForSearch(contactName(conversation)).includes(query)) return true;
  if (conversation.contact.phoneNumber.toLowerCase().includes(query)) return true;
  return messageHitIds?.has(conversation.id) ?? false;
}

function matchesTag(conversation: ConversationSummary, tagId: string | null): boolean {
  if (!tagId) return true;
  return conversation.contact.tags.some((tag) => tag.id === tagId);
}

/**
 * Una conversación sin mensajes no tiene fecha con la que competir. En vez de
 * dejarla flotar (un null ordena distinto en cada motor), se manda siempre al
 * final: da igual si se está mirando lo más nuevo o lo más viejo, ahí no hay
 * nada que leer.
 */
function sortValue(conversation: ConversationSummary): number | null {
  if (!conversation.lastMessageAt) return null;
  const time = new Date(conversation.lastMessageAt).getTime();
  return Number.isNaN(time) ? null : time;
}

export function applyInboxFilters(
  conversations: ConversationSummary[],
  { filter, search, tagId, sort, viewer, messageHitIds }: InboxCriteria
): ConversationSummary[] {
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
