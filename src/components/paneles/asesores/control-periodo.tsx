"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SlidingPills } from "@/components/sliding-pills";
import { PERIODOS, type PeriodoId } from "@/lib/paneles/periodos";

/**
 * Período de Asesores (plan "Paneles", 13/11/2026): solo Hoy / 7 días / 30 días.
 * `ControlPeriodo` del marco ofrece los cinco períodos, y para una pantalla por
 * persona «Este año» no tiene sentido (la actividad por mensajes tiene tope de
 * 92 días). Misma mecánica que el del marco: no guarda estado, cambia la URL.
 *
 * Si la URL trae un período que Asesores no ofrece (`?periodo=mes`, que la
 * página acepta porque lo comparte con las otras dos), se muestra también como
 * opción activa para que el control diga la verdad de lo que se está viendo.
 */
const PERIODOS_ASESORES: PeriodoId[] = ["hoy", "7d", "30d"];

export function ControlPeriodoAsesores({ periodo }: { periodo: PeriodoId }) {
  const router = useRouter();
  const pathname = usePathname();
  const actuales = useSearchParams();

  const ids = PERIODOS_ASESORES.includes(periodo) ? PERIODOS_ASESORES : [...PERIODOS_ASESORES, periodo];

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
        items={ids.map((id) => ({ value: id, label: PERIODOS.find((p) => p.id === id)?.etiqueta ?? id }))}
      />
    </div>
  );
}
