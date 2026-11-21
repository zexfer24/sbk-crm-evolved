"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import type { BusinessHours } from "@/lib/business-hours";
import type { Bloque, BloqueConTope } from "@/lib/paneles-data";
import type { Vista } from "@/lib/paneles/canal";
import type { PeriodoId } from "@/lib/paneles/periodos";
import type { RangosDelDashboard } from "@/lib/paneles/rangos";
import type { MetaVenta, PanelConversaciones, PanelVentas, PanelVentasActivas } from "@/lib/paneles/parse";
import { ControlPeriodo, ControlVista, PanelBloque, PanelMarco } from "@/components/paneles/panel-marco";
import { HojaConversion, HojaEnviado, HojaUnidades, HojaVentasActivas } from "@/components/paneles/dashboard/hojas";
import { KpiConversion, KpiEnviado, KpiUnidades, KpiVentasActivas } from "@/components/paneles/dashboard/kpis";
import { LoMasViejo } from "@/components/paneles/dashboard/lo-mas-viejo";
import { ConversionPorPersona, EnviosPorPersona } from "@/components/paneles/dashboard/por-persona";
import { TableroMensual } from "@/components/paneles/dashboard/tablero-mensual";
import { TarjetaRendimiento } from "@/components/paneles/dashboard/tarjeta-rendimiento";
import "@/components/paneles/dashboard/dashboard.css";

/**
 * Dashboard de ventas (`/panel`, plan "Paneles", C4, 13/11/2026): el bento de
 * la propuesta A · Mostrador con datos reales. `page.tsx` lee todo y llega por
 * las props de abajo (contrato que NO cambia); acá solo se arma la pantalla.
 *
 * Cada tarjeta vive en su propio `PanelBloque`: una lectura caída pinta el
 * degradado con Reintentar en ESE hueco y las demás siguen. Cambiar de vista o
 * de período no remonta nada: `page.tsx` vuelve a pasar props y las cifras
 * (`Cifra`) viajan del valor anterior al nuevo.
 */
