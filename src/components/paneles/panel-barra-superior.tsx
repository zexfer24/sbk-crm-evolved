import { LayoutDashboard } from "lucide-react";
import { AppTopNav } from "@/components/app-rail";
import { BUSINESS_NAME } from "@/lib/brand";

/**
 * Barra superior de los paneles (15/11/2026, `code-review` del plan "Paneles").
 * En el teléfono `.dash-rail` es `display: none` (dashboard.css, 760 px) y el
 * resto de las pantallas compensan con esta barra; en `/panel` faltaba y un
 * supervisor no podía salir sin el botón atrás. Misma estructura que `SalesView`.
 *
 * Va DENTRO del `main` (primer hijo de `.dash-content`), NUNCA como hijo directo
 * de `.dash-frame`: ese grid tiene dos columnas (trampa del FRAGMENTO, CLAUDE.md
 * 9/9/2026). Solo supervisor/admin llegan a `/panel`, así que `verPaneles` va fijo.
 * Sin avatar a la derecha: no hay agente a mano y no se agregan lecturas.
 */
export function PanelBarraSuperior() {
  return (
    <header className="dash-topbar">
      <p className="dash-brand">
        <span className="dash-brand-mark" aria-hidden="true">
          <LayoutDashboard size={14} />
        </span>
        <span className="dash-brand-name">{BUSINESS_NAME}</span>
      </p>

      <AppTopNav active="paneles" verPaneles />
    </header>
  );
}
