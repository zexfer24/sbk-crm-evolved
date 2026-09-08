import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { fetchInvoice } from "@/lib/invoices-data";
import { InvoiceSheet } from "@/components/sales/invoice-sheet";

export default async function FacturaPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const [{ id }, currentAgent] = await Promise.all([params, fetchCurrentAgent(supabase)]);

  if (!currentAgent) {
    redirect("/login");
  }

  const invoice = await fetchInvoice(supabase, id);
  if (!invoice) {
    notFound();
  }

  return <InvoiceSheet invoice={invoice} />;
}
