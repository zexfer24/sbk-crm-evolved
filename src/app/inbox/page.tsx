import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchConversations, fetchCurrentAgent, fetchQuickReplies, fetchTags } from "@/lib/data";
import { CrmShell } from "@/components/crm-shell";

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const supabase = await createClient();

  const [{ conversation }, currentAgent, conversations, tags, quickReplies] = await Promise.all([
    searchParams,
    fetchCurrentAgent(supabase),
    fetchConversations(supabase),
    fetchTags(supabase),
    fetchQuickReplies(supabase),
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
      initialConversationId={requestedId}
    />
  );
}
