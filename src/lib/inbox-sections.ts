import type { ConversationSummary } from "@/lib/types";
import { withinFreeformWindow } from "@/lib/dashboard";

/**
 * Los tres cortes de la reforma de píldoras: pendientes de responder (con
 * las dos sub-secciones de la ventana de 24h), lo mío, y todo.
 *
 * Local a este módulo a propósito: `InboxFilter` (src/lib/types.ts) todavía
 * conserva los miembros viejos (`unread`, `unassigned`, `assigned`,
 * `mine-unread`) mientras otra tarea en paralelo lo reduce a estas tres
 * píldoras. Cuando converja, este tipo puede volver a ser un alias de
 * `InboxFilter` sin tocar el resto del archivo.
 */
export type SectionableFilter = "pending" | "mine" | "all";

/**
 * Un grupo de filas dentro de la lista de la bandeja. `label: null` significa
 * "sin encabezado": la píldora "Todos" no subdivide nada.
 */
export interface InboxSection {
  id: string;
  label: string | null;
  conversations: ConversationSummary[];
}

/**
 * Tope de filas que la bandeja le va a pedir a la base para la sección
 * "Esperando +24 h" (la de "pending"). Valor conservador inicial: el
 * operador lo va a ajustar con el dato real de producción (cuántas
 * conversaciones libres quedan sin respuesta pasadas las 24 h) — pregunta
 * operativa pendiente.
 *
 * Este módulo NO aplica el límite: es una regla de la consulta que alimenta
 * la lista, no de esta función pura. Vive acá para que el número quede junto
 * a la sección a la que pertenece en vez de enterrado en `data.ts`.
 */
export const PENDING_STALE_LIMIT = 100;

function isUnread(conversation: ConversationSummary): boolean {
  // Misma semántica que `matchesFilter` en inbox-filters.ts: un chat sin
  // mensajes por leer pero apartado a mano sigue contando como no leído.
  return conversation.unreadCount > 0 || conversation.manuallyUnread;
}

function section(id: string, label: string | null, conversations: ConversationSummary[]): InboxSection | null {
  if (conversations.length === 0) return null;
  return { id, label, conversations };
}

/**
 * Parte la lista YA filtrada y YA ordenada por el sort activo en las
 * secciones que le corresponden a cada píldora. No reordena: respeta el
 * orden de entrada dentro de cada sección (decisión aprobada — las secciones
 * respetan el botón de orden de la bandeja).
 */
export function buildInboxSections(
  filter: SectionableFilter,
  conversations: ConversationSummary[],
  now: Date
): InboxSection[] {
  switch (filter) {
    case "pending": {
      const nowMs = now.getTime();
      const nuevos: ConversationSummary[] = [];
      const esperando: ConversationSummary[] = [];

      for (const conversation of conversations) {
        // `withinFreeformWindow` falla cerrado con `lastCustomerMessageAt`
        // null (devuelve false): sin fecha del cliente no hay ventana
        // abierta, así que esas filas caen directo en "Esperando +24 h".
        if (withinFreeformWindow(conversation.lastCustomerMessageAt, nowMs)) {
          nuevos.push(conversation);
        } else {
          esperando.push(conversation);
        }
      }

      return [
        section("nuevos", "Nuevos · últimas 24 h", nuevos),
        section("esperando", "Esperando +24 h", esperando),
      ].filter((s): s is InboxSection => s !== null);
    }

    case "mine": {
      const noLeidos = conversations.filter(isUnread);
      const leidos = conversations.filter((c) => !isUnread(c));

      return [section("no-leidos", "No leídos", noLeidos), section("leidos", "Leídos", leidos)].filter(
        (s): s is InboxSection => s !== null
      );
    }

    case "all":
      // Una sola sección sin encabezado: "Todos" no subdivide la lista.
      return [{ id: "todas", label: null, conversations }];
  }
}
