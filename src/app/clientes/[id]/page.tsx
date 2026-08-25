import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent, fetchTags } from "@/lib/data";
import { fetchCustomerDetail } from "@/lib/customers-data";
import { ClienteFicha } from "@/components/clientes/cliente-ficha";

export default async function ClienteFichaPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const [{ id }, currentAgent] = await Promise.all([params, fetchCurrentAgent(supabase)]);

  if (!currentAgent) {
    redirect("/login");
  }
  // El mismo interruptor que saca al agente del reparto de la IA le corta el
  // CRM: desactivado no pasa de aquí. La pantalla de destino cierra la sesión.
  if (!currentAgent.isActive) {
    redirect("/acceso-desactivado");
  }

  const [detail, allTags] = await Promise.all([fetchCustomerDetail(supabase, id), fetchTags(supabase)]);
  if (!detail) {
    notFound();
  }

  return <ClienteFicha currentAgent={currentAgent} detail={detail} allTags={allTags} />;
}
