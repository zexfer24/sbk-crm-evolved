// ---------------------------------------------------------------------------
// Guardados que la RLS puede ignorar sin avisar (T7, plan "Seba encuentra, no
// insiste, y el mostrador no deja a nadie esperando", 28/9/2026).
//
// Bajo RLS, un UPDATE/DELETE que la política no deja pasar NO da error:
// afecta 0 filas y PostgREST responde 200/204. `const { error } = await
// ...update()` daba entonces por bueno un guardado que no cambió nada, y el
// panel mostraba "guardado" con la base intacta (probado contra la base
// local, `supabase/tests/config_solo_supervisor.sql`). Cada mutación de
// configuración de `mutations.ts` pide las filas afectadas con
// `.select(...)` y pasa el resultado por `assertRowsAffected`. El INSERT no
// lo necesita: una política de INSERT que rechaza SÍ lanza 42501.
//
// Vive en su propio módulo, sin importar nada, para que los paneles puedan
// leer el mensaje del error (`configErrorMessage`) sin arrastrar
// `mutations.ts` (y su grafo de Supabase) a sus tests.
// ---------------------------------------------------------------------------

export const CONFIG_WRITE_DENIED_MESSAGE = "Solo un supervisor o administrador puede cambiar esto.";

/** Donde la regla no es "supervisor o administrador" sino "el autor o un supervisor" (RLS `ai_lessons_*`, `notes_*`, `stickers_delete`). */
export const ONLY_AUTHOR_LESSON_MESSAGE = "Solo el autor de la lección o un supervisor puede cambiar esto.";
export const ONLY_AUTHOR_NOTE_MESSAGE = "Solo el autor de la nota o un supervisor puede cambiar esto.";
export const ONLY_AUTHOR_STICKER_MESSAGE = "Solo quien subió el sticker o un supervisor puede borrarlo.";

/** La escritura llegó a la base y no cambió nada: casi siempre, la RLS la ignoró. */
export class ConfigWriteDeniedError extends Error {
  name = "ConfigWriteDeniedError";
}

/**
 * Lanza si el UPDATE/DELETE/UPSERT no devolvió ninguna fila. `data` viene del
 * `.select(...)` encadenado; `null`/vacío es "0 filas afectadas". `message`
 * cambia solo donde la regla no es "supervisor o administrador" (autor de la
 * lección, de la nota o del sticker).
 */
export function assertRowsAffected(
  data: readonly unknown[] | null | undefined,
  message: string = CONFIG_WRITE_DENIED_MESSAGE
): void {
  if (!data || data.length === 0) throw new ConfigWriteDeniedError(message);
}

/**
 * Texto para el toast de un guardado que falló. Si la base ignoró la
 * escritura por permisos, el mensaje del error ya dice quién puede hacerlo y
 * es el que tiene que verse; cualquier otro error (red, constraint) conserva
 * el texto genérico del panel.
 */
export function configErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ConfigWriteDeniedError ? error.message : fallback;
}
