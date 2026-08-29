import type { ConversationSummary } from "@/lib/types";

/**
 * Punto desde donde retomar la paginación de la bandeja: la última fila de
 * la última página recibida, en el orden del servidor (`last_message_at desc
 * nulls last, id desc`, ver `fetchConversationRows` en `data.ts`).
 *
 * Cursor por VALOR, no por posición (`offset`): un cursor de posición se
 * rompe apenas una fila cruza el borde de página mientras alguien sigue
 * bajando la lista — la fila que sube al tope corre a todas las de abajo una
 * posición, y la página siguiente (pedida por `offset`) salta justo la fila
 * que cruzó. Confirmado en producción el 29/8/2026: la píldora "Todos"
 * reordena ~3 veces por minuto y esas filas saltadas no vuelven nunca
 * (`mergeById` deduplica lo que llega, no recupera lo que jamás se pidió).
 *
 * `lastMessageAt` viaja como el string crudo que trae Supabase
 * (`mapConversationSummary` lo conserva así, sin pasar por `Date`): hacerlo
 * pasar por `new Date()` pierde precisión de microsegundos y rompe el
 * desempate por igualdad exacta contra la base.
 */
export interface ConversationCursor {
  lastMessageAt: string | null;
  id: string;
}

/**
 * El cursor para pedir la página siguiente a esta, o `null` si la página
 * vino vacía — no hay página siguiente que pedir.
 */
export function cursorAfterPage(rows: ConversationSummary[]): ConversationCursor | null {
  const last = rows[rows.length - 1];
  if (!last) return null;
  return { lastMessageAt: last.lastMessageAt, id: last.id };
}

/**
 * Une dos tramos de la lista sin repetir: el primero manda.
 *
 * Sirve para las costuras de toda bandeja paginada. Al refrescar en vivo,
 * `mergeById(cabecera, actual)` deja mandar lo recién traído y conserva las
 * páginas viejas. Al bajar una página, `mergeById(actual, página)` la pega al
 * final. En los dos casos, una conversación que se movió entre medias aparece
 * una sola vez.
 *
 * Vivía duplicada: `crm-shell.tsx` (paginación de "Todos") y el
 * dedupe-append de `loadMoreServerRows` en `inbox-sidebar.tsx` ("No leídas"/
 * "Mías") reimplementaban el mismo invariante cada una por su cuenta — dos
 * copias del "la primera gana, sin repetidos" podían divergir sin que nada lo
 * avisara. Se unificó acá el 29/8/2026, a raíz de una revisión de código.
 */
export function mergeById(
  first: ConversationSummary[],
  second: ConversationSummary[]
): ConversationSummary[] {
  const seen = new Set(first.map((c) => c.id));
  return [...first, ...second.filter((c) => !seen.has(c.id))];
}
