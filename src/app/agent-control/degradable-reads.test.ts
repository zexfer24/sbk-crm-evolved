import { describe, expect, it, vi } from "vitest";
import { readListIfTableExists } from "./degradable-reads";

// Corrección post-revisión (code-review high, 19/9/2026, hallazgo 6 sobre
// T7): la versión vieja de esta función (`readOptionalList`) tragaba
// CUALQUIER error — un timeout o un 5xx transitorio al leer `catalog_links`
// pintaba el panel vacío como si de verdad no hubiera catálogos, y
// CLAUDE.md es explícito: "`null` pinta —, nunca un cero que parezca
// verdad". Ahora solo se degrada a `[]` cuando el error dice, de forma
// verificable, que la tabla no existe todavía (42P01 de Postgres o
// PGRST205 de PostgREST, los dos códigos que deja una base sin la
// migración que crea `ai_lessons`/`catalog_links`); cualquier otro error
// se relanza para que lo atrape `error.tsx` con su botón Reintentar.
function postgrestError(code: string, message: string) {
  // Forma real de `PostgrestError` (`@supabase/postgrest-js`): extiende
  // `Error` y siempre trae `code`/`details`/`hint` como string.
  const error = new Error(message) as Error & { code: string; details: string; hint: string };
  error.name = "PostgrestError";
  error.code = code;
  error.details = "";
  error.hint = "";
  return error;
}

describe("readListIfTableExists", () => {
  it("devuelve la lista cuando la lectura resuelve bien", async () => {
    const result = await readListIfTableExists(Promise.resolve([{ id: "1" }]), "las lecciones de la IA");
    expect(result).toEqual([{ id: "1" }]);
  });

  it("cae a la lista vacía y avisa por consola si Postgres dice 42P01 (tabla inexistente)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = postgrestError("42P01", 'relation "ai_lessons" does not exist');

    const result = await readListIfTableExists(Promise.reject(error), "las lecciones de la IA");

    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("las lecciones de la IA");
    expect(spy.mock.calls[0][1]).toBe(error);

    spy.mockRestore();
  });

  it("cae a la lista vacía si PostgREST dice PGRST205 (tabla fuera del caché de esquema)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = postgrestError("PGRST205", 'Could not find the table "public.catalog_links" in the schema cache');

    const result = await readListIfTableExists(Promise.reject(error), "los enlaces de catálogo");

    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  /**
   * T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026):
   * `fetchTurnCallsByPhase` (data.ts) llama a la RPC `agent_turn_calls_by_phase`
   * (migración 20260921040000) -- una función que falta da PGRST202, no
   * PGRST205 (ese es para tablas). Mismo criterio, mismo destino: lista
   * vacía en vez de tumbar el panel entero.
   */
  it("cae a la lista vacía si PostgREST dice PGRST202 (función RPC fuera del caché de esquema)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = postgrestError(
      "PGRST202",
      "Could not find the function public.agent_turn_calls_by_phase(days) in the schema cache"
    );

    const result = await readListIfTableExists(Promise.reject(error), "las llamadas por fase");

    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it("RELANZA un error genérico (timeout, 5xx, corte de red) en vez de fingir una lista vacía", async () => {
    const error = postgrestError("57014", "canceling statement due to statement timeout");

    await expect(readListIfTableExists(Promise.reject(error), "las lecciones de la IA")).rejects.toBe(error);
  });

  it("RELANZA una excepción sin `code` (p. ej. `fetch failed` de red, antes de llegar a Postgrest)", async () => {
    const error = new Error("fetch failed");

    await expect(readListIfTableExists(Promise.reject(error), "las lecciones de la IA")).rejects.toBe(error);
  });

  it("no deja que un error de tabla inexistente se filtre hacia el Promise.all que la llama", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Simula el caso que motiva T7: 17 lecturas sanas más 2 opcionales, una
    // de ellas rota con 42P01 — el Promise.all entero tiene que resolver,
    // no rechazar.
    const resultado = await Promise.all([
      Promise.resolve(["ok-1"]),
      readListIfTableExists<string>(
        Promise.reject(postgrestError("42P01", 'relation "catalog_links" does not exist')),
        "los enlaces de catálogo"
      ),
      Promise.resolve(["ok-2"]),
    ]);

    expect(resultado).toEqual([["ok-1"], [], ["ok-2"]]);

    spy.mockRestore();
  });

  it("un error genérico dentro del Promise.all SÍ lo hace rechazar (no hay degradación silenciosa)", async () => {
    const error = postgrestError("53300", "too many connections for role");

    await expect(
      Promise.all([
        Promise.resolve(["ok-1"]),
        readListIfTableExists<string>(Promise.reject(error), "los enlaces de catálogo"),
      ])
    ).rejects.toBe(error);
  });
});
