import { AppRail, AppTopNav } from "@/components/app-rail";
import type { RailSection } from "@/components/app-rail";

/**
 * Lo que se ve mientras una sección carga.
 *
 * No es adorno: sin un `loading.tsx`, Next no prefetchea las rutas dinámicas
 * —que acá son todas— y deja la pantalla congelada en la página anterior
 * hasta que el servidor termina de responder. Con este archivo el rail y el
 * marco aparecen en el mismo instante del clic y el contenido entra por
 * streaming detrás.
 *
 * Por eso el esqueleto reusa el rail de verdad y no una copia: es la parte
 * que no cambia entre secciones, y repintarla haría parpadear justo lo que
 * debería quedarse quieto.
 */
export function SectionSkeleton({
  active,
  rows = 6,
}: {
  active: RailSection;
  rows?: number;
}) {
  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active={active} />
        <main className="dash-main">
          <div className="dash-content" role="status" aria-busy="true" aria-label="Cargando la sección">
            <div className="skel-topbar">
              <span className="skel skel-title" />
              <AppTopNav active={active} />
            </div>
            <div className="skel-rows">
              {Array.from({ length: rows }, (_, i) => (
                <span className="skel skel-row" key={i} />
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
