import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { fetchCustomersPage } from "@/lib/customers-data";
import { parseCustomerParams } from "@/lib/customers";
import { ClientesView } from "@/components/clientes/clientes-view";

/**
 * La búsqueda, el filtro y la página viven en la URL y se resuelven en el
 * servidor. Así el enlace se comparte y se recarga sin perder el corte, y el
 * navegador nunca carga más clientes que los de una página.
 */
export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const [raw, currentAgent] = await Promise.all([searchParams, fetchCurrentAgent(supabase)]);

  if (!currentAgent) {
    redirect("/login");
  }
  // El mismo interruptor que saca al agente del reparto de la IA le corta el
  // CRM: desactivado no pasa de aquí. La pantalla de destino cierra la sesión.
  if (!currentAgent.isActive) {
    redirect("/acceso-desactivado");
  }

  const params = parseCustomerParams(raw);
  const { customers, total } = await fetchCustomersPage(supabase, params);

  return <ClientesView currentAgent={currentAgent} customers={customers} total={total} params={params} />;
}
