import { periodoDeAsesores, periodoDesdeParam } from "@/lib/paneles/periodos";
import { VISTAS, vistaDesdeParam } from "@/lib/paneles/canal";

/**
 * A dónde llevan las tres entradas de los paneles del menú (15/11/2026, plan
 * "Paneles"). Heredan el trabajo de las pestañas internas que se quitaron: al
 * cambiar de panel, el período (y el canal, donde aplica) elegidos no se
 * pierden. Estando en un panel, los `href` llevan el período actual de la URL y
 * la vista si la URL la trae —Asesores es por persona y no admite vista, y solo
 * admite hoy/7d/30d—; fuera de los paneles quedan limpios.
 *
 * Puro (sin React ni `next/navigation`): lo llama `app-rail.tsx` con lo que leen
 * `usePathname`/`useSearchParams`. Lo que viene de la URL se normaliza con los
 * mismos parseadores que las páginas, así nunca se copia un valor inválido.
 */

export type HrefsPaneles = { dashboard: string; analiticas: string; asesores: string };

export const HREFS_PANELES_LIMPIOS: HrefsPaneles = {
  dashboard: "/panel",
  analiticas: "/panel/analiticas",
  asesores: "/panel/asesores",
};

function esRutaDePanel(pathname: string | null | undefined): boolean {
  const ruta = (pathname ?? "").split("?")[0];
  return ruta === "/panel" || ruta.startsWith("/panel/");
}

export function hrefsDePaneles(
  pathname: string | null | undefined,
  searchParams: { get(nombre: string): string | null } | null | undefined
): HrefsPaneles {
  if (!esRutaDePanel(pathname)) return HREFS_PANELES_LIMPIOS;

  const periodo = periodoDesdeParam(searchParams?.get("periodo") ?? undefined);
  const vistaCruda = searchParams?.get("vista") ?? undefined;
  const hayVista = VISTAS.some((v) => v.id === vistaCruda);

  const conVista = new URLSearchParams({ periodo });
  if (hayVista) conVista.set("vista", vistaDesdeParam(vistaCruda));
  const soloPeriodo = new URLSearchParams({ periodo: periodoDeAsesores(periodo) });

  return {
    dashboard: `${HREFS_PANELES_LIMPIOS.dashboard}?${conVista}`,
    analiticas: `${HREFS_PANELES_LIMPIOS.analiticas}?${conVista}`,
    asesores: `${HREFS_PANELES_LIMPIOS.asesores}?${soloPeriodo}`,
  };
}

