import { exigirAccesoPaneles } from "./acceso-servidor";
import { fetchBusinessHours, fetchLatestBcvRate } from "@/lib/data";
import {
  fetchMetasVenta,
  fetchPanelConversaciones,
  fetchPanelVentas,
  fetchPanelVentasActivas,
} from "@/lib/paneles-data";
import { vistaDesdeParam } from "@/lib/paneles/canal";
import { periodoDesdeParam } from "@/lib/paneles/periodos";
import { rangosDelDashboard } from "@/lib/paneles/rangos";
import { DashboardView } from "@/components/paneles/dashboard-view";
import { primero, type ParametrosDePagina } from "./params";

/**
 * Dashboard de ventas (plan "Paneles", 13/11/2026). Lee de una vez TODO lo que
 * el panel va a necesitar (período y previo, hoy por hora, la historia de 40
 * días para la curva horaria y la racha, el año para el tablero mensual, ventas
 * en curso, metas, horario, conversaciones y tasa BCV) para que la vista final
 * no tenga que tocar esta página. Cada lectura degrada por su cuenta
 * (`paneles-data.ts`): una que falle pinta "No disponible" solo en su bloque.
 *
 * Antes de leer nada verifica el rol (`exigirAccesoPaneles`, 15/11/2026): el
 * layout se renderiza en paralelo con esta página, así que sin esto un asesor
 * disparaba las RPC igual. Comparte la consulta del agente con el layout. Las
 * RPC lo vuelven a verificar (42501, que SÍ se relanza y atrapa `error.tsx`).
 */
export default async function PanelDashboardPage({ searchParams }: { searchParams: ParametrosDePagina }) {
  const { supabase } = await exigirAccesoPaneles();
  const params = await searchParams;
  const periodo = periodoDesdeParam(primero(params.periodo));
  const vista = vistaDesdeParam(primero(params.vista));

  const ahora = new Date();
  const rangos = rangosDelDashboard(periodo, ahora);
  // 15/11/2026 (code-review): con «Hoy» el período y «hoy» son el mismo rango, y
  // con «Este año» el período y el año; la misma promesa sirve a las dos props.
  const mismoRango = (a: { desde: Date; hasta: Date }, b: { desde: Date; hasta: Date }) =>
    a.desde.getTime() === b.desde.getTime() && a.hasta.getTime() === b.hasta.getTime();
  const ventasDelPeriodo = fetchPanelVentas(supabase, rangos.periodo.desde, rangos.periodo.hasta);
  const [
    ventas,
    ventasPrevio,
    ventasHoy,
    ventasHistoria,
    ventasAnio,
    ventasActivas,
    metas,
    horario,
    conversaciones,
    tasaBcv,
  ] = await Promise.all([
    ventasDelPeriodo,
    fetchPanelVentas(supabase, rangos.previo.desde, rangos.previo.hasta),
    mismoRango(rangos.periodo, rangos.hoy)
      ? ventasDelPeriodo
      : fetchPanelVentas(supabase, rangos.hoy.desde, rangos.hoy.hasta),
    fetchPanelVentas(supabase, rangos.historia.desde, rangos.historia.hasta),
    mismoRango(rangos.periodo, rangos.anio)
      ? ventasDelPeriodo
      : fetchPanelVentas(supabase, rangos.anio.desde, rangos.anio.hasta),
    fetchPanelVentasActivas(supabase),
    fetchMetasVenta(supabase),
    fetchBusinessHours(supabase),
    fetchPanelConversaciones(supabase, rangos.periodo.desde, rangos.periodo.hasta),
    fetchLatestBcvRate(supabase),
  ]);

  return (
    <DashboardView
      periodo={periodo}
      vista={vista}
      ahora={ahora}
      rangos={rangos}
      ventas={ventas}
      ventasPrevio={ventasPrevio}
      ventasHoy={ventasHoy}
      ventasHistoria={ventasHistoria}
      ventasAnio={ventasAnio}
      ventasActivas={ventasActivas}
      metas={metas}
      horario={horario}
      conversaciones={conversaciones}
      tasaBcv={tasaBcv}
    />
  );
}
