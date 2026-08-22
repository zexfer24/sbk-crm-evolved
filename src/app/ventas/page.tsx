import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchConversations, fetchCurrentAgent } from "@/lib/data";
import { SalesView } from "@/components/sales/sales-view";

export default async function VentasPage() {
  const supabase = await createClient();

  const [currentAgent, conversations] = await Promise.all([
    fetchCurrentAgent(supabase),
    fetchConversations(supabase),
  ]);

  if (!currentAgent) {
    redirect("/login");
  }

  return <SalesView currentAgent={currentAgent} initialConversations={conversations} />;
}
