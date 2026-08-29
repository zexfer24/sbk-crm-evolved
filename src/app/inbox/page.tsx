import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  INBOX_PAGE_SIZE,
  fetchConversations,
  fetchCurrentAgent,
  fetchInboxCounts,
  fetchQuickReplies,
  fetchTags,
  fetchAgentSettings,
} from "@/lib/data";
import { SERVER_FILTER_LIMIT } from "@/lib/inbox-filters";
import { getBcvRate } from "@/lib/ai/bcv";
import { CrmShell } from "@/components/crm-shell";
import type { BcvRateSummary } from "@/components/inbox/bcv-rate-chip";

/**
 * La tasa es un dato de apoyo: si bcv.org.ve no responde y además no hay
 * ninguna tasa guardada, la bandeja tiene que abrir igual. Sin tasa se
 * esconde el chip, no se cae la página.
 */
async function loadBcvRate(supabase: Awaited<ReturnType<typeof createClient>>): Promise<BcvRateSummary | null> {
  try {
    return await getBcvRate(supabase);
  } catch {
    return null;
  }
}

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const supabase = await createClient();

  // Quién mira va primero: los contadores del panel de inicio se cuentan
  // para esa persona («tuyas» depende del asesor, no de la bandeja).
  const currentAgent = await fetchCurrentAgent(supabase);
  if (!currentAgent) {
    redirect("/login");
  }

  const [
    { conversation },
    conversations,
    inboxCounts,
    unreadConversations,
    tags,
    quickReplies,
    bcvRate,
    agentSettings,
  ] = await Promise.all([
    searchParams,
    fetchConversations(supabase, { limit: INBOX_PAGE_SIZE }),
    fetchInboxCounts(supabase, currentAgent.id),
    // Misma consulta que `InboxSidebar` le pide a la base al montar en la
    // píldora "No leídas" (ver inbox-sidebar.tsx). Resolverla acá evita que
    // la bandeja abra en esa píldora —el filtro por defecto— mostrando el
    // cartel "Buscando…" mientras el efecto de red hace el mismo viaje desde
    // el navegador. Antes eran dos consultas (fresh/stale de "Pendientes");
    // la reforma a No leídas/Mías/Todos las deja en una sola.
    fetchConversations(supabase, { unreadOnly: true, limit: SERVER_FILTER_LIMIT }),
    fetchTags(supabase),
    fetchQuickReplies(supabase),
    loadBcvRate(supabase),
    fetchAgentSettings(supabase),
  ]);

  // El dashboard enlaza cada tarjeta con ?conversation=<id> para abrir el hilo directo.
  const requestedId = typeof conversation === "string" ? conversation : undefined;

  return (
    <CrmShell
      currentAgent={currentAgent}
      initialConversations={conversations}
      initialInboxCounts={inboxCounts}
      initialUnreadConversations={unreadConversations}
      allTags={tags}
      initialQuickReplies={quickReplies}
      bcvRate={bcvRate}
      initialConversationId={requestedId}
      initialAgentSettings={agentSettings}
    />
  );
}
