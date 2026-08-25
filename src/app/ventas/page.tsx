import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent, fetchSales } from "@/lib/data";
import { SalesView } from "@/components/sales/sales-view";

export default async function VentasPage() {
  const supabase = await createClient();

  const [currentAgent, sales] = await Promise.all([
    fetchCurrentAgent(supabase),
    fetchSales(supabase),
  ]);

  if (!currentAgent) {
    redirect("/login");
  }

  return <SalesView currentAgent={currentAgent} initialSales={sales} />;
}
