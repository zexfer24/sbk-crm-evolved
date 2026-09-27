import { pgrstLiteral } from "@/lib/ai/pgrst";

/**
 * Búsqueda por palabras del inventario (panel de Inventario, buscador del
 * cierre de venta y el panel del buzón).
 *
 * T3, plan "El mostrador busca sin salir del chat" (27/9/2026). Hasta esa
 * fecha `fetchProductsPage`/`searchActiveProducts` hacían UN solo
 * `ilike '%frase completa%'` contra `name`/`brand`(/`description`): "tubo cg"
 * no es subcadena de "TUBO ESCAPE CG 150", así que no calzaba nada, y el
 * código Saint (`saint_code`, desde el 25/9/2026) no entraba en el filtro en
 * absoluto — solo se hallaba un producto por su código si ese código seguía
 * copiado a mano dentro de `description`.
 *
 * La regla (D6 del plan): cada palabra de la búsqueda tiene que aparecer, en
 * cualquier orden, en `search_text` (nombre+marca ya sin acentos y en
 * minúsculas, columna generada de la migración 20260822100000, indexada con
 * trigram) o en `saint_code` o en `description`. Sin migración nueva.
 *
 * Corrección del hallazgo 2 (`code-review high` sobre d38a7e1..HEAD,
 * 27/9/2026): la primera versión de esta corrida devolvía UN `.or()` por
 * palabra y el llamador los encadenaba, confiando en que PostgREST junta los
 * parámetros `or=` repetidos con AND — `ai/pgrst.ts` ya documenta que "dos
 * `.or()` en la misma consulta no son fiables" (el orden en que
 * postgrest-js compone los parámetros repetidos no está garantizado, y
 * detrás de un proxy en producción esa combinación puede llegar distinta a
 * como se probó en local). Medido a mano contra el PostgREST local
 * (`http://127.0.0.1:55321`, detrás de Kong): "bujia ngk" y "bujia zzzz" dan
 * el resultado esperado con una única expresión `and(or(...),or(...))`
 * pasada a un SOLO `.or()`, así que `productSearchFilter` arma esa
 * expresión completa en vez de devolver un arreglo para que el llamador
 * encadene.
 *
 * A propósito NO reutiliza el pipeline de `ai/catalog-search.ts` (singular,
 * sinónimos, uniones letra+número): esa es la búsqueda de Seba, mucho más
 * fina porque el cliente escribe por WhatsApp sin poder ver una lista de
 * resultados. Acá el asesor ve la lista y puede escribir "pastillas" o
 * "pastilla" él mismo — D6 deja plurales y sinónimos fuera a propósito.
 *
 * Decisión sobre el código Saint (el plan pide documentar la asimetría):
 * `search_text` ya llega normalizado desde la base (sin acentos, en
 * minúsculas) pero `saint_code`/`description` NO. Igual se compara con la
 * MISMA palabra normalizada (sin acentos, en minúsculas) contra las tres
 * columnas: `ilike` ya es insensible a mayúsculas por su cuenta, así que
 * bajar a minúsculas del lado del cliente no cambia nada para esas dos
 * columnas; y los códigos Saint no llevan tildes, así que quitarle acentos a
 * la palabra buscada tampoco les hace daño (no hay ninguna tilde que
 * "perder" en un código como "TUBO-CG150"). El único costo real de no tener
 * una columna normalizada para `description` es el de siempre: una palabra
 * sin acento no encuentra un acento real dentro de una descripción vieja
 * escrita a mano — el mismo límite que ya tenía el filtro anterior.
 */

/** Tope de palabras que arma un filtro — una búsqueda absurdamente larga no debe convertirse en 6+ `.or()` innecesarios. */
const MAX_SEARCH_WORDS = 6;

/** Las tres columnas donde puede vivir una coincidencia, en el orden en que se arma cada `.or()`. */
const SEARCH_COLUMNS = ["search_text", "saint_code", "description"] as const;

/** Minúsculas, sin diacríticos (NFD) y con los espacios ya colapsados/recortados. */
export function normalizeProductQuery(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Parte la búsqueda ya normalizada en palabras, descarta las vacías (una
 * consulta con varios espacios seguidos no debería dejar un término hueco
 * que calce cualquier fila) y la recorta a `MAX_SEARCH_WORDS`.
 */
export function productSearchWords(query: string): string[] {
  const normalized = normalizeProductQuery(query);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter((word) => word.length > 0)
    .slice(0, MAX_SEARCH_WORDS);
}

/**
 * Arma la ÚNICA expresión que se le pasa a `.or()` de PostgREST: cada palabra
 * exige calzar en alguna de las tres columnas (`search_text`/`saint_code`/
 * `description`, cada valor ya escapado con `pgrstLiteral` — mismo escapado
 * que usa la herramienta de catálogo del agente, porque el texto lo escribe
 * una persona por teclado, con comas, paréntesis o comillas incluidos), y
 * todas las palabras tienen que calzar a la vez.
 *
 * Con una sola palabra, el resultado es esa disyunción tal cual — no hace
 * falta envolverla en `and()`, un solo elemento no necesita agrupase con
 * nada más. Con dos o más, cada palabra se envuelve en su propio `or(...)` y
 * las envolturas se juntan en un solo `and(...)`, así que la expresión
 * completa —UNA sola, para UN solo `.or()`— ya dice "todas tienen que
 * calzar, cada una en cualquiera de las tres columnas".
 *
 * Query vacía (o solo espacios) devuelve `null`: sin palabras, no hay filtro
 * que aplicar — el llamador decide qué significa eso (no filtrar en
 * absoluto, o no traer resultados, según el caso de uso).
 */
export function productSearchFilter(query: string): string | null {
  const words = productSearchWords(query);
  if (words.length === 0) return null;

  const perWord = words.map((word) => {
    const term = pgrstLiteral(`%${word}%`);
    return SEARCH_COLUMNS.map((column) => `${column}.ilike.${term}`).join(",");
  });

  if (perWord.length === 1) return perWord[0];
  return `and(${perWord.map((group) => `or(${group})`).join(",")})`;
}
