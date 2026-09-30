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
 * no un tipeo de "bera"; más las lecciones `no_corregir`). `marcas` es la
 * lista cerrada hacia la que se acepta una distancia de 2 o 3: las marcas de
 * PRODUCTO (`MARCAS_DE_PRODUCTO`; T5b, 30/9/2026: sin las motos, "kenda" no
 * se corregía a HONDA por distancia 2); `excluidos` es el relleno, que ni se corrige ni sirve
 * de candidato. Firma de 4 parámetros de la RPC desde la migración
 * 20260930020000 (A2, T3, 30/9/2026): la de dos parámetros se retiró.
 * Devuelve SOLO los términos corregidos, en el orden en que llegaron; `[]` si
 * no hay nada que corregir o si algo falló. `conversationId` es opcional y
 * solo alimenta el log.
 */
export async function corregirTerminos(
  supabase: SupabaseClient,
  terminos: string[],
  protegidos: string[],
  marcas: string[],
  excluidos: string[],
  conversationId?: string
): Promise<CorreccionTermino[]> {
  if (terminos.length === 0) return [];

  try {
    const { data, error } = await supabase.rpc("corregir_terminos", {
      p_terminos: terminos,
      p_protegidos: protegidos,
      p_marcas: marcas,
      p_excluidos: excluidos,
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

/** Diagnóstico de UN grupo de alternativas contra el catálogo (`diagnosticar_terminos`). */
export interface DiagnosticoGrupo {
  /** Índice 0-based del grupo, en el orden en que se mandó. */
  grupoIdx: number;
  /** Algún producto activo con precio trae alguna alternativa del grupo. */
  enCatalogo: boolean;
  /** Algún producto trae el grupo Y la cabeza. `null` si no se mandó cabeza (o quedó fuera de rango). */
  conCabeza: boolean | null;
}

function esDiagnostico(fila: unknown): fila is { grupo_idx: number; en_catalogo: boolean; con_cabeza: boolean | null } {
  if (typeof fila !== "object" || fila === null) return false;
  const { grupo_idx, en_catalogo, con_cabeza } = fila as Record<string, unknown>;
  return (
    typeof grupo_idx === "number" &&
    typeof en_catalogo === "boolean" &&
    (typeof con_cabeza === "boolean" || con_cabeza === null)
  );
}

/**
 * A2, T3 (30/9/2026, decisión D3): por cada grupo de alternativas dice si
 * existe en el catálogo y si co-ocurre con la cabeza (`diagnosticar_terminos`,
 * migración 20260930030000). `terminos` es el MISMO formato que
 * `buscar_productos.p_terminos` (arreglo de grupos, cada uno un arreglo de
 * alternativas ya normalizadas); `cabeza` es el índice 0-based del grupo
 * cabeza o `null` si no hay. Alimenta el tercer intento de la búsqueda: relajar
 * el grupo que no existe o que no co-ocurre con la cabeza.
 *
 * NUNCA LANZA. Sin grupos devuelve `[]` sin llamar a la base. Ante error de la
 * base, excepción o una respuesta que no es un arreglo devuelve `null` (sin
 * diagnóstico) y deja `diagnostico_terminos_fallido`: a propósito NO `[]`, que
 * el llamador leería como "nada que relajar" cuando en realidad no se pudo
 * medir; con `null` no debe relajar nada y sigue por el camino de siempre.
 * Las filas mal formadas se descartan.
 */
export async function diagnosticarTerminos(
  supabase: SupabaseClient,
  terminos: string[][],
  cabeza: number | null,
  conversationId?: string
): Promise<DiagnosticoGrupo[] | null> {
  if (terminos.length === 0) return [];

  try {
    const { data, error } = await supabase.rpc("diagnosticar_terminos", {
      p_terminos: terminos,
      p_cabeza: cabeza,
    });

    if (error) {
      log.warn("diagnostico_terminos_fallido", { conversationId, detail: errorText(error) });
      return null;
    }

    if (!Array.isArray(data)) return null;
    return data
      .filter(esDiagnostico)
      .map((fila) => ({ grupoIdx: fila.grupo_idx, enCatalogo: fila.en_catalogo, conCabeza: fila.con_cabeza }));
  } catch (err) {
    log.warn("diagnostico_terminos_fallido", { conversationId, detail: errorText(err) });
    return null;
  }
}
