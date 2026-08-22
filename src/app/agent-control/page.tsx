import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  fetchAgentSettings,
  fetchAgentSuggestions,
  fetchAgentTurns,
  fetchAllAgents,
  fetchConversations,
  fetchCurrentAgent,
  fetchModelPricing,
  fetchPlaybooks,
  fetchQuickReplies,
  fetchTokenUsageSummary,
  fetchUnmatchedTurns,
} from "@/lib/data";
import { currentAgentModelLabel } from "@/lib/ai/model";
import { AgentControlView } from "@/components/agent-control/agent-control-view";

export default async function AgentControlPage() {
  const supabase = await createClient();

  const [
    currentAgent,
    conversations,
    turns,
    settings,
    agents,
    tokenUsage,
    pricing,
    suggestions,
    playbooks,
    unmatchedTurns,
    quickReplies,
  ] = await Promise.all([
    fetchCurrentAgent(supabase),
    fetchConversations(supabase),
    fetchAgentTurns(supabase),
    fetchAgentSettings(supabase),
    fetchAllAgents(supabase),
    fetchTokenUsageSummary(supabase),
    fetchModelPricing(supabase),
    fetchAgentSuggestions(supabase),
    fetchPlaybooks(supabase),
    fetchUnmatchedTurns(supabase),
    fetchQuickReplies(supabase),
  ]);

  if (!currentAgent) {
    redirect("/login");
  }

  return (
    <AgentControlView
      currentAgent={currentAgent}
      initialConversations={conversations}
      initialTurns={turns}
      initialSettings={settings}
      initialAgents={agents}
      initialTokenUsage={tokenUsage}
      initialPricing={pricing}
      initialSuggestions={suggestions}
      initialPlaybooks={playbooks}
      initialUnmatchedTurns={unmatchedTurns}
      initialQuickReplies={quickReplies}
      modelLabel={currentAgentModelLabel()}
    />
  );
}
