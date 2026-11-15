/**
 * Qué panel es el de una ruta (15/11/2026, plan "Paneles"). `error.tsx` de
 * `/panel` es UNA pantalla compartida por las tres rutas y, al ser un boundary
 * de cliente, no recibe cuál falló: lo deduce del `pathname` para marcar su
 * propia entrada en el rail y en la barra superior (antes marcaba siempre la
 * «Paneles» única). Una ruta desconocida cae en el Dashboard, que es la raíz de
 * `/panel`.
 */
export type PanelActivo = "dashboard" | "analiticas" | "asesores";

export function panelActivoDeRuta(pathname: string | null | undefined): PanelActivo {
  const ruta = (pathname ?? "").split("?")[0].replace(/\/+$/, "");
  if (ruta === "/panel/analiticas" || ruta.startsWith("/panel/analiticas/")) return "analiticas";
  if (ruta === "/panel/asesores" || ruta.startsWith("/panel/asesores/")) return "asesores";
  return "dashboard";
}
