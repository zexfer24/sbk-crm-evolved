"use client";

import type { BusinessHours } from "@/lib/business-hours";
import type { Bloque, BloqueConTope } from "@/lib/paneles-data";
import type { Vista } from "@/lib/paneles/canal";
import type { PeriodoId } from "@/lib/paneles/periodos";
import type { RangosDeAnaliticas } from "@/lib/paneles/rangos";
import {
  sumaCanales,
  type MetaVenta,
  type PanelConversaciones,
  type PanelVentas,
  type PanelVentasActivas,
} from "@/lib/paneles/parse";
import { ControlPeriodo, ControlVista, PanelBloque, PanelMarco, formatoUsd } from "@/components/paneles/panel-marco";

/**
 * Analíticas (plan "Paneles", 13/11/2026). VISTA PROVISIONAL de C2/C3: resumen
 * simple con lo que ya llega por props. C5 la reemplaza; las props de abajo son
 * el contrato con `src/app/panel/analiticas/page.tsx` y NO cambian.
 */
export interface AnaliticasViewProps {
  periodo: PeriodoId;
  vista: Vista;
  /** Instante de la lectura (lo fija el servidor). */
  ahora: Date;
  rangos: RangosDeAnaliticas;
  ventas: Bloque<PanelVentas>;
  /** Período previo equivalente, para comparar. */
  ventasPrevio: Bloque<PanelVentas>;
  conversaciones: BloqueConTope<PanelConversaciones>;
  conversacionesPrevio: BloqueConTope<PanelConversaciones>;
  /** Del 1/1 a ahora, por mes: el tablero mensual. */
  ventasAnio: Bloque<PanelVentas>;
  /** Los últimos 40 días incluyendo hoy, por día: el calendario de rendimiento. */
  ventasUltimos40: Bloque<PanelVentas>;
  ventasActivas: Bloque<PanelVentasActivas>;
  metas: Bloque<MetaVenta[]>;
  horario: BusinessHours;
  /** Bolívares por dólar; 0 = sin tasa (pintar «—»). */
  tasaBcv: number;
}

export function AnaliticasView({ periodo, vista, ahora, rangos, ventas, ventasPrevio, conversaciones }: AnaliticasViewProps) {
  return (
    <PanelMarco
      panel="analiticas"
      titulo="Analíticas"
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
              const canal = vista === "resumen" ? sumaCanales(dato) : dato.canales[vista];
              return (
                <section className="pn-card">
                  <p className="pn-eyebrow">Ventas · {rangos.periodo.etiqueta}</p>
                  <p className="pn-kpi__cifra">{formatoUsd(canal.ingresos)}</p>
                  <p className="pn-subtitulo">
                    {canal.envios} envíos · {canal.unidades} unidades
                  </p>
                  {ventasPrevio.ok && (
                    <p className="pn-subtitulo">
                      {rangos.previo.etiqueta}:{" "}
                      {formatoUsd((vista === "resumen" ? sumaCanales(ventasPrevio.dato) : ventasPrevio.dato.canales[vista]).ingresos)}
                    </p>
                  )}
                </section>
              );
            }}
          </PanelBloque>
        </div>

        <div className="pn-c6">
          <PanelBloque bloque={conversaciones} nombre="Conversaciones">
            {(dato) => (
              <section className="pn-card">
                <p className="pn-eyebrow">Embudo del chat</p>
                <p className="pn-kpi__cifra">{dato.embudo.escribieron}</p>
                <p className="pn-subtitulo">
                  escribieron · {dato.embudo.respondidas} respondidas · {dato.embudo.con_carrito} con carrito ·{" "}
                  {dato.embudo.compraron} compraron
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
