import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  fetchAgentSettings,
  fetchAgentAreas,
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
  fetchPaymentMethods,
  fetchPlaybooks,
  fetchSebaV2Config,
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
    paymentMethods,
    sebaV2Config,
    agentAreas,
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
    // Entrega 2 de Seba v2 (16/11/2026): las dos últimas lecturas ya devuelven
    // `null` solas si falta la migración 20261116030000 (columnas nuevas de
    // `agent_settings` y `agents.areas`), así que no necesitan envoltorio; la
    // lista de formas de pago sí va envuelta porque `payment_methods` es una
    // tabla nueva (20261116020000) que LANZA si falta.
    readListIfTableExists(fetchPaymentMethods(supabase), "las formas de pago"),
    fetchSebaV2Config(supabase),
    fetchAgentAreas(supabase),
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
      initialPaymentMethods={paymentMethods}
      initialSebaV2Config={sebaV2Config}
      initialAgentAreas={agentAreas}
      modelLabel={currentAgentModelLabel()}
    />
  );
}
