/**
 * T7 del plan "Seba sale sin pisar a nadie" (19/9/2026, hallazgo A4): las
 * ~19 lecturas de Control IA viajan en un solo `Promise.all`
 * (`agent-control/page.tsx`); `fetchLessons` y `fetchCatalogLinks` — las
 * tablas más nuevas del panel, `ai_lessons`/`catalog_links` — LANZAN si esa
 * tabla todavía no existe en la base de destino. Sin este envoltorio, esa
 * única falla tumbaba las otras diecisiete lecturas junto con el
 * interruptor global de la IA, que un `error.tsx` por sí solo no vuelve a
 * dejar al alcance (la pantalla entera queda reemplazada por el boundary de
 * error). Mismo criterio que `fetchActiveCatalogLinks`/`fetchBusinessHours`
 * en `src/lib/data.ts`: una lectura OPCIONAL que falla cae a la lista vacía
 * y avisa por consola, nunca tumba a quien la pidió.
 *
 * Vive en un archivo propio (no dentro de `page.tsx`) para poder probarla
 * sola: `page.tsx` es un Server Component que arrastra `@/lib/supabase/server`
 * (usa `next/headers`) y el módulo pesado `@/lib/data`, así que importarlo
 * de punta a punta en un test unitario sería probar de más para verificar
 * algo que no depende de ninguno de los dos.
 *
 * Corrección post-revisión (code-review high, 19/9/2026, hallazgo 6): la
 * primera versión (`readOptionalList`) tragaba CUALQUIER error, sin mirar
 * cuál. Un timeout o un 5xx transitorio al leer `catalog_links` pintaba el
 * panel vacío como si de verdad no hubiera ningún catálogo — el supervisor
 * lo lee como "se borraron" y los recrea a mano, justo lo que CLAUDE.md
 * prohíbe ("`null` pinta —, nunca un cero que parezca verdad", trampa de
 * `agent_day_summary`). Ahora SOLO se degrada a `[]` cuando el error dice,
 * de forma verificable por código, que la tabla todavía no existe: `42P01`
 * es el código de Postgres para `undefined_table` (la consulta sí llegó a
 * la base) y `PGRST205` es el código propio de PostgREST para "no encontré
 * esa relación en el caché de esquema" (lo que pasa cuando la migración
 * corrió pero nadie avisó con `notify pgrst, 'reload schema'` — T5 de este
 * mismo plan). Cualquier otro error —timeout, 5xx, corte de red, permisos—
 * se RELANZA: lo atrapa `error.tsx` con su botón Reintentar, en vez de
 * fingir que el panel está vacío.
 */
const TABLA_INEXISTENTE = new Set(["42P01", "PGRST205"]);

/**
 * `PostgrestError` (`@supabase/postgrest-js`) siempre trae `code` como
 * string, pero una excepción de RED (`fetch failed`, antes de que la
 * librería llegue a construir ese objeto) no lo trae — por eso el chequeo
 * es defensivo y no asume la forma del error.
 */
function esTablaInexistente(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && TABLA_INEXISTENTE.has(code);
}

export async function readListIfTableExists<T>(promise: Promise<T[]>, etiqueta: string): Promise<T[]> {
  try {
    return await promise;
  } catch (error) {
    if (esTablaInexistente(error)) {
      console.error(`No se pudo leer ${etiqueta} (la tabla no existe todavía), Control IA sigue sin ella:`, error);
      return [];
    }
    // Cualquier otro error (timeout, 5xx, corte de red, permisos) se
    // relanza: degradarlo también habría escondido justo lo que el
    // hallazgo 6 vino a corregir.
    throw error;
  }
}
