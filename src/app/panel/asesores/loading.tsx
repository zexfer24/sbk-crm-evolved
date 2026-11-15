import { SectionSkeleton } from "@/components/section-skeleton";

// Esqueleto de Asesores (15/11/2026): marca su propia entrada del rail; ver
// `panel/loading.tsx`.
export default function Loading() {
  return <SectionSkeleton active="asesores" rows={7} verPaneles />;
}
