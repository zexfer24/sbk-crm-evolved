import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchConversations, fetchCurrentAgent } from "@/lib/data";
import { SalesView } from "@/components/sales/sales-view";

export default async function VentasPage() {
  const supabase = await createClient();

  const [currentAgent, conversations] = await Promise.all([
    fetchCurrentAgent(supabase),
    fetchConversations(supabase),
  ]);

  if (!currentAgent) {
    redirect("/login");
  }
  // El mismo interruptor que saca al agente del reparto de la IA le corta el
  // CRM: desactivado no pasa de aquí. La pantalla de destino cierra la sesión.
  if (!currentAgent.isActive) {
    redirect("/acceso-desactivado");
  }

  return <SalesView currentAgent={currentAgent} initialConversations={conversations} />;
}
