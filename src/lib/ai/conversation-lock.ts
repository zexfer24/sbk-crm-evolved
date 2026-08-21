import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Ejecuta `fn` solo si logra tomar el lock de turno de IA de esta
 * conversación (columna `ai_turn_running`). Si ya hay un turno en curso
 * para la misma conversación (dos webhooks casi simultáneos, típico cuando
 * el cliente manda varios mensajes seguidos) se salta sin ejecutar `fn`, en
 * vez de correr dos turnos en paralelo y arriesgar una respuesta duplicada.
 *
 * La adquisición es un UPDATE ... WHERE condicional: atómico a nivel de
 * Postgres, así que protege incluso si el webhook corre en múltiples
 * instancias del proceso (a diferencia de un lock en memoria).
 */
export async function withConversationTurnLock(
  supabase: SupabaseClient<Database>,
  conversationId: string,
  fn: () => Promise<void>
): Promise<void> {
  const { data: acquired } = await supabase
    .from("conversations")
    .update({ ai_turn_running: true })
    .eq("id", conversationId)
    .eq("ai_turn_running", false)
    .select("id");

  if (!acquired || acquired.length === 0) return;

  try {
    await fn();
  } finally {
    await supabase.from("conversations").update({ ai_turn_running: false }).eq("id", conversationId);
  }
}
