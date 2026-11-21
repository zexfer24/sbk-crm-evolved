"use client";

import { useMemo, type CSSProperties } from "react";
import type { BusinessHours } from "@/lib/business-hours";
import type { Bloque, BloqueConTope } from "@/lib/paneles-data";
import { tiendaVisible } from "@/lib/paneles/canal";
import type { PeriodoId, RangoPanel } from "@/lib/paneles/periodos";
import type { PanelAsesores, PanelCola, PanelConversaciones, PanelVentas } from "@/lib/paneles/parse";
import { PanelBloque, PanelMarco } from "@/components/paneles/panel-marco";
import { AvisoMasViejo } from "@/components/paneles/asesores/aviso-mas-viejo";
import { ColaPendientes } from "@/components/paneles/asesores/cola-pendientes";
import { ControlPeriodoAsesores } from "@/components/paneles/asesores/control-periodo";
import { KpisEquipo } from "@/components/paneles/asesores/kpis-equipo";
import { cruzarConversion } from "@/components/paneles/asesores/ordenar";
import { TablaPersonas } from "@/components/paneles/asesores/tabla-personas";
import { TarjetaMostrador, TarjetaSeba } from "@/components/paneles/asesores/tarjetas-laterales";
import { useReloj } from "@/components/paneles/asesores/use-reloj";
import "@/components/paneles/asesores/asesores.css";

/**
 * Asesores (plan "Paneles", 13/11/2026, C6). De arriba abajo: el aviso del
 * mensaje más viejo sin responder, el resumen del equipo, la tabla por persona
 * (con Seba y el mostrador al lado) y la cola de pendientes.
 *
 * Las props son el contrato con `src/app/panel/asesores/page.tsx` y no cambian.
 * Cada lectura cae por separado: un bloque que falla pinta su "No disponible"
 * con Reintentar y los demás siguen.
 *
 * Un solo reloj (`useReloj`, un `setInterval` de 1 s detenido con la pestaña
 * oculta) alimenta TODOS los contadores en vivo: el del aviso y la espera de
 * cada fila de la cola. Solo corre si hay pendientes que medir.
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

export function AsesoresView({ periodo, ahora, rango, asesores, conversaciones, ventas, cola, horario }: AsesoresViewProps) {
  const hayPendientes = cola.ok && cola.dato.pendientes > 0;
  const ahoraVivo = useReloj(ahora, hayPendientes);

  const conversion = conversaciones.ok ? conversaciones.dato.conversion.personas : null;
  const filas = useMemo(() => (asesores.ok ? cruzarConversion(asesores.dato.personas, conversion) : []), [asesores, conversion]);

  return (
    <PanelMarco panel="asesores" titulo="Asesores" ahora={ahora} controles={<ControlPeriodoAsesores periodo={periodo} />}>
      <div className="as-pagina">
        <div className="as-sube" style={{ "--i": 0 } as CSSProperties}>
          <PanelBloque bloque={cola} nombre="Mensaje más viejo sin responder">
            {(dato) => <AvisoMasViejo dato={dato} ahoraVivo={ahoraVivo} horario={horario} />}
          </PanelBloque>
        </div>

        <div className="as-sube" style={{ "--i": 1 } as CSSProperties}>
          <KpisEquipo asesores={asesores} cola={cola} ventas={ventas} />
        </div>

        <div className="as-cuerpo as-sube" style={{ "--i": 2 } as CSSProperties}>
          <PanelBloque bloque={asesores} nombre="Actividad de los asesores">
            {(dato) => (
              <>
                <TablaPersonas
                  filas={filas}
                  etiquetaRango={rango.etiqueta}
                  recortado={asesores.recortado}
                  conversionDisponible={conversaciones.ok}
                />
                {/* D1 (21/11/2026): el mostrador no pasa por el CRM; su tarjeta no se monta mientras el canal esté oculto. */}
                <aside className="as-lado" aria-label={tiendaVisible() ? "Seba y mostrador" : "Seba"}>
                  <TarjetaSeba seba={dato.seba} />
                  {tiendaVisible() && <TarjetaMostrador personas={dato.personas} ventas={ventas} />}
                </aside>
              </>
            )}
          </PanelBloque>
        </div>

        {cola.ok && (
          <div className="as-sube" style={{ "--i": 3 } as CSSProperties}>
            <ColaPendientes dato={cola.dato} ahoraVivo={ahoraVivo} horario={horario} />
          </div>
        )}
      </div>
    </PanelMarco>
  );
}
