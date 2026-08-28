import type { Agent, AgentRole, ConversationSummary, InboxFilter, InboxSort } from "@/lib/types";
import { awaitingReply, contactName } from "@/lib/dashboard";
import { normalizeForSearch } from "@/lib/message-search";

/**
 * Qué bandejas ve cada quien.
 *
 * Reforma del 28/8/2026: antes el administrador tenía cinco cortes propios
 * (todo, sin contestar, sin leer, sin asignar, asignados) y el asesor cuatro
 * (todo, sin contestar, lo suyo, lo suyo sin leer). Los cortes por
 * leído/asignado resultaron ser guardas poco fiables —ver el comentario del
 * case `pending` más abajo— así que se bajó a tres píldoras iguales para
 * todos los roles: `pending`, `mine`, `all`.
 *
 * La función se conserva igual como costura: si mañana un rol necesita un
 * corte propio, el punto de entrada por rol ya existe y no hay que inventar
 * de nuevo el mecanismo, solo la lista.
 */
const DEFAULT_FILTERS: InboxFilter[] = ["pending", "mine", "all"];

// El parámetro no se usa a propósito: es la costura descrita arriba.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function filtersForRole(_role: AgentRole): InboxFilter[] {
  return DEFAULT_FILTERS;
}

export const INBOX_FILTER_LABELS: Record<InboxFilter, string> = {
  pending: "Pendientes",
  mine: "Míos",
  all: "Todos",
};

/** Al entrar a la bandeja se ve lo que falta por atender, no todo el ruido. */
export const DEFAULT_INBOX_FILTER: InboxFilter = "pending";

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
  switch (filter) {
    case "all":
      return true;
    case "mine":
      return conversation.assignedAgent?.id === viewer.id;
    // Trabajo que falta por atender. Se vuelve a comprobar acá aunque la base
    // ya haya filtrado, porque la lista mezcla filas de la consulta con filas
    // vivas de la bandeja: si alguien le contesta mientras la lista está
    // abierta, sale solo.
    //
    // Esta condición pasó por tres actos.
    //
    // (a) 80b66b5 sumó `!hasReply` para no mostrar al fondo de la lista chats
    // que un asesor ya había respondido a mano —sin asignárselos, que es como
    // trabajan— y a los que el cliente solo contestó "Ok". La intención era
    // buena, pero `hasReply` es un flag vitalicio: lo enciende cualquier
    // salida que no sea del sistema —la IA, el asesor, hasta la plantilla de
    // bienvenida automática que sale con la IA apagada— y nunca se apaga, y
    // el backfill lo dejó encendido en casi todo el histórico. Con esa
    // condición sumada, la píldora quedó vacía en producción el 28/8/2026: el
    // pendiente real —la IA contestó hace días, el cliente volvió a
    // escribir, nadie respondió eso— quedaba oculto para siempre.
    //
    // (b) El hotfix del mismo día devolvió el filtro a tres condiciones: sin
    // dueño, abierta, y `awaitingReply` (último mensaje del hilo es del
    // cliente).
    //
    // (c) Esta reforma retira también la condición de "sin dueño"
    // (`assignedAgent === null`). No es un ajuste cosmético: ese campo no es
    // confiable —los asesores de SBK contestan sin asignarse la conversación,
    // ver `human-handled.ts:17-21`— y con él puesto, un chat escalado o
    // asignado al que nadie le respondió quedaba fuera del pendiente aunque
    // fuera el más grave de todos. La separación entre lo recién llegado y lo
    // viejo ya no es trabajo de este filtro excluyente: vive en las secciones
    // por ventana de 24h (`src/lib/inbox-sections.ts`).
    case "pending":
      return conversation.status !== "closed" && awaitingReply(conversation);
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