export interface DashboardViewProps {
  periodo: PeriodoId;
  vista: Vista;
  /** Instante de la lectura (lo fija el servidor). */
  ahora: Date;
  rangos: RangosDelDashboard;
  /** Ventas del período elegido. */
  ventas: Bloque<PanelVentas>;
  /** Ventas del período previo equivalente (para el chip de variación). `null` si no hay previo comparable (empieza antes del piso de datos). */
  ventasPrevio: Bloque<PanelVentas> | null;
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

type HojaId = "activas" | "enviado" | "unidades" | "conversion";

/** Una celda del bento: lleva su lugar en la grilla y su turno de entrada (`--i`, escalonado). */
function Celda({ ancho, indice, clase, children }: { ancho: string; indice: number; clase: string; children: ReactNode }) {
  return (
    <div className={`${ancho} pd-celda ${clase}`} style={{ "--i": indice } as CSSProperties}>
      {children}
    </div>
  );
}

export function DashboardView(props: DashboardViewProps) {
  const { periodo, vista, ahora, rangos, ventas, ventasPrevio, ventasHoy, ventasActivas, conversaciones } = props;
  const [hoja, setHoja] = useState<HojaId | null>(null);
  const cerrar = () => setHoja(null);

  const previo = ventasPrevio?.ok ? ventasPrevio.dato : null;
  // 21/11/2026: sin período anterior comparable (arrancaría antes del 16/11) las tarjetas lo dicen en vez de mostrar una variación.
  const sinPrevio = rangos.previo === null || ventasPrevio === null;
  const [anio, mes] = rangos.hoyClave.split("-").map(Number);
  const enTienda = vista === "tienda";

  return (
    <PanelMarco
      panel="dashboard"
      titulo="Dashboard de ventas"
      ahora={ahora}
      controles={
        <>
          <ControlVista vista={vista} />
          <ControlPeriodo periodo={periodo} />
        </>
      }
    >
      <div className="pn-bento pd">
        <Celda ancho="pn-c3" indice={0} clase="pd-celda--activas">
          <PanelBloque bloque={ventasActivas} nombre="Ventas activas">
            {(dato) => <KpiVentasActivas datos={dato} vista={vista} ahora={ahora} onAbrir={() => setHoja("activas")} />}
          </PanelBloque>
        </Celda>

        <Celda ancho="pn-c3" indice={1} clase="pd-celda--enviado">
          <PanelBloque bloque={ventas} nombre="Enviado a SAINT">
            {(dato) => (
              <KpiEnviado
                ventas={dato}
                previo={previo}
                etiquetaPrevio={rangos.previo?.etiqueta ?? ""}
                vista={vista}
                tasaBcv={props.tasaBcv}
                avisarInicioDePaneles={rangos.periodoRecortado}
                sinPrevio={sinPrevio}
                onAbrir={() => setHoja("enviado")}
              />
            )}
          </PanelBloque>
        </Celda>

        <Celda ancho="pn-c3" indice={2} clase="pd-celda--unidades">
          <PanelBloque bloque={ventas} nombre="Unidades vendidas">
            {(dato) => (
              <KpiUnidades
                ventas={dato}
                previo={previo}
                etiquetaPrevio={rangos.previo?.etiqueta ?? ""}
                vista={vista}
                sinPrevio={sinPrevio}
                onAbrir={() => setHoja("unidades")}
              />
            )}
          </PanelBloque>
        </Celda>

        <Celda ancho="pn-c3" indice={3} clase="pd-celda--conversion">
          {enTienda ? (
            <KpiConversion conversaciones={null} recortado={false} enTienda />
          ) : (
            <PanelBloque bloque={conversaciones} nombre="Tasa de conversión">
              {(dato) => (
                <KpiConversion
                  conversaciones={dato}
                  recortado={conversaciones.recortado}
                  enTienda={false}
                  onAbrir={() => setHoja("conversion")}
                />
              )}
            </PanelBloque>
          )}
        </Celda>

        <Celda ancho="pn-c5" indice={4} clase="pd-celda--rendimiento">
          <PanelBloque bloque={ventasHoy} nombre="Rendimiento de ventas">
            {(dato) => (
              <TarjetaRendimiento
                hoy={dato}
                historia={props.ventasHistoria}
                metas={props.metas}
                horario={props.horario}
                vista={vista}
                ahora={ahora}
                hoyClave={rangos.hoyClave}
                piso={rangos.piso}
              />
            )}
          </PanelBloque>
        </Celda>

        <Celda ancho="pn-c7" indice={5} clase="pd-celda--persona">
          {enTienda ? (
            <PanelBloque bloque={ventas} nombre="Envíos por persona">
              {(dato) => <EnviosPorPersona ventas={dato} />}
            </PanelBloque>
          ) : (
            <PanelBloque bloque={conversaciones} nombre="Conversión por persona">
              {(dato) => <ConversionPorPersona conversaciones={dato} vista={vista} recortado={conversaciones.recortado} />}
            </PanelBloque>
          )}
        </Celda>

        <Celda ancho="pn-c8" indice={6} clase="pd-celda--tablero">
          <PanelBloque bloque={props.ventasAnio} nombre="Ingresos por mes">
            {(dato) => <TableroMensual ventas={dato} vista={vista} anio={anio} mesActual={mes} piso={rangos.piso} />}
          </PanelBloque>
        </Celda>

        <Celda ancho="pn-c4" indice={7} clase="pd-celda--viejo">
          <PanelBloque bloque={ventasActivas} nombre="Lo más viejo sin procesar">
            {(dato) => <LoMasViejo datos={dato} vista={vista} ahora={ahora} onVerTodas={() => setHoja("activas")} />}
          </PanelBloque>
        </Celda>
      </div>

      {ventasActivas.ok && (
        <HojaVentasActivas
          abierta={hoja === "activas"}
          onCerrar={cerrar}
          datos={ventasActivas.dato}
          vista={vista}
          ahora={ahora}
        />
      )}
      {ventas.ok && (
        <>
          <HojaEnviado abierta={hoja === "enviado"} onCerrar={cerrar} ventas={ventas.dato} vista={vista} />
          <HojaUnidades abierta={hoja === "unidades"} onCerrar={cerrar} ventas={ventas.dato} vista={vista} />
        </>
      )}
      {conversaciones.ok && !enTienda && (
        <HojaConversion abierta={hoja === "conversion"} onCerrar={cerrar} conversaciones={conversaciones.dato} />
      )}
    </PanelMarco>
  );
}
