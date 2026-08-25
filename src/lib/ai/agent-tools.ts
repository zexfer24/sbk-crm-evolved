import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// ---------------------------------------------------------------------------
// Interruptores por herramienta del agente.
//
// La decisión de qué herramienta está disponible vive en la base
// (public.agent_tools) para que el panel la cambie en vivo sin desplegar;
// acá solo se lee. Escalar a un asesor no tiene interruptor a propósito:
// es la única salida hacia un humano y no debe poder apagarse por descuido.
// ---------------------------------------------------------------------------

/** Claves de public.agent_tools. Contrato con la migración que las siembra: no se renombran. */
export const TOOL_KEYS = {
  catalog: "buscar_repuesto",
  orderHistory: "buscar_historial_compras",
  knowledge: "consultar_biblioteca",
} as const;

/**
 * Claves de las herramientas encendidas ahora mismo.
 *
 * Si la consulta falla, se corre con TODAS encendidas: es el comportamiento
 * que el agente tenía antes de que existieran los interruptores, y dejar al
 * agente manco por una falla transitoria de lectura sería un apagón que
 * nadie pidió.
 */
export async function fetchEnabledToolKeys(supabase: SupabaseClient<Database>): Promise<Set<string>> {
  const { data, error } = await supabase.from("agent_tools").select("key").eq("is_enabled", true);

  if (error) {
    console.error("No se pudieron leer los interruptores de herramientas; el turno corre con todas:", error);
    return new Set(Object.values(TOOL_KEYS));
  }

  return new Set((data ?? []).map((row) => row.key));
}
