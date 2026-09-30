import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchAgents, fetchBusinessHours, fetchCaseBoard, fetchCurrentAgent, fetchTags } from "@/lib/data";
import { CaseBoardView } from "@/components/casos/case-board-view";

/**
 * «Casos» (T7, plan "La ronda del cliente", 30/9/2026): los chats abiertos en
 * columnas por etiqueta del contacto. Mismo patrón que Ventas: todo lo que la
 * vista necesita para el primer dibujo llega del servidor y el resto se
 * mantiene al día por realtime desde el cliente.
 */
export default async function CasosPage() {
  const supabase = await createClient();

  const [currentAgent, board, tags, agents, businessHours] = await Promise.all([
    fetchCurrentAgent(supabase),
    fetchCaseBoard(supabase),
    fetchTags(supabase),
    fetchAgents(supabase),
    fetchBusinessHours(supabase),
  ]);

  if (!currentAgent) {
    redirect("/login");
  }

  return (
    <CaseBoardView
      currentAgent={currentAgent}
      initialConversations={board.conversations}
      truncated={board.truncated}
      tags={tags}
      agents={agents}
      businessHours={businessHours}
    />
  );
}
