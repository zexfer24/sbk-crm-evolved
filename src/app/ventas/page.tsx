import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent, fetchSales } from "@/lib/data";
import { getBcvRate } from "@/lib/ai/bcv";
import { SalesView } from "@/components/sales/sales-view";

/**
 * La tasa es un dato de apoyo para la factura (total en bolívares al lado
 * del total en dólares): si no se puede leer, la sección abre igual y
 * "Generar factura" guarda `bcv_rate: null` —la hoja lo muestra como "Por
 * definir" en vez de romper el cierre. Mismo patrón que `loadRate` en
 * `src/app/inventario/page.tsx`.
 */
async function loadBcvRate(supabase: Awaited<ReturnType<typeof createClient>>): Promise<number | null> {
  try {
    const { rate } = await getBcvRate(supabase);
    return rate;
  } catch {
    return null;
  }
}

export default async function VentasPage() {
  const supabase = await createClient();

  const [currentAgent, sales, bcvRate] = await Promise.all([
    fetchCurrentAgent(supabase),
    fetchSales(supabase),
    loadBcvRate(supabase),
  ]);

  if (!currentAgent) {
    redirect("/login");
  }

  return <SalesView currentAgent={currentAgent} initialSales={sales} bcvRate={bcvRate} />;
}
