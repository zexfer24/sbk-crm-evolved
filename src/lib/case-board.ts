import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from "@/lib/business-hours";
import { isStalled } from "@/lib/dashboard";
import { normalizeForSearch } from "@/lib/message-search";
import type { ConversationSummary, Tag, TagColor } from "@/lib/types";

/**
 * El tablero de la sección «Casos» (T7, plan "La ronda del cliente",
 * 30/9/2026): una columna por etiqueta y una tarjeta por chat abierto.
 * Arrastrar una tarjeta a otra columna le cambia la etiqueta al contacto.
 *
 * Las etiquetas son del CONTACTO (`contact_tags`), no de la conversación. Por
 * eso un contacto con dos etiquetas sale en las dos columnas, y moverlo desde
 * una no lo saca de la otra. Este módulo es puro a propósito, igual que
 * `inbox-filters`/`dashboard`: la vista solo pinta lo que sale de acá.
 */

/** La columna de los chats cuyo contacto no tiene ninguna etiqueta. Va siempre al final. */
export const UNTAGGED_COLUMN_ID = "sin-etiqueta";
export const UNTAGGED_COLUMN_LABEL = "Sin etiqueta";

/**
 * Tope de chats abiertos que carga el tablero. No es un corte silencioso:
 * `fetchCaseBoard` pide uno de más y la pantalla avisa si hubo más.
 */
export const CASE_BOARD_LIMIT = 500;

export interface CaseColumn {
  id: string;
  label: string;
  /** Null en «Sin etiqueta»: no tiene color propio. */
  color: TagColor | null;
  cards: ConversationSummary[];
  count: number;
  /** Cuántas tarjetas de la columna están atascadas (`isStalled`, la definición única). */
  stalled: number;
}

export interface CaseBoardOptions {
  /** Busca por nombre (guardado o de perfil) o por teléfono, sin acentos ni mayúsculas. */
  query?: string;
  /** Id del asesor asignado; `"none"` = sin asesor; vacío o null = todos. */
  agentId?: string | null;
  now?: Date;
  hours?: BusinessHours;
}

/** El valor del filtro de asesor que deja solo los chats sin nadie asignado. */
export const NO_AGENT_FILTER = "none";

function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

/**
 * ¿El chat calza con la búsqueda? El teléfono se guarda con código de país
 * (+58 414…) y el asesor lo escribe como lo dice en voz alta (0414…): se
 * compara contra las dos formas.
 */
function matchesQuery(conversation: ConversationSummary, query: string): boolean {
  const normalized = normalizeForSearch(query).trim();
  if (!normalized) return true;

  const { displayName, profileName, phoneNumber } = conversation.contact;
  const names = [displayName, profileName].filter((n): n is string => Boolean(n)).map(normalizeForSearch);
  if (names.some((name) => name.includes(normalized))) return true;

  const queryDigits = digitsOf(normalized);
  // Solo se compara el número si la búsqueda es, de verdad, un número: "ana 2"
  // no tiene por qué calzar con cualquier teléfono que tenga un 2.
  if (queryDigits.length === 0 || /[a-z]/.test(normalized)) return false;
  const phone = digitsOf(phoneNumber);
  const local = phone.startsWith("58") ? `0${phone.slice(2)}` : phone;
  return phone.includes(queryDigits) || local.includes(queryDigits);
}

function matchesAgent(conversation: ConversationSummary, agentId: string | null | undefined): boolean {
  if (!agentId) return true;
  if (agentId === NO_AGENT_FILTER) return conversation.assignedAgent === null;
  return conversation.assignedAgent?.id === agentId;
}

