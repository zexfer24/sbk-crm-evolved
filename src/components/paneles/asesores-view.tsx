"use client";

import type { BusinessHours } from "@/lib/business-hours";
import type { Bloque, BloqueConTope } from "@/lib/paneles-data";
import type { PeriodoId, RangoPanel } from "@/lib/paneles/periodos";
import type { PanelAsesores, PanelCola, PanelConversaciones, PanelVentas } from "@/lib/paneles/parse";
import { ControlPeriodo, PanelBloque, PanelMarco, formatoUsd } from "@/components/paneles/panel-marco";

/**
 * Asesores (plan "Paneles", 13/11/2026). VISTA PROVISIONAL de C2/C3: lista
 * simple por persona y resumen de la cola. C6 la reemplaza; las props de abajo
 * son el contrato con `src/app/panel/asesores/page.tsx` y NO cambian.
 */
export interface AsesoresViewProps {
  periodo: PeriodoId;
  /** Instante de la lectura (lo fija el servidor). */
  ahora: Date;
  /** El rango del período elegido (para rotular). */
  rango: RangoPanel;
  /** Actividad y rendimiento por persona. `recortado` = el rango pasó el tope de 92 días. */
  asesores: BloqueConTope<PanelAsesores>;
  /** Conversaciones del período: la conversión por persona se cruza con `asesores`. */
  conversaciones: BloqueConTope<PanelConversaciones>;
  /** Ventas del período: `personas` es el mostrador por persona y canal. */
  ventas: Bloque<PanelVentas>;
  /** La cola de pendientes de AHORA (sin rango). */
  cola: Bloque<PanelCola>;
  /** Para medir el pendiente más viejo en minutos laborales. */
  horario: BusinessHours;
}

export function AsesoresView({ periodo, ahora, rango, asesores, cola }: AsesoresViewProps) {
  return (
    <PanelMarco panel="asesores" titulo="Asesores" ahora={ahora} periodo={periodo} controles={<ControlPeriodo periodo={periodo} />}>
      <div className="pn-bento">
        <div className="pn-c8">
          <PanelBloque bloque={asesores} nombre="Actividad de los asesores">
            {(dato) => (
              <section className="pn-card">
                <p className="pn-eyebrow">Equipo · {rango.etiqueta}</p>
                {dato.personas.length === 0 ? (
                  <p className="pn-vacio">Sin actividad en este período.</p>
                ) : (
                  <ul className="pn-lista">
                    {dato.personas.map((p) => (
                      <li key={p.agent_id} className="pn-lista__fila">
                        <span className="pn-lista__txt">
                          <b>{p.nombre}</b>
                          <small>
                            {p.mensajes} mensajes · {p.envios} envíos · {formatoUsd(p.monto)}
                          </small>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </PanelBloque>
        </div>

        <div className="pn-c4">
          <PanelBloque bloque={cola} nombre="Cola de pendientes">
            {(dato) => (
              <section className="pn-card">
                <p className="pn-eyebrow">Pendientes ahora</p>
                <p className="pn-kpi__cifra">{dato.pendientes}</p>
                <p className="pn-subtitulo">
                  {dato.sin_dueno} sin dueño · {dato.con_dueno} con dueño
                </p>
              </section>
            )}
          </PanelBloque>
        </div>
      </div>
    </PanelMarco>
  );
}
