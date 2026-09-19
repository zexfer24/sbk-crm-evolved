"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@heroui/react";
import { AppRail } from "@/components/app-rail";
// Hallazgo 5 de la revisión de código del 19/9/2026 (ver el comentario
// gemelo en `agent-control/error.tsx`): `.dash-frame`/`.dash-empty*` los
// define esta hoja, y `SalesView` es quien la importaba hasta ahora — un
// componente que no se monta cuando la página lanza antes de renderizarlo.
import "@/components/dashboard/dashboard.css";

/**
 * Límite de errores de Ventas (T7, plan "Seba sale sin pisar a nadie",
 * 19/9/2026, hallazgo A4): igual que en `agent-control/error.tsx`, hasta
 * esta corrida un tropiezo acá caía en la pantalla 500 genérica de Next,
 * sin rail ni forma de volver.
 *
 * A diferencia de Control IA, en Ventas NO hay ninguna lectura que se
 * pueda degradar a una lista vacía: `saint_invoice_number` (D9-D11, plan
 * "Nada sin leer, un solo catálogo y la factura Saint", 18/9/2026) viaja
 * DENTRO del `select` de `fetchSales`, no en una consulta aparte — si esa
 * columna falta en la base de destino, la única salida razonable es esta
 * pantalla con "Reintentar", no fingir una lista de ventas vacía. Mismo
 * `retry` estable de este Next (16.3.1) y el mismo marco de dos columnas
 * de `.dash-frame` que `SalesView` (trampa del FRAGMENTO, 9/9/2026).
 */
export default function VentasError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("No se pudo cargar Ventas:", error);
  }, [error]);

  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active="ventas" />

        <main className="dash-main">
          <div className="dash-content">
            <div className="dash-empty" role="alert">
              <AlertTriangle size={28} aria-hidden="true" />
              <p className="dash-empty-title">Ventas no pudo cargar</p>
              <p className="dash-empty-hint">
                Hubo un problema al traer las ventas cerradas. Intenta de nuevo en unos segundos.
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
