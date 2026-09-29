import type { SupabaseClient } from "@supabase/supabase-js";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Envoltorio del corrector de tipeos del catálogo (T2, plan "Seba encuentra,
// no insiste, y el mostrador no deja a nadie esperando", 28/9/2026).
//
// El estudio del VPS (1.027 turnos, 25/9 → 28/9/2026) encontró clientes que
// escriben el repuesto con un tropiezo de tecla ("horsen", "tisum",
// "express", "iphone", "swhera", "ciguañal") y reciben "no lo encuentro"
// aunque HORSE/TIMSUN/XPRESS/IPONE/SWITCHERA/CIGUEÑAL estén en el catálogo.
// La corrección vive en SQL (`corregir_terminos`, migración
// 20260928020000): el vocabulario sale de `products` al vuelo, así que no hay
// nada que sincronizar. Este módulo solo la llama y arma la frase con la que
// Seba avisa lo que buscó de verdad.
//
// NUNCA LANZA: el corrector es el segundo intento de una búsqueda que ya
// falló, no algo de lo que dependa el turno. Un error (migración sin aplicar,
// corte de red, extensión mal instalada) deja `correccion_terminos_fallida` en
// la bitácora y devuelve `[]` — la herramienta sigue por el camino "no
// identificado" de siempre, igual que antes de esta corrida. Un error de la
// base con el mismo texto de siempre sería invisible ("[object Object]"):
// por eso `errorText`, el único traductor de errores a texto de log.
// ---------------------------------------------------------------------------

export interface CorreccionTermino {
  /** El término tal como lo escribió el cliente ("iphone"). */
  original: string;
  /** La palabra del catálogo por la que se reemplazó, en minúsculas y sin acentos ("ipone"). */
  corregido: string;
}

function esCorreccion(fila: unknown): fila is CorreccionTermino {
  if (typeof fila !== "object" || fila === null) return false;
  const { original, corregido } = fila as Record<string, unknown>;
  return typeof original === "string" && original !== "" && typeof corregido === "string" && corregido !== "";
}

/**
 * Pide a la base la corrección de los términos que no calzaron. `protegidos`
 * son las palabras que jamás se tocan (`MOTOS_CONOCIDAS`: "beta" es una moto,
 * no un tipeo de "bera"). Devuelve SOLO los términos corregidos, en el orden
 * en que llegaron; `[]` si no hay nada que corregir o si algo falló.
 * `conversationId` es opcional y solo alimenta el log.
 */
export async function corregirTerminos(
  supabase: SupabaseClient,
  terminos: string[],
  protegidos: string[],
  conversationId?: string
): Promise<CorreccionTermino[]> {
  if (terminos.length === 0) return [];

  try {
    const { data, error } = await supabase.rpc("corregir_terminos", {
      p_terminos: terminos,
      p_protegidos: protegidos,
    });

    if (error) {
      log.warn("correccion_terminos_fallida", { conversationId, detail: errorText(error) });
      return [];
    }

    if (!Array.isArray(data)) return [];
    return data.filter(esCorreccion).map((fila) => ({ original: fila.original, corregido: fila.corregido }));
  } catch (err) {
    log.warn("correccion_terminos_fallida", { conversationId, detail: errorText(err) });
    return [];
  }
}

/**
 * La frase que Seba le dice al cliente cuando se buscó otra palabra: "busqué
 * IPONE en lugar de iphone" (lo que se buscó, en mayúsculas como en el
 * catálogo, contra lo que el cliente escribió). Varias correcciones se unen
 * con coma y "y" antes de la última. Sin correcciones, cadena vacía.
 */
export function describirCorreccion(correcciones: readonly CorreccionTermino[]): string {
  const partes = correcciones.map((c) => `${c.corregido.toUpperCase()} en lugar de ${c.original}`);
  if (partes.length === 0) return "";
  if (partes.length === 1) return `busqué ${partes[0]}`;
  return `busqué ${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;
}
