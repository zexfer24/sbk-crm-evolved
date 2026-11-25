"use client";

import { useState } from "react";
import type { BusinessHours } from "@/lib/business-hours";
import type { Bloque, BloqueConTope } from "@/lib/paneles-data";
import { VISTAS, enviosDeTiendaOcultos, textoTiendaOculta, type Vista } from "@/lib/paneles/canal";
import { TEXTO_INICIO_PANELES, TEXTO_SIN_PREVIO, type PeriodoId } from "@/lib/paneles/periodos";
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
  /** Período previo equivalente, para comparar. `null` si no hay previo comparable (empieza antes del piso de datos). */
  ventasPrevio: Bloque<PanelVentas> | null;
  conversaciones: BloqueConTope<PanelConversaciones>;
  conversacionesPrevio: BloqueConTope<PanelConversaciones> | null;
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
  // 21/11/2026: sin período anterior comparable (arrancaría antes del 16/11) no hay con qué comparar.
  const previoDelRango = rangos.previo;
  const sinPrevio = previoDelRango === null || ventasPrevio === null;
  const comparando = comparar && !sinPrevio;
  const { activa, irA } = useNavegacionDeSecciones();
  const contexto = VISTAS.find((v) => v.id === vista)?.contexto ?? "";
  // D1 (21/11/2026): con la tienda oculta, el total de «Resumen» ya suma sus envíos; se avisa cuántos son.
  const enviosTienda = vista === "resumen" && ventas.ok ? enviosDeTiendaOcultos(ventas.dato.canales.tienda.envios) : 0;

  return (
    <PanelMarco
      panel="analiticas"
      titulo="Analíticas"
      ahora={ahora}
      controles={
        <>
          <ControlVista vista={vista} />
          <ControlPeriodo periodo={periodo} />
          <button
            type="button"
            className="an-comp"
            aria-pressed={comparando}
            disabled={sinPrevio}
            title={sinPrevio ? TEXTO_SIN_PREVIO : undefined}
            onClick={() => setComparar((c) => !c)}
          >
            <span className="an-comp__riel" aria-hidden="true" />
            Comparar con el período anterior
          </button>
        </>
      }
    >
      <div className="an-contexto an-sube" style={{ ["--i" as string]: 1 }}>
        <p aria-live="polite">{contexto}</p>
        <span className="pn-chip pn-chip--neutro">{rotuloDelRango(rangos)}</span>
        {enviosTienda > 0 && <span className="pn-chip pn-chip--alerta">{textoTiendaOculta(enviosTienda)}</span>}
        {previoDelRango === null || ventasPrevio === null ? (
          <span className="pn-chip pn-chip--neutro">{TEXTO_SIN_PREVIO}</span>
        ) : (
          comparar && <span className="pn-chip pn-chip--neutro">Contra: {previoDelRango.etiqueta.toLowerCase()}</span>
        )}
        {rangos.periodoRecortado && <span className="pn-chip pn-chip--alerta">{TEXTO_INICIO_PANELES}</span>}
      </div>

      <NavSecciones activa={activa} onIr={irA} />

      <div className="an-kpis">
        <KpisDeAnaliticas
          ventas={ventas}
          previo={ventasPrevio}
          conversaciones={conversaciones}
          conversacionesPrevio={conversacionesPrevio}
          vista={vista}
          comparar={comparando}
          sinPrevio={sinPrevio}
          tasaBcv={tasaBcv}
        />
      </div>

      <div className="pn-bento">
        <Seccion id="ingresos" indice={3}>
          <IngresosEnElTiempo
            ventas={ventas}
            previo={ventasPrevio}
            vista={vista}
            comparar={comparando}
            rangos={rangos}
            sinPrevio={sinPrevio}
          />
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
          <RendimientoDeMetas
            ventasUltimos40={ventasUltimos40}
            metas={metas}
            vista={vista}
            horario={horario}
            ahora={ahora}
            piso={rangos.piso}
          />
        </Seccion>
        <Seccion id="mensual" indice={9}>
          <IngresosMensuales ventasAnio={ventasAnio} vista={vista} ahora={ahora} piso={rangos.piso} />
        </Seccion>
      </div>
    </PanelMarco>
  );
}
