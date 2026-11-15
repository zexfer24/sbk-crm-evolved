import { createClient } from "@/lib/supabase/server";
import { fetchBusinessHours, fetchLatestBcvRate } from "@/lib/data";
import {
  fetchMetasVenta,
  fetchPanelConversaciones,
  fetchPanelVentas,
  fetchPanelVentasActivas,
} from "@/lib/paneles-data";
import { vistaDesdeParam } from "@/lib/paneles/canal";
import { periodoDesdeParam } from "@/lib/paneles/periodos";
import { rangosDeAnaliticas } from "@/lib/paneles/rangos";
import { AnaliticasView } from "@/components/paneles/analiticas-view";
import { primero, type ParametrosDePagina } from "../params";

/**
 * Analíticas (plan "Paneles", 13/11/2026). Ventas y conversaciones del período
 * y del previo (para comparar), el año (tablero mensual), los últimos 40 días
 * (calendario de rendimiento), ventas en curso, metas, horario y tasa BCV.
 * Misma regla que el Dashboard: todo se lee acá, la vista no toca esta página,
 * y el candado de rol vive en el layout y en las RPC.
 */
export default async function PanelAnaliticasPage({ searchParams }: { searchParams: ParametrosDePagina }) {
  const params = await searchParams;
  const periodo = periodoDesdeParam(primero(params.periodo));
  const vista = vistaDesdeParam(primero(params.vista));

  const ahora = new Date();
  const rangos = rangosDeAnaliticas(periodo, ahora);
  const supabase = await createClient();

  const [
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
  ] = await Promise.all([
    fetchPanelVentas(supabase, rangos.periodo.desde, rangos.periodo.hasta),
    fetchPanelVentas(supabase, rangos.previo.desde, rangos.previo.hasta),
    fetchPanelConversaciones(supabase, rangos.periodo.desde, rangos.periodo.hasta),
    fetchPanelConversaciones(supabase, rangos.previo.desde, rangos.previo.hasta),
    fetchPanelVentas(supabase, rangos.anio.desde, rangos.anio.hasta),
    fetchPanelVentas(supabase, rangos.ultimos40.desde, rangos.ultimos40.hasta),
    fetchPanelVentasActivas(supabase),
    fetchMetasVenta(supabase),
    fetchBusinessHours(supabase),
    fetchLatestBcvRate(supabase),
  ]);

  return (
    <AnaliticasView
      periodo={periodo}
      vista={vista}
      ahora={ahora}
      rangos={rangos}
      ventas={ventas}
      ventasPrevio={ventasPrevio}
      conversaciones={conversaciones}
      conversacionesPrevio={conversacionesPrevio}
      ventasAnio={ventasAnio}
      ventasUltimos40={ventasUltimos40}
      ventasActivas={ventasActivas}
      metas={metas}
      horario={horario}
      tasaBcv={tasaBcv}
    />
  );
}
