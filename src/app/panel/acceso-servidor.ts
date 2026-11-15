import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { puedeVerPaneles } from "@/lib/paneles/acceso";

/**
 * Candado de servidor de los tres paneles (`/panel`, `/panel/analiticas`,
 * `/panel/asesores`), compartido por el layout y por cada página.
 *
 * Por qué no basta el layout (15/11/2026): en el App Router el layout y la
 * página se renderizan EN PARALELO, y un layout no se vuelve a ejecutar cuando
 * se navega del lado del cliente entre páginas hermanas (la guía de
 * autenticación de Next, "Layouts and auth checks": hacer la verificación cerca
 * del dato). Con solo el layout, un asesor que abría `/panel` terminaba en `/`,
 * pero la página lanzaba igual sus ~10 lecturas `panel_*`, cada RPC respondía
 * 42501 y `paneles-data.ts` lo relanzaba: un `Error: no autorizado` en el log del
 * servidor por intento. Ahora cada página llama a esta función ANTES de leer.
 *
 * `cache` de React hace que layout y página compartan UNA sola consulta del
 * agente (y un solo cliente de Supabase) dentro del mismo request. Fuera de un
 * render de servidor (los tests) `cache` no memoiza, y cada llamada consulta.
 *
 * La puerta definitiva sigue siendo la de la base: las RPC `panel_*`
 * (`is_supervisor_or_admin()`, 42501) y la RLS de `metas_venta`.
 */
export const exigirAccesoPaneles = cache(async () => {
  const supabase = await createClient();
  const agente = await fetchCurrentAgent(supabase);

  if (!agente) redirect("/login");
  // 15/11/2026: directo al Recorrido y no a `/`: la raíz ahora redirige por rol
  // y el asesor pagaría un salto de más.
  if (!puedeVerPaneles(agente.role)) redirect("/recorrido");

  return { supabase, agente };
});
