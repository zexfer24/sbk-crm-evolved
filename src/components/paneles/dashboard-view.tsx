"use client";

import type { BusinessHours } from "@/lib/business-hours";
import type { Bloque, BloqueConTope } from "@/lib/paneles-data";
import type { Vista } from "@/lib/paneles/canal";
import type { PeriodoId } from "@/lib/paneles/periodos";
import type { RangosDelDashboard } from "@/lib/paneles/rangos";
import {
  sumaCanales,
  type CanalVentas,
  type MetaVenta,
  type PanelConversaciones,
  type PanelVentas,
  type PanelVentasActivas,
} from "@/lib/paneles/parse";
import { ControlPeriodo, ControlVista, PanelBloque, PanelMarco, formatoUsd } from "@/components/paneles/panel-marco";

/**
 * Dashboard de ventas (plan "Paneles", 13/11/2026). VISTA PROVISIONAL de C2/C3:
 * un resumen simple con los datos que ya llegan por props, para que la ruta y su
 * marco se puedan abrir y verificar. C4 la reemplaza entera; las props de abajo
 * son el contrato con `src/app/panel/page.tsx` y NO cambian.
 */
export interface DashboardViewProps {
  periodo: PeriodoId;
  vista: Vista;
  /** Instante de la lectura (lo fija el servidor). */
  ahora: Date;
  rangos: RangosDelDashboard;
  /** Ventas del período elegido. */
  ventas: Bloque<PanelVentas>;
  /** Ventas del período previo equivalente (para el chip de variación). */
  ventasPrevio: Bloque<PanelVentas>;
  /** Ventas de hoy, granularidad por hora (avance del día). */
  ventasHoy: Bloque<PanelVentas>;
  /** Los 40 días anteriores a hoy, por día: su `perfil_horario` alimenta la curva y su `serie`, la racha. */
  ventasHistoria: Bloque<PanelVentas>;
  /** Del 1/1 a ahora, por mes: el tablero mensual. */
  ventasAnio: Bloque<PanelVentas>;
  /** Presupuestos y carritos sin enviar a SAINT, al precio de hoy. */
  ventasActivas: Bloque<PanelVentasActivas>;
  metas: Bloque<MetaVenta[]>;
  horario: BusinessHours;
  /** Conversaciones del período (conversión por persona). `recortado` = el rango pasó el tope de 92 días. */
  conversaciones: BloqueConTope<PanelConversaciones>;
  /** Bolívares por dólar; 0 = sin tasa (pintar «—»). */
  tasaBcv: number;
}

/** Los totales del canal elegido: "resumen" suma los dos. */
function canalDeVista(v: PanelVentas, vista: Vista): CanalVentas {
  return vista === "resumen" ? sumaCanales(v) : v.canales[vista];
}

export function DashboardView(props: DashboardViewProps) {
  const { periodo, vista, ahora, ventas, ventasPrevio, ventasHoy, ventasActivas, conversaciones } = props;

  return (
    <PanelMarco
      panel="dashboard"
      titulo="Dashboard de ventas"
      ahora={ahora}
      periodo={periodo}
      vista={vista}
      controles={
        <>
          <ControlVista vista={vista} />
          <ControlPeriodo periodo={periodo} />
        </>
      }
    >
      <div className="pn-bento">
        <div className="pn-c6">
          <PanelBloque bloque={ventas} nombre="Ventas del período">
            {(dato) => {
              const canal = canalDeVista(dato, vista);
              return (
                <section className="pn-card pn-card--hero">
                  <p className="pn-eyebrow">Ventas · {props.rangos.periodo.etiqueta}</p>
                  <p className="pn-kpi__cifra">{formatoUsd(canal.ingresos)}</p>
                  <p className="pn-subtitulo">
                    {canal.envios} envíos a SAINT · ticket {formatoUsd(canal.ticket)}
                  </p>
                  {ventasPrevio.ok && (
                    <p className="pn-subtitulo">
                      {props.rangos.previo.etiqueta}: {formatoUsd(canalDeVista(ventasPrevio.dato, vista).ingresos)}
                    </p>
                  )}
                </section>
              );
            }}
          </PanelBloque>
        </div>

        <div className="pn-c6">
          <PanelBloque bloque={ventasHoy} nombre="Ventas de hoy">
            {(dato) => {
              const canal = canalDeVista(dato, vista);
              return (
                <section className="pn-card">
                  <p className="pn-eyebrow">Hoy</p>
                  <p className="pn-kpi__cifra">{formatoUsd(canal.ingresos)}</p>
                  <p className="pn-subtitulo">{canal.envios} envíos</p>
                </section>
              );
            }}
          </PanelBloque>
        </div>

        <div className="pn-c6">
          <PanelBloque bloque={ventasActivas} nombre="Ventas en curso">
            {(dato) => (
              <section className="pn-card">
                <p className="pn-eyebrow">En curso</p>
                <p className="pn-kpi__cifra">{formatoUsd(dato.total)}</p>
                <p className="pn-subtitulo">
                  {dato.presupuestos.cantidad} presupuestos · {dato.carritos.cantidad} carritos
                </p>
              </section>
            )}
          </PanelBloque>
        </div>

        <div className="pn-c6">
          <PanelBloque bloque={conversaciones} nombre="Conversaciones">
            {(dato) => (
              <section className="pn-card">
                <p className="pn-eyebrow">Chat</p>
                <p className="pn-kpi__cifra">{dato.embudo.escribieron}</p>
                <p className="pn-subtitulo">
                  escribieron · {dato.embudo.compraron} compraron
                  {conversaciones.recortado ? " (últimos 92 días)" : ""}
                </p>
              </section>
            )}
          </PanelBloque>
        </div>
      </div>
    </PanelMarco>
  );
}
