import { exigirAccesoPaneles } from "../acceso-servidor";
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
import type { PanelConversaciones, PanelVentas } from "@/lib/paneles/parse";
import { esRangoVacio, periodoDesdeParam } from "@/lib/paneles/periodos";
import { rangosDeAnaliticas } from "@/lib/paneles/rangos";
import { AnaliticasView } from "@/components/paneles/analiticas-view";
import { primero, type ParametrosDePagina } from "../params";

/**
 * Analíticas (plan "Paneles", 13/11/2026). Ventas y conversaciones del período
 * y del previo (para comparar), el año (tablero mensual), los últimos 40 días
 * (calendario de rendimiento), ventas en curso, metas, horario y tasa BCV.
 * Misma regla que el Dashboard: todo se lee acá, la vista no toca esta página,
 * y el rol se verifica antes de leer (`exigirAccesoPaneles`, 15/11/2026) además
 * de en el layout y en las RPC.
 *
 * 21/11/2026 (plan "Los paneles cuentan desde el lunes 16/11/2026"): igual que
 * el Dashboard, un rango vacío (todo antes del piso de datos) no llama a su RPC
 * y recibe `bloqueAntesDelInicio()`, y sin período previo comparable
 * (`rangos.previo === null`) la vista recibe `null` en los dos previos.
 */
export default async function PanelAnaliticasPage({ searchParams }: { searchParams: ParametrosDePagina }) {
  const { supabase } = await exigirAccesoPaneles();
  const params = await searchParams;
  const periodo = periodoDesdeParam(primero(params.periodo));
  const vista = vistaDesdeParam(primero(params.vista));

  const ahora = new Date();
  const rangos = rangosDeAnaliticas(periodo, ahora);
  const leerVentas = (r: { desde: Date; hasta: Date }) =>
    esRangoVacio(r) ? Promise.resolve(bloqueAntesDelInicio<PanelVentas>()) : fetchPanelVentas(supabase, r.desde, r.hasta);
  const leerConversaciones = (r: { desde: Date; hasta: Date }) =>
    esRangoVacio(r)
      ? Promise.resolve(bloqueConTopeAntesDelInicio<PanelConversaciones>())
      : fetchPanelConversaciones(supabase, r.desde, r.hasta);
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
    leerVentas(rangos.periodo),
    rangos.previo === null ? Promise.resolve(null) : leerVentas(rangos.previo),
    leerConversaciones(rangos.periodo),
    rangos.previo === null ? Promise.resolve(null) : leerConversaciones(rangos.previo),
    leerVentas(rangos.anio),
    leerVentas(rangos.ultimos40),
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
