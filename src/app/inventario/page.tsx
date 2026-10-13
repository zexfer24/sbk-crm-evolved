import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { fetchInventoryTotals, fetchMotoCatalogSummary, fetchProductsPage } from "@/lib/inventory-data";
import { inventoryHref, paginaFueraDeRango, parseInventoryParams } from "@/lib/inventory";
import { getBcvRate } from "@/lib/ai/bcv";
import { InventarioView } from "@/components/inventario/inventario-view";
import type { BcvRateSummary } from "@/components/inbox/bcv-rate-chip";

/**
 * La tasa es un dato de apoyo para mostrar el precio en bolívares: si no se
 * puede obtener, el inventario tiene que abrir igual y mostrar solo dólares.
 *
 * Viaja con su fecha y con si está vieja, no como número suelto: acá se
 * calculan precios, y un número sin fecha no deja distinguir la tasa de hoy de
 * una de hace tres días. Es exactamente lo que pasó — la bandeja avisaba y esta
 * pantalla no.
 */
async function loadRate(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<BcvRateSummary | null> {
  try {
    const { rate, rateDate, isStale } = await getBcvRate(supabase);
    return { rate, rateDate, isStale };
  } catch {
    return null;
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

  const params = parseInventoryParams(raw);
  const [{ products, total }, totals, catalog, bcvRate] = await Promise.all([
    fetchProductsPage(supabase, params),
    fetchInventoryTotals(supabase),
    fetchMotoCatalogSummary(supabase),
    loadRate(supabase),
  ]);

  // Una `?page=` más allá de la última (enlace viejo, o un filtro que acortó la
  // lista) ya no revienta: se manda a la última página real (13/10/2026).
  const paginaValida = paginaFueraDeRango(params.page, total);
  if (paginaValida !== null) {
    redirect(inventoryHref({ ...params, page: paginaValida }));
  }

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
