import type { Agent, AgentRole, ConversationSummary, InboxFilter, InboxSort } from "@/lib/types";
import { awaitingReply, contactName } from "@/lib/dashboard";
import { normalizeForSearch } from "@/lib/message-search";

/**
 * Qué bandejas ve cada quien.
 *
 * Primera reforma del 28/8/2026 (mañana): antes el administrador tenía cinco
 * cortes propios (todo, sin contestar, sin leer, sin asignar, asignados) y
 * el asesor cuatro (todo, sin contestar, lo suyo, lo suyo sin leer). Los
 * cortes por leído/asignado resultaron ser guardas poco fiables, así que se
 * bajó a tres píldoras iguales para todos los roles.
 *
 * Segunda reforma (misma tarde, pedido del operador): `pending` sale de la
 * bandeja (su corte sigue en dashboard.ts y el AgentHomePanel) y entra
 * `unread`. La que abre va primera — hoy "No leídas" — y "Todos" cierra a la
 * derecha, adonde salta la búsqueda al escribir. Si el operador pide otro
 * orden mañana, es una línea acá.
 *
 * Tercera reforma (30/8/2026, pedido del operador, medida contra
 * producción): `pending` vuelve como cuarta píldora y pasa a ser la que
 * abre la bandeja. Motivo: "No leídas" es un subconjunto estricto de
 * "Pendientes" (282 filas contra 51, cero fuera), así que 231 chats
 * leídos-y-sin-responder no tenían ninguna píldora que los alcanzara — solo
 * aparecían en "Todos", perdidos en el orden por recencia. Orden final:
 * `pending`, `unread`, `mine`, `all`.
 */
// "Sin dueño" va junto a "Pendientes" y no al final: las dos hablan de
// trabajo que espera, y la nueva es la más urgente de las dos —son los chats
// que el sistema soltó, no los que simplemente no se han contestado.
const DEFAULT_FILTERS: InboxFilter[] = ["pending", "unassigned", "unread", "mine", "all"];

// El parámetro no se usa a propósito: es la costura descrita arriba.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function filtersForRole(_role: AgentRole): InboxFilter[] {
  return DEFAULT_FILTERS;
}

export const INBOX_FILTER_LABELS: Record<InboxFilter, string> = {
  pending: "Pendientes",
  unassigned: "Sin dueño",
  unread: "No leídas",
  mine: "Mías",
  all: "Todos",
};

/**
 * Al entrar a la bandeja se ve el trabajo pendiente de respuesta —no lo sin
 * leer—: la reforma del 30/8/2026 midió que "Pendientes" es la píldora que
 * de verdad cubre el trabajo abierto (ver el comentario de `InboxFilter` en
 * types.ts).
 */
export const DEFAULT_INBOX_FILTER: InboxFilter = "pending";

export const INBOX_SORT_LABELS: Record<InboxSort, string> = {
  recent: "Más recientes primero",
  oldest: "Más viejos primero",
};

/**
 * LA definición de "sin leer": la misma que pinta el badge de cada fila en
 * la lista y la que arma la sub-sección "Sin leer" dentro de "Mías"
 * (`inbox-sections.ts`). Corte GLOBAL de equipo —no importa quién mira—:
 * apartar un chat a mano cuenta igual que tener mensajes sin abrir.
 */
export function isUnread(conversation: ConversationSummary): boolean {
  return conversation.unreadCount > 0 || conversation.manuallyUnread;
}

/**
 * Un traspaso de `conversation_handoffs`, en la forma mínima que hace falta
 * para decidir "sin dueño": a quién pasó y cuándo. `toKind`/`createdAt` y no
 * los nombres crudos de la columna (`to_kind`/`created_at`) porque esto es
 * lógica de negocio, no una fila de base — el llamador (`fetchUnassignedConversations`
 * en data.ts) hace ese mapeo mínimo.
 */
export interface HandoffKind {
  toKind: string;
  createdAt: string;
}

/** El traspaso más reciente, o `null` si la lista viene vacía. */
function latestHandoff(handoffs: readonly HandoffKind[]): HandoffKind | null {
  return handoffs.reduce<HandoffKind | null>(
    (latest, current) => (!latest || current.createdAt > latest.createdAt ? current : latest),
    null
  );
}

/**
 * "Sin dueño" (T1.6 del plan "Ningún lead invisible", 30/8/2026): la
 * conversación sigue esperando respuesta del cliente Y el traspaso MÁS
 * RECIENTE de su bitácora fue a `unassigned` — el sistema la soltó y nadie
 * la retomó desde entonces. Si después de ese traspaso hubo otro —a `ai` o a
 * `human`— alguien ya la agarró y esto deja de ser cierto, aunque el
 * traspaso a `unassigned` siga ahí, más atrás en la historia: por eso se
 * compara SIEMPRE contra el más reciente (`latestHandoff`), nunca contra
 * "¿hay algún traspaso a unassigned en la lista?".
 *
 * Pura y sin Supabase a propósito, como `isUnread`: la usa
 * `fetchUnassignedConversations` (data.ts) sobre lo que ya trajo la base
 * —`awaiting_reply` más el único traspaso más reciente, embebido con
 * `embedLatestHandoff`— y se prueba acá con traspasos fabricados a mano, sin
 * levantar nada.
 */
