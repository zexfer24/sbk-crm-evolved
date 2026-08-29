import type { ConversationSummary, InboxFilter } from "@/lib/types";
import { isUnread } from "@/lib/inbox-filters";

/**
 * Los tres cortes de la bandeja tras la reforma del 28/8/2026 (tarde):
 * "No leídas" (sección única, corte global de equipo), "Mías" (partida en
 * Sin leer/Leídas) y "Todos" (sección única). El corte por ventana de 24h
 * —"pendientes"— ya no vive acá: se retiró de la bandeja y quedó en
 * `dashboard.ts` y el AgentHomePanel.
 *
 * `InboxFilter` (src/lib/types.ts) ya converge con este módulo: la
 * convergencia que el comentario viejo de acá prometía —cuando la reforma
 * del corte pending/mine/all terminara de asentarse— ya pasó.
 */

/**
 * Un grupo de filas dentro de la lista de la bandeja. `label: null` significa
 * "sin encabezado": las píldoras "No leídas" y "Todos" no subdividen nada.
 */
export interface InboxSection {
  id: string;
  label: string | null;
  conversations: ConversationSummary[];
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
// `now` ya no lo usa ninguna rama —el corte por ventana de 24h se fue con
// `pending`— pero se conserva en la firma: los tres cortes comparten una
// sola función y cambiarla por rama según quién la necesita es más costura
// de la que vale forzar hoy.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildInboxSections(filter: InboxFilter, conversations: ConversationSummary[], now: Date): InboxSection[] {
  switch (filter) {
    case "unread":
      // Sección única sin encabezado, igual que "all": la ventana de 24h es
      // deuda de respuesta, un concepto del dashboard, no de lectura; y
      // subdividir "No leídas" por apartadas-a-mano duplicaría lo que el
      // badge de cada fila ya dice.
      return [{ id: "no-leidas", label: null, conversations }];

    case "mine": {
      // Dentro de "Mías", esta partición es la heredera de la vieja píldora
      // "Míos sin leer". No se llama "No leídas" para no repetir el nombre
      // de la píldora vecina.
      const sinLeer = conversations.filter(isUnread);
      const leidas = conversations.filter((c) => !isUnread(c));

      return [section("sin-leer", "Sin leer", sinLeer), section("leidas", "Leídas", leidas)].filter(
        (s): s is InboxSection => s !== null
      );
    }

    case "all":
      // Una sola sección sin encabezado: "Todos" no subdivide la lista.
      return [{ id: "todas", label: null, conversations }];
  }
}
