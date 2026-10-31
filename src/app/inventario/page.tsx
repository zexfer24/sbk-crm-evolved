import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { fetchInventoryTotals, fetchMotoCatalogSummary, fetchProductsPage } from "@/lib/inventory-data";
import {
  INVENTORY_VIEW_COOKIE,
  inventoryHref,
  paginaFueraDeRango,
  parseInventoryParams,
  parseInventoryView,
} from "@/lib/inventory";
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

  // La vista (lista o cuadrícula) que eligió este asesor se lee AQUÍ, en el servidor
  // (30/10/2026, plan «Cada repuesto con su foto», D4): así el primer render ya sale
  // con la vista correcta, sin el parpadeo de "lista y un instante después cuadrícula"
  // que dejaría leerla en el navegador. En este Next `cookies()` es asíncrona
  // (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md) y
  // leerla vuelve la ruta dinámica, lo que ya era: `createClient()` también lee cookies.
  // Un valor ausente o desconocido cae en Lista (`parseInventoryView`).
  const vista = parseInventoryView((await cookies()).get(INVENTORY_VIEW_COOKIE)?.value);

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
      vista={vista}
    />
  );
}
