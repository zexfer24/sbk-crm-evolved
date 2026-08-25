import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { fetchInventoryTotals, fetchMotoCatalogSummary, fetchProductsPage } from "@/lib/inventory-data";
import { parseInventoryParams } from "@/lib/inventory";
import { getBcvRate } from "@/lib/ai/bcv";
import { InventarioView } from "@/components/inventario/inventario-view";

/**
 * La tasa es un dato de apoyo para mostrar el precio en bolívares: si no se
 * puede obtener, el inventario tiene que abrir igual y mostrar solo dólares.
 */
async function loadRate(supabase: Awaited<ReturnType<typeof createClient>>): Promise<number> {
  try {
    const { rate } = await getBcvRate(supabase);
    return rate;
  } catch {
    return 0;
  }
}

export default async function InventarioPage({
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

  const params = parseInventoryParams(raw);
  const [{ products, total }, totals, catalog, bcvRate] = await Promise.all([
    fetchProductsPage(supabase, params),
    fetchInventoryTotals(supabase),
    fetchMotoCatalogSummary(supabase),
    loadRate(supabase),
  ]);

  return (
    <InventarioView
      currentAgent={currentAgent}
      products={products}
      total={total}
      totals={totals}
      catalog={catalog}
      params={params}
      bcvRate={bcvRate}
    />
  );
}
