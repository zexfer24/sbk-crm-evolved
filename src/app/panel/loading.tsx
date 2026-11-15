import { SectionSkeleton } from "@/components/section-skeleton";

// Un solo esqueleto para las tres páginas de `/panel` (Next 16.3 hereda el
// `loading.tsx` del segmento a sus hijos). Solo supervisor/admin llegan acá
// (lo exige el layout), así que el rail del esqueleto trae «Paneles».
export default function Loading() {
  return <SectionSkeleton active="paneles" rows={7} verPaneles />;
}
