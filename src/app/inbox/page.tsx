import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  INBOX_PAGE_SIZE,
  fetchConversations,
  fetchCurrentAgent,
  fetchInboxCounts,
  fetchQuickReplies,
  fetchTags,
  fetchTagsInUse,
  fetchAgentSettings,
} from "@/lib/data";
import { getBcvRate } from "@/lib/ai/bcv";
import { CRM_TIME_ZONE, currentDayRange } from "@/lib/time-zone";
import {
  dayRangeFrom,
  fetchAgentDaySummary,
  fetchAiAssignmentsToday,
  type AgentDaySummary,
  type AiAssignment,
} from "@/lib/agent-day-data";
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

/**
 * El resumen del día del panel de inicio (T4, "Los números del día",
 * 10/9/2026) es un dato de apoyo, igual que la tasa del BCV arriba: un
 * tropiezo del RPC o de la consulta de traspasos no puede tumbar la
 * bandeja entera. `null`/`[]` es justo lo que `AgentHomePanel` ya sabe
 * pintar como "todavía no hay nada" (ver su comentario).
 */
async function loadAgentDay(
  supabase: Awaited<ReturnType<typeof createClient>>,
  agentId: string,
  since: string
): Promise<{ agentDay: AgentDaySummary | null; aiAssignments: AiAssignment[] }> {
  try {
    const [agentDay, aiAssignments] = await Promise.all([
      fetchAgentDaySummary(supabase, dayRangeFrom(since)),
      fetchAiAssignmentsToday(supabase, agentId, since),
    ]);
    return { agentDay, aiAssignments };
  } catch {
    return { agentDay: null, aiAssignments: [] };
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

  // "Habló hoy" (T1 del plan "Seis frentes del buzón", 8/9/2026): el
  // servidor no tiene `localStorage` (no sabe si el visor dejó guardado "Ver
  // todo"), así que siempre siembra con el corte de HOY — el default de
  // `dayScope` en `crm-shell.tsx`. Si el visor tenía "Ver todo" guardado, el
  // efecto de esa misma constante en el shell restaura la preferencia
  // después de montar y dispara su propio refetch sin corte; hasta entonces,
  // la bandeja abre en "hoy" para todo el mundo, coincidiendo siempre con lo
  // que el primer render del cliente calcula (`useInboxDay("today")`) — sin
  // esto, hidratar ya con "Ver todo" pisaría en silencio lo que acá abajo se
  // resolvió.
  const since = currentDayRange(CRM_TIME_ZONE).from.toISOString();

  const [
    { conversation },
    conversations,
    inboxCounts,
    pendingConversations,
    tags,
    tagsInUse,
    quickReplies,
    bcvRate,
    agentSettings,
    { agentDay, aiAssignments },
  ] = await Promise.all([
    searchParams,
    fetchConversations(supabase, { limit: INBOX_PAGE_SIZE, since }),
    fetchInboxCounts(supabase, currentAgent.id, undefined, { since }),
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
    // el corte fresh/stale que tenía antes de la reforma anterior. `since`
    // (T1, 8/9/2026): mismo corte de "hoy" que el resto de esta siembra.
    fetchConversations(supabase, {
      activeOnly: true,
      awaitingReplyOnly: true,
      limit: INBOX_PAGE_SIZE,
      since,
    }),
    fetchTags(supabase),
    // Las etiquetas EN USO para la barra de filtro de la bandeja
    // (`InboxSidebar.allTags`, ver `crm-shell.tsx`): antes ese componente
    // derivaba "en uso" recorriendo `conversations` arriba —la ventana
    // cargada, ~30 filas— así que una etiqueta aplicada a un contacto fuera
    // de esa ventana no aparecía nunca en la barra (reforma del 30/8/2026;
    // `fetchTags`, arriba, sigue sirviendo al gestor de etiquetas de
    // `ContextPanel`, que necesita ver también las que nadie usa todavía).
    fetchTagsInUse(supabase),
    fetchQuickReplies(supabase),
    loadBcvRate(supabase),
    fetchAgentSettings(supabase),
    // T4 ("Los números del día", 10/9/2026): SIEMPRE con el corte de HOY,
    // nunca con el `since` que la bandeja pudiera tener en "Ver todo" —acá
    // arriba `since` ya es siempre hoy (el servidor no sabe de "Ver todo",
    // ver el comentario de esa constante), así que se reutiliza tal cual.
    loadAgentDay(supabase, currentAgent.id, since),
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
      tagsInUse={tagsInUse}
      initialQuickReplies={quickReplies}
      bcvRate={bcvRate}
      initialConversationId={requestedId}
      initialAgentSettings={agentSettings}
      initialAgentDay={agentDay}
      initialAiAssignments={aiAssignments}
    />
  );
}
