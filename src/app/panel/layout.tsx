import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { puedeVerPaneles } from "@/lib/paneles/acceso";

/**
 * Candado de los tres paneles (plan "Paneles", 13/11/2026): `/panel`,
 * `/panel/analiticas` y `/panel/asesores` son solo de supervisor y admin.
 * Sin sesión va a `/login`; un asesor que escribe la URL a mano vuelve a `/`.
 * La caja no llega hasta acá: la frena el middleware (`rutaPermitidaParaCaja`).
 *
 * Esto es la primera puerta y la de pantalla; la definitiva está en las RPC
 * `panel_*` (`is_supervisor_or_admin()`, 42501) y en la RLS de `metas_venta`.
 * Un layout se salta en las navegaciones del lado del cliente entre páginas
 * hermanas, así que NO se confía solo en esto: cada RPC se vuelve a verificar.
 */
export default async function PanelLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const agente = await fetchCurrentAgent(supabase);

  if (!agente) redirect("/login");
  if (!puedeVerPaneles(agente.role)) redirect("/");

  return <>{children}</>;
}
