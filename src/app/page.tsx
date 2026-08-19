import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchAgents, fetchConversations, fetchCurrentAgent, fetchTodayActivity } from "@/lib/data";
import { CRM_TIME_ZONE } from "@/lib/time-zone";
import { DashboardView } from "@/components/dashboard/dashboard-view";

export default async function DashboardPage() {
  const supabase = await createClient();

  const [currentAgent, agents, conversations, activity] = await Promise.all([
    fetchCurrentAgent(supabase),
    fetchAgents(supabase),
    fetchConversations(supabase),
    fetchTodayActivity(supabase, CRM_TIME_ZONE),
  ]);

  if (!currentAgent) {
    redirect("/login");
  }

  return (
    <DashboardView
      currentAgent={currentAgent}
      agents={agents}
      initialConversations={conversations}
      initialActivity={activity}
      timeZone={CRM_TIME_ZONE}
    />
  );
}
