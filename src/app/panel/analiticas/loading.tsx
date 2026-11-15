import { SectionSkeleton } from "@/components/section-skeleton";

// Esqueleto de Analíticas (15/11/2026): marca su propia entrada del rail; ver
// `panel/loading.tsx`.
export default function Loading() {
  return <SectionSkeleton active="analiticas" rows={7} verPaneles />;
}
