import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export interface ClaimedAgent {
  id: string;
  displayName: string;
}

/**
 * Elige y "reclama" atómicamente al asesor con `last_assigned_at` más
 * antiguo. Antes, `escalateConversation` solo hacía un SELECT del
 * candidato y recién actualizaba `last_assigned_at` más tarde (vía trigger
 * al asignar la conversación) — dos escalamientos casi simultáneos podían
 * leer el mismo candidato antes de que ninguno lo hubiera "marcado", y
 * ambos le caían al mismo asesor en vez de repartirse.
 *
 * El reclamo usa un UPDATE...WHERE condicionado al valor de
 * `last_assigned_at` que se vio al leer (optimistic concurrency): si otra
 * llamada ya lo reclamó primero, el UPDATE no afecta ninguna fila y se
 * prueba con el siguiente candidato del pool.
 *
 * `excluir` (T10b-2, 29/9/2026, "Nadie sin atender"): ids de asesores que NO
 * pueden recibir el caso — el dueño actual y los que ya rotaron en el mismo
 * episodio de demora. Sin él, el reparto por round-robin podía devolverle la
 * conversación al mismo asesor que llevaba 15 minutos sin contestar. Se
 * filtra en memoria, no en la consulta, y el pool crece en `excluir.length`
 * (5 + excluidos) para que un pool de 5 lleno de excluidos no oculte a un
 * asesor elegible más allá del quinto puesto. Un excluido nunca se "marca"
 * con `last_assigned_at`: no recibió nada, su turno de reparto sigue igual.
 * Si todos los activos están excluidos devuelve `null`, igual que sin
 * asesores. Sin `excluir` (o vacío) el comportamiento es el de siempre.
 */
export async function claimNextAvailableAgent(
  supabase: SupabaseClient<Database>,
  opciones: { excluir?: string[] } = {}
): Promise<ClaimedAgent | null> {
  const excluidos = new Set(opciones.excluir ?? []);
  const { data: candidates } = await supabase
    .from("agents")
    .select("id, display_name, last_assigned_at")
    .eq("is_active", true)
    .order("last_assigned_at", { ascending: true, nullsFirst: true })
    .limit(5 + excluidos.size);

  const elegibles = (candidates ?? []).filter((c) => !excluidos.has(c.id)).slice(0, 5);

  for (const candidate of elegibles) {
    const now = new Date().toISOString();
    const query = supabase.from("agents").update({ last_assigned_at: now }).eq("id", candidate.id);
    const { data: claimed } =
      candidate.last_assigned_at === null
        ? await query.is("last_assigned_at", null).select("id, display_name")
        : await query.eq("last_assigned_at", candidate.last_assigned_at).select("id, display_name");

    if (claimed && claimed.length > 0) {
      return { id: claimed[0].id, displayName: claimed[0].display_name };
    }
    // Otra llamada reclamó este candidato primero — se prueba el siguiente.
  }

  return null;
}
