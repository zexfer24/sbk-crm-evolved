import type { ConversationSummary, InboxFilter } from "@/lib/types";
import { isUnread } from "@/lib/inbox-filters";

/**
 * Los cuatro cortes de la bandeja tras la reforma del 30/8/2026: "Pendientes"
 * (partida en Sin abrir/Leídas sin responder), "No leídas" (sección única,
 * corte global de equipo), "Mías" (partida en Sin leer/Leídas) y "Todos"
 * (sección única).
 *
 * Historia de "Pendientes" acá: la reforma del 28/8/2026 (tarde) la había
 * sacado de la bandeja entera —el corte por ventana de 24h vivía solo en
 * `dashboard.ts` y el AgentHomePanel— porque entonces la bandeja tenía tres
 * píldoras: `unread`, `mine`, `all`. La reforma del 30/8/2026 la trajo de
 * vuelta (ver el comentario de `InboxFilter` en types.ts y el de `case
 * "pending"` en inbox-filters.ts para el dato que la justifica), y acá se
 * parte por LECTURA —no por la ventana de 24h, que sigue siendo terreno del
 * Dashboard—: dentro de "Pendientes" importa si el asesor ya abrió el chat,
 * no cuánto tiempo lleva esperando.
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
// `now` no lo usa ninguna rama —"Pendientes" vuelve a la reforma del
// 30/8/2026, pero partida por LECTURA, no por la ventana de 24h (ver el
// comentario de cabecera)— pero se conserva en la firma: los cuatro cortes
// comparten una sola función y cambiarla por rama según quién la necesita es
// más costura de la que vale forzar hoy.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildInboxSections(filter: InboxFilter, conversations: ConversationSummary[], now: Date): InboxSection[] {
  switch (filter) {
    // Partida por LECTURA, deliberadamente: "Pendientes" ya filtró por
    // `awaitingReply`/`status` (inbox-filters.ts), así que acá lo único que
    // queda por distinguir es si el asesor ya abrió el chat o no. Ids en
    // paralelo a los de "mine" (sin-leer/leidas) pero con nombre propio para
    // no repetirlos: dos píldoras con secciones "Sin leer" idénticas de
    // nombre confundirían más de lo que ordenan.
    case "pending": {
      const sinAbrir = conversations.filter(isUnread);
      const leidasSinResponder = conversations.filter((c) => !isUnread(c));

      return [
        section("sin-abrir", "Sin abrir", sinAbrir),
        section("leidas-sin-responder", "Leídas sin responder", leidasSinResponder),
      ].filter((s): s is InboxSection => s !== null);
    }

    // Sección única sin encabezado: dentro de "Sin dueño" todas las filas
    // comparten lo único que importa —nadie está a cargo—, y partirlas por
    // lectura repetiría lo que el badge de cada fila ya dice. Por qué las
    // soltó (la IA apagada, la ventana vencida, tres intentos fallidos) es
    // información de la bitácora, no de la lista.
    case "unassigned":
      return [{ id: "sin-dueno", label: null, conversations }];

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
