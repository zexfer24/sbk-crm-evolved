import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchConversations, fetchCurrentAgent, fetchQuickReplies, fetchTags } from "@/lib/data";
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

  const [{ conversation }, currentAgent, conversations, tags, quickReplies, bcvRate] = await Promise.all([
    searchParams,
    fetchCurrentAgent(supabase),
    fetchConversations(supabase),
    fetchTags(supabase),
    fetchQuickReplies(supabase),
    loadBcvRate(supabase),
  ]);

  if (!currentAgent) {
    redirect("/login");
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
    />
  );
}
