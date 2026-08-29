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
