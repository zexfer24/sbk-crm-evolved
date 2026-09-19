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
  fetchCatalogLinks,
  fetchCurrentAgent,
  fetchKnowledgeCategories,
  fetchKnowledgeEntries,
  fetchLessons,
  fetchModelPricing,
  fetchPlaybooks,
  fetchQuickReplies,
  fetchTags,
  fetchTokenUsageSummary,
  fetchUnmatchedTurns,
  fetchWhatsappChannelHealth,
} from "@/lib/data";
import { currentAgentModelLabel } from "@/lib/ai/model";
import { AgentControlView } from "@/components/agent-control/agent-control-view";
import { readListIfTableExists } from "@/app/agent-control/degradable-reads";

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
    lessons,
    tags,
    channelHealth,
    catalogLinks,
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
    // T7 ("Seba sale sin pisar a nadie", 19/9/2026): estas dos son las
    // lecturas más nuevas del panel (`ai_lessons`/`catalog_links`) y las
    // únicas que pueden faltar en una base que todavía no corrió sus
    // migraciones — degradan solas a `[]` para que las otras diecisiete no
    // se caigan con ellas y el interruptor global de la IA siga alcanzable.
    // Corrección del 19/9/2026 (hallazgo 6): solo degradan cuando el error
    // dice de verdad "la tabla no existe" (42P01/PGRST205); un timeout o un
    // 5xx se relanza y lo atrapa `error.tsx`, en vez de fingir un panel
    // vacío que un supervisor podría leer como "se borraron los catálogos".
    readListIfTableExists(fetchLessons(supabase), "las lecciones de la IA"),
    fetchTags(supabase),
    fetchWhatsappChannelHealth(supabase),
    readListIfTableExists(fetchCatalogLinks(supabase), "los enlaces de catálogo"),
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
      initialLessons={lessons}
      initialTags={tags}
      initialCatalogLinks={catalogLinks}
      initialChannelHealth={channelHealth}
      modelLabel={currentAgentModelLabel()}
    />
  );
}
