import type { ReactNode } from "react";
import { exigirAccesoPaneles } from "./acceso-servidor";

/**
 * Candado de los tres paneles (plan "Paneles", 13/11/2026): `/panel`,
 * `/panel/analiticas` y `/panel/asesores` son solo de supervisor y admin.
 * Sin sesión va a `/login`; un asesor que escribe la URL a mano vuelve a `/`.
 * La caja no llega hasta acá: la frena el middleware (`rutaPermitidaParaCaja`).
 *
 * Esto es la primera puerta y la de pantalla; la definitiva está en las RPC
 * `panel_*` (`is_supervisor_or_admin()`, 42501) y en la RLS de `metas_venta`.
 * Un layout se salta en las navegaciones del lado del cliente entre páginas
 * hermanas y, además, se renderiza EN PARALELO con la página (15/11/2026): por
 * eso cada `page.tsx` llama también a `exigirAccesoPaneles` antes de leer, y el
 * `cache` de React hace que las dos compartan una sola consulta del agente.
 */
export default async function PanelLayout({ children }: { children: ReactNode }) {
  await exigirAccesoPaneles();

  return <>{children}</>;
}
