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
    pendingConversations,
    tags,
    quickReplies,
    bcvRate,
    agentSettings,
  ] = await Promise.all([
    searchParams,
    fetchConversations(supabase, { limit: INBOX_PAGE_SIZE }),
    fetchInboxCounts(supabase, currentAgent.id),
    // Misma consulta que `InboxSidebar` le pide a la base al montar en la
    // píldora que abre por defecto (ver `pillQueryOptions` en
    // inbox-sidebar.tsx): primera página, mismo tamaño (`INBOX_PAGE_SIZE`)
    // que usa esa píldora para paginar por cursor. Resolverla acá evita que
    // la bandeja abra en esa píldora mostrando el cartel "Buscando…"
    // mientras el efecto de red hace el mismo viaje desde el navegador.
    // Antes eran dos consultas (fresh/stale de "Pendientes"); la reforma a
    // No leídas/Mías/Todos del 29/8/2026 las dejó en una sola. La del
    // 30/8/2026 devolvió el filtro por defecto a "Pendientes" —231 chats
    // leídos y sin responder no aparecían en ninguna píldora—, así que vuelve
    // a sembrar "Pendientes", pero sigue siendo esa misma consulta única, sin
    // el corte fresh/stale que tenía antes de la reforma anterior.
    fetchConversations(supabase, { activeOnly: true, awaitingReplyOnly: true, limit: INBOX_PAGE_SIZE }),
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
      initialPendingConversations={pendingConversations}
      allTags={tags}
      initialQuickReplies={quickReplies}
      bcvRate={bcvRate}
      initialConversationId={requestedId}
      initialAgentSettings={agentSettings}
    />
  );
}
