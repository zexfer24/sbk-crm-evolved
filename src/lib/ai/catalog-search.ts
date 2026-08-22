import { pgrstLiteral } from "@/lib/ai/pgrst";

// ---------------------------------------------------------------------------
// Cómo se busca en el catálogo.
//
// Vive aparte de tools.ts porque acá está la parte que se equivoca en
// silencio: si la consulta no calza, el agente no falla — responde con toda
// seguridad que el repuesto no existe. Un "no tenemos" falso le cuesta una
// venta a la tienda y nadie se entera nunca.
//
// Dos cosas que la búsqueda de una sola frase no resolvía, las dos vistas
// corriendo el agente contra el catálogo real:
//
//   1. El cliente escribe "bujía NGK". Ningún producto se llama así: el
//      nombre es "Bujía CR7HSA" y NGK es la marca. Buscando la frase
//      completa no aparece nada, aunque el repuesto esté en el estante.
//   2. Nadie escribe acentos por WhatsApp. "bujia" no calza con "Bujía".
//
// Por eso: se parte en palabras, se busca cada una por separado sobre una
// columna ya normalizada en la base (products.search_text, sin acentos y en
// minúsculas), y se ordena por cuántas palabras calzan.
// ---------------------------------------------------------------------------

/** Minúsculas y sin diacríticos, igual que hace unaccent() del lado de la base. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Palabras de tres o más letras, sin acentos y en minúsculas.
 *
 * Se descartan las cortas ("de", "la", "un") porque calzan con casi todo y
 * ensucian el orden. Si no queda ninguna —una búsqueda como "R6"— se usa la
 * consulta entera antes que devolver el catálogo completo.
 */
export function searchTerms(query: string): string[] {
  const normalizado = normalize(query);
  const palabras = normalizado.split(/[^a-z0-9]+/).filter((p) => p.length >= 3);

  if (palabras.length > 0) return [...new Set(palabras)];

  const entero = normalizado.trim();
  return entero ? [entero] : [];
}

/**
 * Expresión para el `.or()` de PostgREST: calza el producto que contenga
 * CUALQUIERA de los términos. La unión trae de más a propósito — ordenar por
 * cuántos términos calzan se encarga de que lo específico quede arriba.
 */
export function catalogFilter(terms: string[]): string {
  return terms.map((term) => `search_text.ilike.${pgrstLiteral(`%${term}%`)}`).join(",");
}

/**
 * Ordena por cuántos términos calza cada producto, de más a menos.
 *
 * Con "bujía NGK" el producto que calza las dos palabras tiene que quedar
 * por encima de los que solo calzan una, porque al modelo le llegan los
 * primeros diez y nada más.
 */
export function rankByTerms<T extends { search_text: string | null }>(rows: T[], terms: string[]): T[] {
  const score = (row: T) => {
    const texto = row.search_text ?? "";
    return terms.filter((term) => texto.includes(term)).length;
  };

  return [...rows].sort((a, b) => score(b) - score(a));
}
