import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  INBOX_CONVERSATIONS_LIMIT,
  fetchConversations,
  fetchCurrentAgent,
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

  const [{ conversation }, currentAgent, conversations, tags, quickReplies, bcvRate, agentSettings] =
    await Promise.all([
      searchParams,
      fetchCurrentAgent(supabase),
      fetchConversations(supabase, { limit: INBOX_CONVERSATIONS_LIMIT }),
      fetchTags(supabase),
      fetchQuickReplies(supabase),
      loadBcvRate(supabase),
      fetchAgentSettings(supabase),
    ]);

  if (!currentAgent) {
    redirect("/login");
  }
  // El mismo interruptor que saca al agente del reparto de la IA le corta el
  // CRM: desactivado no pasa de aquí. La pantalla de destino cierra la sesión.
  if (!currentAgent.isActive) {
    redirect("/acceso-desactivado");
  }

  // El dashboard enlaza cada tarjeta con ?conversation=<id> para abrir el hilo directo.
  const requestedId = typeof conversation === "string" ? conversation : undefined;

  return (
    <CrmShell
      currentAgent={currentAgent}
      initialConversations={conversations}
      allTags={tags}
      initialQuickReplies={quickReplies}
      bcvRate={bcvRate}
      initialConversationId={requestedId}
      initialAgentSettings={agentSettings}
    />
  );
}
