"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@heroui/react";
import { AppRail } from "@/components/app-rail";
import { PanelBarraSuperior } from "@/components/paneles/panel-barra-superior";
// Igual que `ventas/error.tsx` y `agent-control/error.tsx` (19/9/2026): `.dash`,
// `.dash-frame` y `.dash-empty*` los define esta hoja, y el componente de vista
// que la importaba NO se monta cuando la página lanza antes de renderizarlo.
import "@/components/dashboard/dashboard.css";

/**
 * Límite de errores de los tres paneles (plan "Paneles", 13/11/2026). Un solo
 * `error.tsx` en `/panel` cubre las tres páginas (Next 16.3: un `error.tsx`
 * envuelve a su segmento y a sus hijos, pero NO al `layout.tsx` de arriba, así
 * que un redirect del layout sigue funcionando). Cada bloque de datos degrada
 * por su cuenta (`paneles-data.ts`); acá solo llega lo que no se pudo degradar
 * (un 42501 relanzado, un fallo de render). `retry` re-pide y re-renderiza el
 * segmento sin recargar la pestaña.
 *
 * Marco `.dash > .dash-frame > AppRail + main`: DOS hijos directos, por la
 * trampa del FRAGMENTO del 9/9/2026. Solo supervisor/admin llegan a `/panel`
 * (el layout lo exige), así que el rail lleva `verPaneles`.
 */
export default function PanelError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Boundary de cliente: no hay `lib/log.ts` (es `server-only`).
    console.error("No se pudieron cargar los paneles:", error);
  }, [error]);

  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active="paneles" verPaneles />

        <main className="dash-main">
          <div className="dash-content">
            {/* 15/11/2026: en el teléfono el rail no se ve; sin esto no hay cómo salir. */}
            <PanelBarraSuperior />
            <div className="dash-empty" role="alert">
              <AlertTriangle size={28} aria-hidden="true" />
              <p className="dash-empty-title">Los paneles no pudieron cargar</p>
              <p className="dash-empty-hint">
                Hubo un problema al traer los datos de esta pantalla. Intenta de nuevo en unos segundos.
              </p>
              <Button variant="primary" onPress={() => retry()}>
                <RefreshCw size={14} aria-hidden="true" />
                Reintentar
              </Button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