export function isUnassignedLead(awaitingReply: boolean, handoffs: readonly HandoffKind[]): boolean {
  return awaitingReply && latestHandoff(handoffs)?.toKind === "unassigned";
}

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
    // La única píldora que NO se puede volver a comprobar en memoria: si una
    // conversación quedó sin dueño se decide con su bitácora de traspasos, y
    // `ConversationSummary` no la trae (son otra tabla y hasta 18 razones
    // distintas por fila). Las filas llegan ya filtradas por
    // `fetchUnassignedConversations`, así que acá se dejan pasar tal cual.
    //
    // La consecuencia, y hay que conocerla: una conversación que alguien
    // reclama con la lista abierta NO desaparece sola de esta píldora como sí
    // pasa en "No leídas" — se va en la próxima consulta o al recargar. Es el
    // precio de que el corte viva en otra tabla, y desaparece en la Etapa 2,
    // cuando `owner_kind` sea una columna de `conversations` como las demás.
    case "unassigned":
      return true;
    case "mine":
      return conversation.assignedAgent?.id === viewer.id;
    // Se vuelve a comprobar en memoria aunque la base ya haya filtrado
    // (`unreadOnly` en data.ts), porque la lista mezcla filas de la consulta
    // con filas vivas de la bandeja: si alguien lee el chat mientras la
    // lista está abierta, sale solo.
    case "unread":
      return isUnread(conversation);
    // Se vuelve a comprobar en memoria por la misma razón que "unread": la
    // lista mezcla filas de la consulta —que ya filtró por `activeOnly` y
    // `awaitingReplyOnly` en data.ts— con filas vivas de la bandeja.
    //
    // Esta píldora tiene historia. Pasó por tres actos como `pending` antes
    // de que existiera, un cuarto que la trajo de vuelta.
    //
    // (a) 80b66b5 sumó `!hasReply` a lo que entonces se llamaba "sin
    // contestar", para no mostrar chats que un asesor ya había respondido a
    // mano. La intención era buena, pero `hasReply` es un flag vitalicio —lo
    // enciende cualquier salida que no sea del sistema y nunca se apaga— y
    // el backfill lo dejó encendido en casi todo el histórico: la píldora
    // quedó vacía en producción el 28/8/2026.
    //
    // (b) El hotfix del mismo día devolvió el filtro a sin dueño + abierta +
    // `awaitingReply`.
    //
    // (c) Una reforma posterior, esa misma mañana, retiró también "sin
    // dueño": los asesores de SBK contestan sin asignarse el chat (ver
    // `human-handled.ts:17-21`), así que ese campo no servía de guarda. El
    // filtro quedó como `pending`: abierta + `awaitingReply`.
    //
    // (d) Esa misma tarde, por pedido directo del operador, `pending` se
    // retiró de la bandeja: ese corte —trabajo con más de 24h sin
    // respuesta— siguió vivo en `dashboard.ts` (`awaitingReply`/
    // `isStalePending`) y en el AgentHomePanel, pero dejó de ser una píldora
    // de la lista de chats. En su lugar entró el corte por lectura, ahora
    // GLOBAL de equipo (no por usuario como el viejo "Míos sin leer") y
    // deliberadamente indiferente a si el chat está cerrado: cerrar una
    // conversación no es leerla, así que una cerrada con mensajes sin abrir
    // sigue apareciendo en "unread".
    //
    // (e) 30/8/2026, pedido directo del operador, esta vez medido contra
    // producción: `pending` vuelve. "No leídas" resultó ser un subconjunto
    // ESTRICTO de "Pendientes" —282 filas contra 51, cero filas de "No
    // leídas" por fuera de "Pendientes"— así que los 231 chats
    // leídos-y-sin-responder quedaban sin ninguna píldora que los
    // alcanzara: solo vivían en "Todos", enterrados por el orden por
    // recencia. Vuelve con el mismo predicado del acto (c) —abierta +
    // `awaitingReply`— porque ese predicado nunca fue el problema: el
    // problema fue sacarlo de la bandeja. `awaitingReply` se importa de
    // `dashboard.ts`, que sigue siendo el dueño del corte de 24h
    // (`isStalePending`) para el Dashboard y el AgentHomePanel — esta
    // píldora no reinventa esa definición, solo la reintroduce en la lista
    // de chats.
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
