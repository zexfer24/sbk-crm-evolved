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

// ---------------------------------------------------------------------------
// Sinónimos de búsqueda — T5c, plan "Seba atiende el mostrador" (18/9/2026,
// requisito 7 del cliente, decisión P3): un asesor le enseña a Seba que
// "pastilla" (jerga que usa el cliente) también busca "pastillas de freno"
// (el nombre real en el catálogo), sin que nadie toque código.
//
// NO reutiliza `products.sinonimos_busqueda` (hallazgo 9 del plan): esa
// columna ya está ocupada por otro flujo. Los sinónimos de esta tarea viven
// en `public.ai_lessons` con `kind = 'sinonimo'` (migración 20260917020000)
// y `tools.ts` los consulta activos antes de armar el filtro del catálogo.
// ---------------------------------------------------------------------------

/** Un par jerga → término real. `isActive` es opcional (por defecto, activo). */
export interface SearchSynonym {
  from: string;
  to: string;
  isActive?: boolean;
}

/**
 * Agrega, a los términos que ya salieron de `searchTerms`, el término real de
 * cada sinónimo cuya jerga (`from`, normalizada) esté entre ellos.
 *
 * Compara en normalizado (sin acentos, minúsculas) porque `terms` ya llega
 * así. Los sinónimos con `isActive === false` se ignoran ACÁ TAMBIÉN, de
 * forma defensiva — aunque quien llama (`tools.ts`) ya filtra
 * `is_active = true` en la consulta, dos guardas independientes es el mismo
 * criterio que el resto del repo (ver CLAUDE.md, los dos revokes de una
 * función `security definer`). No duplica: el resultado sale de un `Set`.
 */
export function expandTerms(terms: string[], synonyms: SearchSynonym[]): string[] {
  const expanded = new Set(terms);

  for (const synonym of synonyms) {
    if (synonym.isActive === false) continue;
    if (!terms.includes(normalize(synonym.from))) continue;
    expanded.add(normalize(synonym.to));
  }

  return [...expanded];
}