/** Más reciente arriba; un chat sin mensajes todavía, al fondo. */
function byRecency(a: ConversationSummary, b: ConversationSummary): number {
  const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : Number.NEGATIVE_INFINITY;
  const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : Number.NEGATIVE_INFINITY;
  if (ta !== tb) return tb > ta ? 1 : -1;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

export function buildCaseBoard(
  conversations: ConversationSummary[],
  tags: Tag[],
  opts: CaseBoardOptions = {}
): CaseColumn[] {
  const now = (opts.now ?? new Date()).getTime();
  const hours = opts.hours ?? DEFAULT_BUSINESS_HOURS;

  // Las columnas salen de la lista de etiquetas MÁS las que traen los
  // contactos: una etiqueta recién creada que todavía no llegó por
  // `fetchTags` no puede hacer desaparecer del tablero a quien ya la tiene.
  const byId = new Map<string, Tag>();
  for (const tag of tags) byId.set(tag.id, tag);
  for (const conversation of conversations) {
    for (const tag of conversation.contact.tags) {
      if (!byId.has(tag.id)) byId.set(tag.id, tag);
    }
  }

  const sortedTags = [...byId.values()].sort((a, b) => a.label.localeCompare(b.label, "es"));
  const cardsByColumn = new Map<string, ConversationSummary[]>(sortedTags.map((t) => [t.id, []]));
  cardsByColumn.set(UNTAGGED_COLUMN_ID, []);

  const visible = conversations
    .filter((c) => matchesAgent(c, opts.agentId))
    .filter((c) => matchesQuery(c, opts.query ?? ""))
    .sort(byRecency);

  for (const conversation of visible) {
    const contactTags = conversation.contact.tags;
    if (contactTags.length === 0) {
      cardsByColumn.get(UNTAGGED_COLUMN_ID)!.push(conversation);
      continue;
    }
    // Un contacto podría traer la misma etiqueta dos veces en una carrera de
    // realtime; la tarjeta sale una sola vez por columna.
    for (const tagId of new Set(contactTags.map((t) => t.id))) {
      cardsByColumn.get(tagId)!.push(conversation);
    }
  }

  const column = (id: string, label: string, color: TagColor | null): CaseColumn => {
    const cards = cardsByColumn.get(id)!;
    return {
      id,
      label,
      color,
      cards,
      count: cards.length,
      stalled: cards.filter((c) => isStalled(c, now, hours)).length,
    };
  };

  return [
    ...sortedTags.map((tag) => column(tag.id, tag.label, tag.color)),
    column(UNTAGGED_COLUMN_ID, UNTAGGED_COLUMN_LABEL, null),
  ];
}

export interface TagMove {
  remove?: string;
  add?: string;
}

/**
 * Qué hay que tocar en `contact_tags` al llevar una tarjeta de una columna a
 * otra. Mover a «Sin etiqueta» quita solo la etiqueta de ORIGEN: si el
 * contacto tiene otras, la tarjeta sigue en esas columnas (quitarlas todas
 * sería borrar de un gesto lo que otro asesor puso).
 */
export function planTagMove(
  fromColumnId: string,
  toColumnId: string,
  contactTagIds: string[]
): TagMove | null {
  if (fromColumnId === toColumnId) return null;
  if (fromColumnId === UNTAGGED_COLUMN_ID) return { add: toColumnId };
  if (toColumnId === UNTAGGED_COLUMN_ID) return { remove: fromColumnId };
  if (contactTagIds.includes(toColumnId)) return { remove: fromColumnId };
  return { remove: fromColumnId, add: toColumnId };
}

/**
 * Las etiquetas del contacto después de aplicar el movimiento, para la
 * actualización optimista. `tagFor` resuelve el id de destino a la etiqueta
 * completa (label y color) que pinta la tarjeta.
 */
export function applyTagMove(current: Tag[], move: TagMove, tagFor: (id: string) => Tag | undefined): Tag[] {
  let next = move.remove ? current.filter((t) => t.id !== move.remove) : current;
  if (move.add && !next.some((t) => t.id === move.add)) {
    const tag = tagFor(move.add);
    if (tag) next = [...next, tag];
  }
  return next;
}
