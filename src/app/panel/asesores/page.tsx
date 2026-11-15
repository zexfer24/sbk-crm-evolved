import { exigirAccesoPaneles } from "../acceso-servidor";
import { fetchBusinessHours } from "@/lib/data";
import {
  fetchPanelAsesores,
  fetchPanelCola,
  fetchPanelConversaciones,
  fetchPanelVentas,
} from "@/lib/paneles-data";
import { periodoDesdeParam, rangoDe } from "@/lib/paneles/periodos";
import { AsesoresView } from "@/components/paneles/asesores-view";
import { primero, type ParametrosDePagina } from "../params";

/**
 * Asesores (plan "Paneles", 13/11/2026). Actividad por persona y conversaciones
 * del período (para cruzar la conversión), ventas del período (el mostrador por
 * persona), la cola de pendientes de AHORA y el horario (para medir el pendiente
 * más viejo en minutos laborales). No lleva `vista`: este panel es por persona,
 * no por canal. Misma regla que los otros dos: el rol se verifica antes de leer
 * (`exigirAccesoPaneles`, 15/11/2026), además del layout y las RPC.
 */
export default async function PanelAsesoresPage({ searchParams }: { searchParams: ParametrosDePagina }) {
  const { supabase } = await exigirAccesoPaneles();
  const params = await searchParams;
  const periodo = periodoDesdeParam(primero(params.periodo));

  const ahora = new Date();
  const rango = rangoDe(periodo, ahora);
  const [asesores, conversaciones, ventas, cola, horario] = await Promise.all([
    fetchPanelAsesores(supabase, rango.desde, rango.hasta),
    fetchPanelConversaciones(supabase, rango.desde, rango.hasta),
    fetchPanelVentas(supabase, rango.desde, rango.hasta),
    fetchPanelCola(supabase),
    fetchBusinessHours(supabase),
  ]);

  return (
    <AsesoresView
      periodo={periodo}
      ahora={ahora}
      rango={rango}
      asesores={asesores}
      conversaciones={conversaciones}
      ventas={ventas}
      cola={cola}
      horario={horario}
    />
  );
}
