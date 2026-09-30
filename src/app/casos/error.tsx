"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@heroui/react";
import { AppRail } from "@/components/app-rail";
// Explícito, igual que en `ventas/error.tsx` (hallazgo 5 de la revisión del
// 19/9/2026): `.dash-frame`/`.dash-empty*` los define esta hoja, y la vista
// que la importa no se monta cuando la página lanza antes de renderizarla.
import "@/components/dashboard/dashboard.css";

/**
 * Límite de errores de «Casos» (T7, plan "La ronda del cliente", 30/9/2026).
 * Sin él, una lectura que falle (los chats abiertos, las etiquetas, los
 * asesores) cae en la pantalla 500 genérica de Next, sin rail ni forma de
 * volver. `retry` (estable en este Next 16.3) vuelve a pedir el segmento sin
 * recargar la pestaña. Mismo marco de dos columnas de `.dash-frame` que la
 * vista (trampa del FRAGMENTO, 9/9/2026): AppRail y el contenido, nada más.
 */
export default function CasosError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("No se pudo cargar Casos:", error);
  }, [error]);

  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active="casos" />

        <main className="dash-main">
          <div className="dash-content">
            <div className="dash-empty" role="alert">
              <AlertTriangle size={28} aria-hidden="true" />
              <p className="dash-empty-title">Casos no pudo cargar</p>
              <p className="dash-empty-hint">
                Hubo un problema al traer los chats abiertos o las etiquetas. Intenta de nuevo en unos segundos.
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
