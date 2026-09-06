import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  fetchAgents,
  fetchBusinessHours,
  fetchCurrentAgent,
  fetchDashboardConversations,
  fetchTodayActivity,
} from "@/lib/data";
import { CRM_TIME_ZONE } from "@/lib/time-zone";
import { DashboardView } from "@/components/dashboard/dashboard-view";

export default async function DashboardPage() {
  const supabase = await createClient();

  const [currentAgent, agents, dashboard, activity, businessHours] = await Promise.all([
    fetchCurrentAgent(supabase),
    fetchAgents(supabase),
    fetchDashboardConversations(supabase),
    fetchTodayActivity(supabase, CRM_TIME_ZONE),
    // Lectura liviana y a prueba de fallos: sin el RPC de gasto que trae
    // fetchAgentSettings (no hace falta acá) y con el horario por defecto si
    // la fila no se puede leer, para que un tropiezo acá nunca tumbe la
    // bandeja (Frente B3, "El reloj dice la verdad", 5/9/2026).
    fetchBusinessHours(supabase),
  ]);

  if (!currentAgent) {
    redirect("/login");
  }

  return (
    <DashboardView
      currentAgent={currentAgent}
      agents={agents}
      initialConversations={dashboard.conversations}
      initialTicketTags={dashboard.ticketTags}
      initialActivity={activity}
      timeZone={CRM_TIME_ZONE}
      businessHours={businessHours}
    />
  );
}
