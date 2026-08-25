import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  fetchAgentSettings,
  fetchAgentMetrics,
  fetchAgentSuggestions,
  fetchAgentTools,
  fetchAgentTurns,
  fetchAllAgents,
  fetchBoardConversations,
  fetchCurrentAgent,
  fetchKnowledgeCategories,
  fetchKnowledgeEntries,
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
    agentMetrics,
    playbooks,
    unmatchedTurns,
    quickReplies,
    agentTools,
    knowledgeCategories,
    knowledgeEntries,
  ] = await Promise.all([
    fetchCurrentAgent(supabase),
    // Solo el trabajo vivo: el panel muestra la cola de la IA y el roster,
    // ninguno de los cuales mira conversaciones cerradas.
    fetchBoardConversations(supabase, { activeOnly: true }),
    fetchAgentTurns(supabase),
    fetchAgentSettings(supabase),
    fetchAllAgents(supabase),
    fetchTokenUsageSummary(supabase),
    fetchModelPricing(supabase),
    fetchAgentSuggestions(supabase),
    fetchAgentMetrics(supabase),
    fetchPlaybooks(supabase),
    fetchUnmatchedTurns(supabase),
    fetchQuickReplies(supabase),
    fetchAgentTools(supabase),
    fetchKnowledgeCategories(supabase),
    fetchKnowledgeEntries(supabase),
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
      initialAgentMetrics={agentMetrics}
      initialPlaybooks={playbooks}
      initialUnmatchedTurns={unmatchedTurns}
      initialQuickReplies={quickReplies}
      initialAgentTools={agentTools}
      initialKnowledgeCategories={knowledgeCategories}
      initialKnowledgeEntries={knowledgeEntries}
      modelLabel={currentAgentModelLabel()}
    />
  );
}
