import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  fetchAgentSettings,
  fetchAgentMetrics,
  fetchAgentSuggestions,
  fetchAgentTools,
  fetchAgentTurns,
  fetchAllAgents,
  fetchConversations,
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
    fetchConversations(supabase),
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
  // El mismo interruptor que saca al agente del reparto de la IA le corta el
  // CRM: desactivado no pasa de aquí. La pantalla de destino cierra la sesión.
  if (!currentAgent.isActive) {
    redirect("/acceso-desactivado");
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
