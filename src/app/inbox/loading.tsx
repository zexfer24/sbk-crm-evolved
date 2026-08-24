import { AppRail } from "@/components/app-rail";
import "@/components/crm.css";

/**
 * La bandeja no usa el marco de las demás secciones: son tres columnas con
 * medidas propias. El esqueleto las respeta para que, cuando entren los datos
 * de verdad, nada se mueva de sitio — un esqueleto que no calza es peor que
 * ninguno, porque convierte la carga en un salto.
 */
export default function Loading() {
  return (
    <div className="crm" data-view="list">
      <AppRail active="bandeja" variant="crm" />

      <div className="crm-columns">
        <section className="crm-column crm-inbox">
          <div className="skel-rows" role="status" aria-busy="true" aria-label="Cargando la bandeja">
            <span className="skel skel-title" />
            {Array.from({ length: 9 }, (_, i) => (
              <span className="skel skel-thread" key={i} />
            ))}
          </div>
        </section>

        <section className="crm-column crm-chat" />
        <aside className="crm-column crm-context" />
      </div>
    </div>
  );
}
