import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// "Total de leads" del Recorrido (T2, corrida "Los números del día",
// 10/9/2026): el pulso de "Nuevos"/"Con la IA"/"Con asesor" ya corta por hoy
// (`buildJourney` con `dayStart`, `dashboard.ts`) — este número es la otra
// mitad de la pregunta del operador, cuánto lleva vendido el negocio en
// total, así que NO lleva ese corte a propósito.
// ---------------------------------------------------------------------------

/**
 * Cuántos leads tiene el CRM, acumulado desde siempre.
 *
 * Un lead es una fila de `conversations`: una por contacto y canal, así la
 * arma el webhook al llegar el primer mensaje (`api/webhooks/whatsapp`).
 * Excluye los contactos agregados A MANO desde la bandeja (T6, "Ningún
 * contacto se escribe dos veces", 8/9/2026) que todavía no escribieron ni
 * una vez — esa fila existe, pero no es un lead todavía, es una libreta de
 * direcciones. `count: "exact", head: true` para no traer las filas: acá
 * solo hace falta el número.
 */
export async function fetchLeadTotal(supabase: SupabaseClient): Promise<number> {
  const { count, error } = await supabase
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .not("last_customer_message_at", "is", null);

  if (error) throw error;
  return count ?? 0;
}
