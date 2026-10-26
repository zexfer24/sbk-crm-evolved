import type { SupabaseClient } from "@supabase/supabase-js";
import {
  borradorDesdeFila,
  type BorradorSaint,
  type DatosClienteSaint,
  type FilaBorradorSaint,
  type OrigenSaint,
} from "@/lib/saint-borradores";

/**
 * Llamadas a las dos RPC de "Enviar a SAINT" (25/10/2026, plan "Enviar a
 * SAINT", T2). Corre en el navegador: los errores se relanzan TAL CUAL (objeto
 * con `code`/`message`/`details`) para que la interfaz los traduzca con
 * `mensajeErrorEnvio`; envolverlos en un `Error` perdería el `code`.
 */

export async function enviarBorradorSaint(
  supabase: SupabaseClient,
  input: { origen: OrigenSaint; origenId: string; datos: DatosClienteSaint },
): Promise<string> {
  const { datos } = input;
  const { data, error } = await supabase.rpc("enviar_borrador_saint", {
    p_origen: input.origen,
    p_origen_id: input.origenId,
    p_cedula_tipo: datos.cedulaTipo.trim().toUpperCase(),
    p_cedula_numero: datos.cedulaNumero.trim(),
    p_nombre: datos.nombre.trim(),
    p_apellido: datos.apellido.trim(),
    p_telefono: datos.telefono.trim(),
  });
  if (error) throw error;
  return data as string;
}

/**
 * El ÚLTIMO envío de cada origen, por `origenId`. Sin ids no toca la base; los
 * repetidos y los vacíos se descartan antes de llamar.
 */
export async function fetchUltimosBorradores(
  supabase: SupabaseClient,
  origenIds: string[],
): Promise<Map<string, BorradorSaint>> {
  const ids = [...new Set(origenIds.filter((id) => id !== ""))];
  const resultado = new Map<string, BorradorSaint>();
  if (ids.length === 0) return resultado;

  const { data, error } = await supabase.rpc("borradores_saint", { p_origen_ids: ids });
  if (error) throw error;
  for (const fila of (data ?? []) as FilaBorradorSaint[]) {
    const borrador = borradorDesdeFila(fila);
    resultado.set(borrador.origenId, borrador);
  }
  return resultado;
}
