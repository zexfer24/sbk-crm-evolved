"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@heroui/react";
import { AppRail } from "@/components/app-rail";
// Hallazgo 5 de la revisión de código del 19/9/2026 sobre T7: `.dash`,
// `.dash-frame` y `.dash-empty*` los define esta hoja, y hasta esta
// corrección SOLO la importaban los componentes de vista (`AgentControlView`
// y hermanos) — que precisamente NO se montan cuando la página lanza antes
// de renderizarlos. La verificación visual en dev salió bien porque el dev
// server sirve el CSS sin trocear por ruta, pero el build de producción
// arma los chunks de otra forma y no hay garantía de que ese `<link>` ya
// esté insertado cuando React monta este boundary en vez de la vista real.
// Import explícito, sin condiciones: es la única forma de no depender de
// que otro componente se haya montado antes.
import "@/components/dashboard/dashboard.css";

/**
 * Límite de errores de Control IA (T7, plan "Seba sale sin pisar a nadie",
 * 19/9/2026, hallazgo A4): hasta esta corrida NINGUNA ruta de `src/app`
 * tenía un `error.tsx` propio, así que una lectura que fallara acá (antes
 * de T7, las 19 del `Promise.all` de `page.tsx` podían tumbarse juntas)
 * caía en la pantalla 500 genérica de Next, sin rail ni forma de volver —
 * el interruptor global de la IA quedaba inalcanzable justo cuando algo ya
 * andaba mal. Este Next (16.3.1) tiene `retry` ESTABLE desde la 16.3.0
 * (`node_modules/next/dist/docs/.../error.md`): reintenta re-pedir y
 * re-renderizar el segmento sin recargar toda la pestaña, así que se usa
 * en vez de `reset` (que solo limpia el estado de React sin volver a pedir
 * nada, y acá el error casi siempre viene de una lectura contra Supabase).
 *
 * El marco replica a mano el de `AgentControlView`/`SectionSkeleton`
 * (`.dash` > `.dash-frame` > dos hijos directos, `AppRail` + el contenido)
 * por la trampa del FRAGMENTO del 9/9/2026: `.dash-frame` es un grid de dos
 * columnas fijas (`72px minmax(0, 1fr)`) y un tercer hijo directo le roba
 * la columna al contenido y desarma la pantalla entera.
 */
export default function AgentControlError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Boundary de cliente: no hay `lib/log.ts` acá (es `server-only`), mismo
    // criterio que `fetchActiveCatalogLinks`/`fetchBusinessHours` en
    // `src/lib/data.ts`.
    console.error("No se pudo cargar Control IA:", error);
  }, [error]);

  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active="control" />

        <main className="dash-main">
          <div className="dash-content">
            <div className="dash-empty" role="alert">
              <AlertTriangle size={28} aria-hidden="true" />
              <p className="dash-empty-title">Control de IA no pudo cargar</p>
              <p className="dash-empty-hint">
                Hubo un problema al traer los datos de esta pantalla. El interruptor global de la IA y el resto del
                panel vuelven a estar disponibles apenas la carga funcione.
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
