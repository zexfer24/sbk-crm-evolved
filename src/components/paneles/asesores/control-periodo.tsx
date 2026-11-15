"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SlidingPills } from "@/components/sliding-pills";
import { PERIODOS, PERIODOS_ASESORES, type PeriodoId } from "@/lib/paneles/periodos";

/**
 * Período de Asesores (plan "Paneles", 13/11/2026): solo Hoy / 7 días / 30 días.
 * `ControlPeriodo` del marco ofrece los cinco períodos, y para una pantalla por
 * persona «Este año» no tiene sentido (la actividad por mensajes tiene tope de
 * 92 días). Misma mecánica que el del marco: no guarda estado, cambia la URL.
 *
 * Desde el 15/11/2026 la página usa `periodoDeAsesores`, que nunca devuelve
 * `mes` ni `anio`: ya no existe la "opción activa extra" para un período fuera
 * de la lista, y el control siempre pinta exactamente estos tres.
 */

export function ControlPeriodoAsesores({ periodo }: { periodo: PeriodoId }) {
  const router = useRouter();
  const pathname = usePathname();
  const actuales = useSearchParams();

  return (
    <div className="pn-scroll">
      <SlidingPills
        ariaLabel="Período"
        tone="segmented"
        value={periodo}
        onChange={(v) => {
          const params = new URLSearchParams(actuales?.toString() ?? "");
          params.set("periodo", v);
          router.replace(`${pathname}?${params.toString()}`, { scroll: false });
        }}
        items={PERIODOS_ASESORES.map((id) => ({ value: id, label: PERIODOS.find((p) => p.id === id)?.etiqueta ?? id }))}
      />
    </div>
  );
}
