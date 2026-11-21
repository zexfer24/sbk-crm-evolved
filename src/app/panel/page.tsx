import { exigirAccesoPaneles } from "./acceso-servidor";
import { fetchBusinessHours, fetchLatestBcvRate } from "@/lib/data";
import {
  bloqueAntesDelInicio,
  bloqueConTopeAntesDelInicio,
  fetchMetasVenta,
  fetchPanelConversaciones,
  fetchPanelVentas,
  fetchPanelVentasActivas,
} from "@/lib/paneles-data";
import { vistaDesdeParam } from "@/lib/paneles/canal";
import { esRangoVacio, periodoDesdeParam } from "@/lib/paneles/periodos";
import { rangosDelDashboard } from "@/lib/paneles/rangos";
import type { PanelConversaciones, PanelVentas } from "@/lib/paneles/parse";
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
 *
 * 21/11/2026 (plan "Los paneles cuentan desde el lunes 16/11/2026"): los
 * rangos nunca arrancan antes del piso de datos. Un rango que queda vacío
 * (todo cae antes del piso) NO llama a su RPC y la vista recibe
 * `bloqueAntesDelInicio()`; si no hay período previo comparable
 * (`rangos.previo === null`) tampoco se lee y la vista recibe `null`.
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
  const leerVentas = (r: { desde: Date; hasta: Date }) =>
    esRangoVacio(r) ? Promise.resolve(bloqueAntesDelInicio<PanelVentas>()) : fetchPanelVentas(supabase, r.desde, r.hasta);
  const ventasDelPeriodo = leerVentas(rangos.periodo);
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
    rangos.previo === null ? Promise.resolve(null) : leerVentas(rangos.previo),
    mismoRango(rangos.periodo, rangos.hoy) ? ventasDelPeriodo : leerVentas(rangos.hoy),
    leerVentas(rangos.historia),
    mismoRango(rangos.periodo, rangos.anio) ? ventasDelPeriodo : leerVentas(rangos.anio),
    fetchPanelVentasActivas(supabase),
    fetchMetasVenta(supabase),
    fetchBusinessHours(supabase),
    esRangoVacio(rangos.periodo)
      ? Promise.resolve(bloqueConTopeAntesDelInicio<PanelConversaciones>())
      : fetchPanelConversaciones(supabase, rangos.periodo.desde, rangos.periodo.hasta),
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
