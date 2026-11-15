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
 * No consulta al agente ni el rol: el `layout.tsx` de `/panel` ya lo hizo y las
 * RPC lo vuelven a verificar (42501, que SÍ se relanza y atrapa `error.tsx`).
 */
export default async function PanelDashboardPage({ searchParams }: { searchParams: ParametrosDePagina }) {
  const params = await searchParams;
  const periodo = periodoDesdeParam(primero(params.periodo));
  const vista = vistaDesdeParam(primero(params.vista));

  const ahora = new Date();
  const rangos = rangosDelDashboard(periodo, ahora);
  const supabase = await createClient();

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
    fetchPanelVentas(supabase, rangos.periodo.desde, rangos.periodo.hasta),
    fetchPanelVentas(supabase, rangos.previo.desde, rangos.previo.hasta),
    fetchPanelVentas(supabase, rangos.hoy.desde, rangos.hoy.hasta),
    fetchPanelVentas(supabase, rangos.historia.desde, rangos.historia.hasta),
    fetchPanelVentas(supabase, rangos.anio.desde, rangos.anio.hasta),
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
