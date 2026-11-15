"use client";

import { useState } from "react";
import type { BusinessHours } from "@/lib/business-hours";
import type { Bloque, BloqueConTope } from "@/lib/paneles-data";
import { VISTAS, type Vista } from "@/lib/paneles/canal";
import type { PeriodoId } from "@/lib/paneles/periodos";
import type { RangosDeAnaliticas } from "@/lib/paneles/rangos";
import type { MetaVenta, PanelConversaciones, PanelVentas, PanelVentasActivas } from "@/lib/paneles/parse";
import { todayKey } from "@/lib/sales-day";
import { ControlPeriodo, ControlVista, PanelMarco } from "@/components/paneles/panel-marco";
import { etiquetaDeDia } from "@/components/paneles/analiticas/datos";
import { KpisDeAnaliticas } from "@/components/paneles/analiticas/kpis";
import { IngresosEnElTiempo } from "@/components/paneles/analiticas/ingresos";
import { EmbudoConversacional } from "@/components/paneles/analiticas/embudo";
import { VentasActivasAnaliticas } from "@/components/paneles/analiticas/ventas-activas";
import { UnidadesYPrecio } from "@/components/paneles/analiticas/unidades";
import { ConversionYClientes } from "@/components/paneles/analiticas/conversion";
import { RendimientoDeMetas } from "@/components/paneles/analiticas/rendimiento";
import { IngresosMensuales } from "@/components/paneles/analiticas/mensual";
import { NavSecciones, useNavegacionDeSecciones } from "@/components/paneles/analiticas/navegacion";
import { Seccion } from "@/components/paneles/analiticas/piezas";
import "@/components/paneles/analiticas/analiticas.css";

/**
 * Analíticas (plan "Paneles", C5, 13/11/2026): vista, período y «Comparar con el
 * período anterior»; un menú fijo que sigue a la sección visible; cinco KPI y
 * siete secciones (`#ingresos`, `#embudo`, `#ventas-activas`, `#unidades`,
 * `#conversion`, `#rendimiento`, `#mensual`). Las props son el contrato con
 * `src/app/panel/analiticas/page.tsx`; cada bloque se degrada solo si su
 * lectura cayó (`PanelBloque`).
 *
 * «Comparar» es estado de la vista y NO de la URL: no cambia lo que lee el
 * servidor (el período previo ya viene siempre en las props), solo si se
 * dibuja. Arranca encendido, como en el mockup.
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

/** Desde cuándo existe la foto de los envíos a SAINT (`ventas_saint`): antes no hay datos. */
const INICIO_ENVIOS_SAINT = new Date("2026-10-26T00:00:00-04:00");

function rotuloDelRango(rangos: RangosDeAnaliticas): string {
  const desde = todayKey(rangos.periodo.desde);
  const hasta = todayKey(rangos.periodo.hasta);
  return desde === hasta ? etiquetaDeDia(hasta) : `${etiquetaDeDia(desde)} – ${etiquetaDeDia(hasta)}`;
}

export function AnaliticasView({
  periodo,
  vista,
  ahora,
  rangos,
  ventas,
  ventasPrevio,
  conversaciones,
  conversacionesPrevio,
  ventasAnio,
  ventasUltimos40,
  ventasActivas,
  metas,
  horario,
  tasaBcv,
}: AnaliticasViewProps) {
  const [comparar, setComparar] = useState(true);
  const { activa, irA } = useNavegacionDeSecciones();
  const contexto = VISTAS.find((v) => v.id === vista)?.contexto ?? "";

  return (
    <PanelMarco
      panel="analiticas"
      titulo="Analíticas"
      ahora={ahora}
      controles={
        <>
          <ControlVista vista={vista} />
          <ControlPeriodo periodo={periodo} />
          <button type="button" className="an-comp" aria-pressed={comparar} onClick={() => setComparar((c) => !c)}>
            <span className="an-comp__riel" aria-hidden="true" />
            Comparar con el período anterior
          </button>
        </>
      }
    >
      <div className="an-contexto an-sube" style={{ ["--i" as string]: 1 }}>
        <p aria-live="polite">{contexto}</p>
        <span className="pn-chip pn-chip--neutro">{rotuloDelRango(rangos)}</span>
        {comparar && <span className="pn-chip pn-chip--neutro">Contra: {rangos.previo.etiqueta.toLowerCase()}</span>}
        {rangos.periodo.desde < INICIO_ENVIOS_SAINT && (
          <span className="pn-chip pn-chip--alerta">Los envíos a SAINT se registran desde el 26/10/2026</span>
        )}
      </div>

      <NavSecciones activa={activa} onIr={irA} />

      <div className="an-kpis">
        <KpisDeAnaliticas
          ventas={ventas}
          previo={ventasPrevio}
          conversaciones={conversaciones}
          conversacionesPrevio={conversacionesPrevio}
          vista={vista}
          comparar={comparar}
          tasaBcv={tasaBcv}
        />
      </div>

      <div className="pn-bento">
        <Seccion id="ingresos" indice={3}>
          <IngresosEnElTiempo ventas={ventas} previo={ventasPrevio} vista={vista} comparar={comparar} rangos={rangos} />
        </Seccion>
        <Seccion id="embudo" indice={4}>
          <EmbudoConversacional conversaciones={conversaciones} vista={vista} horario={horario} />
        </Seccion>
        <Seccion id="ventas-activas" indice={5}>
          <VentasActivasAnaliticas ventasActivas={ventasActivas} vista={vista} ahora={ahora} />
        </Seccion>
        <Seccion id="unidades" indice={6}>
          <UnidadesYPrecio ventas={ventas} vista={vista} />
        </Seccion>
        <Seccion id="conversion" indice={7}>
          <ConversionYClientes conversaciones={conversaciones} ventas={ventas} vista={vista} />
        </Seccion>
        <Seccion id="rendimiento" indice={8}>
          <RendimientoDeMetas ventasUltimos40={ventasUltimos40} metas={metas} vista={vista} horario={horario} ahora={ahora} />
        </Seccion>
        <Seccion id="mensual" indice={9}>
          <IngresosMensuales ventasAnio={ventasAnio} vista={vista} ahora={ahora} />
        </Seccion>
      </div>
    </PanelMarco>
  );
}
