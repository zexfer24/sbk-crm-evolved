import { SectionSkeleton } from "@/components/section-skeleton";

// Esqueleto del Dashboard de ventas (`/panel`). Desde el 15/11/2026 cada ruta de
// `/panel` tiene el suyo (`analiticas/loading.tsx`, `asesores/loading.tsx`): el
// menú trae una entrada por panel y un esqueleto único marcaría siempre la
// misma. Solo supervisor/admin llegan acá (lo exige el layout), así que el rail
// del esqueleto trae las tres entradas.
export default function Loading() {
  return <SectionSkeleton active="dashboard" rows={7} verPaneles />;
}
