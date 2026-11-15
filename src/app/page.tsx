import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { puedeVerPaneles } from "@/lib/paneles/acceso";

/**
 * La raíz `/` no pinta nada: decide por rol adónde cae cada quien al entrar
 * (15/11/2026, plan "Paneles"; antes era el Recorrido). Supervisor y admin
 * abren el Dashboard de ventas (`/panel`); los asesores siguen entrando al
 * Recorrido, que ahora vive en `/recorrido`; sin sesión, `/login`.
 *
 * Así siguen funcionando sin tocarlos el `router.push("/")` de `login-form.tsx`,
 * el `redirect("/")` de `login/page.tsx` y el del proxy cuando un usuario ya
 * logueado pide `/login`. La caja no llega acá: el proxy la manda a `/inventario`.
 *
 * Una sola lectura (el agente actual): las del Recorrido las hace su propia página.
 */
export default async function RaizPage() {
  const supabase = await createClient();
  const agente = await fetchCurrentAgent(supabase);

  if (!agente) redirect("/login");
  if (puedeVerPaneles(agente.role)) redirect("/panel");
  redirect("/recorrido");
}
