import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchProductsPage, searchActiveProducts, searchProductsForLookup } from "@/lib/inventory-data";

/**
 * Fake del query builder de PostgREST que REGISTRA operador, columna y valor
 * de cada llamada — no solo si se llamó, sino con qué. Trampa del 20/9/2026
 * (CLAUDE.md, "El resguardo antes del push"): un fake que se traga el
 * argumento de un filtro no prueba nada; una mutación que cambiara la
 * columna o el operador seguiría en verde.
 */
function fakeProductsQuery(result: { data?: unknown[]; error?: unknown; count?: number | null } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const resolved = {
    data: result.data ?? [],
    error: result.error ?? null,
    count: result.count ?? null,
  };

  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };

  const terminate =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(resolved);
    };

  const builder: Record<string, unknown> = {
    select: record("select"),
    or: record("or"),
    eq: record("eq"),
    lte: record("lte"),
    gt: record("gt"),
    is: record("is"),
    order: record("order"),
    range: terminate("range"),
    limit: terminate("limit"),
  };

  return { calls, builder };
}

function fakeSupabase(builder: unknown): SupabaseClient {
  return { from: vi.fn(() => builder) } as unknown as SupabaseClient;
}

function orValues(calls: { method: string; args: unknown[] }[]): string[] {
  return calls.filter((c) => c.method === "or").map((c) => c.args[0] as string);
}

describe("fetchProductsPage — filtro de búsqueda por palabras", () => {
  it("'tubo cg' arma UN solo .or(), con and(or(...),or(...)) para las dos palabras", async () => {
    const { calls, builder } = fakeProductsQuery();
    await fetchProductsPage(fakeSupabase(builder), { query: "tubo cg", filter: "todos", sort: "nombre", page: 1 });

    // Hallazgo 2 (`code-review high`, 27/9/2026): ya NO son dos `.or()`
    // encadenados (PostgREST no garantiza combinarlos con AND detrás de un
    // proxy) — es UNA sola llamada con la expresión completa.
    expect(orValues(calls)).toEqual([
      'and(or(search_text.ilike."%tubo%",saint_code.ilike."%tubo%",description.ilike."%tubo%"),' +
        'or(search_text.ilike."%cg%",saint_code.ilike."%cg%",description.ilike."%cg%"))',
    ]);
  });

  it("una query vacía no agrega ningún .or()", async () => {
    const { calls, builder } = fakeProductsQuery();
    await fetchProductsPage(fakeSupabase(builder), { query: "", filter: "todos", sort: "nombre", page: 1 });

    expect(orValues(calls)).toEqual([]);
  });

  it("un código con guion viaja entero, sin partirse en dos filtros", async () => {
    const { calls, builder } = fakeProductsQuery();
    await fetchProductsPage(fakeSupabase(builder), {
      query: "test-cg150",
      filter: "todos",
      sort: "nombre",
      page: 1,
    });

    const or = orValues(calls);
    expect(or).toHaveLength(1);
    expect(or[0]).toContain("%test-cg150%");
  });

  it("coma y paréntesis en la búsqueda no rompen el .or()", async () => {
    const { calls, builder } = fakeProductsQuery();
    await fetchProductsPage(fakeSupabase(builder), {
      query: "tubo(cg),raro",
      filter: "todos",
      sort: "nombre",
      page: 1,
    });

    // No lanza y arma exactamente un filtro (una sola "palabra" sin espacios).
    expect(orValues(calls)).toHaveLength(1);
  });

  it("los filtros de estado siguen aplicándose junto con la búsqueda (eq real, no solo llamado)", async () => {
    const { calls, builder } = fakeProductsQuery();
    await fetchProductsPage(fakeSupabase(builder), {
      query: "cg",
      filter: "agotados",
      sort: "nombre",
      page: 1,
    });

    const eq = calls.find((c) => c.method === "eq");
    expect(eq?.args).toEqual(["is_active", true]);
  });
});

describe("searchActiveProducts — buscador del cierre de venta", () => {
  it("busca por palabra en las tres columnas y solo activos", async () => {
    const { calls, builder } = fakeProductsQuery();
    await searchActiveProducts(fakeSupabase(builder), "tubo cg");

    expect(orValues(calls)).toEqual([
      'and(or(search_text.ilike."%tubo%",saint_code.ilike."%tubo%",description.ilike."%tubo%"),' +
        'or(search_text.ilike."%cg%",saint_code.ilike."%cg%",description.ilike."%cg%"))',
    ]);
    const eq = calls.find((c) => c.method === "eq");
    expect(eq?.args).toEqual(["is_active", true]);
  });

  it("un código encuentra su producto sin que la palabra completa esté en el nombre", async () => {
    const { calls, builder } = fakeProductsQuery();
    await searchActiveProducts(fakeSupabase(builder), "test-cg150");

    expect(orValues(calls)).toEqual([
      'search_text.ilike."%test-cg150%",saint_code.ilike."%test-cg150%",description.ilike."%test-cg150%"',
    ]);
  });

  it("query vacía no consulta nada y devuelve una lista vacía", async () => {
    const { calls, builder } = fakeProductsQuery();
    const result = await searchActiveProducts(fakeSupabase(builder), "   ");

    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("searchProductsForLookup — panel del buzón (T6 la va a usar)", () => {
  it("NO filtra por is_active y ordena activos primero, luego por nombre", async () => {
    const { calls, builder } = fakeProductsQuery();
    await searchProductsForLookup(fakeSupabase(builder), "cg");

    expect(calls.find((c) => c.method === "eq" && c.args[0] === "is_active")).toBeUndefined();

    const order = calls.filter((c) => c.method === "order");
    expect(order).toEqual([
      { method: "order", args: ["is_active", { ascending: false }] },
      { method: "order", args: ["name", { ascending: true }] },
    ]);
  });

  it("respeta el límite pasado (por defecto 8)", async () => {
    const { calls, builder } = fakeProductsQuery();
    await searchProductsForLookup(fakeSupabase(builder), "cg");
    expect(calls.find((c) => c.method === "limit")?.args).toEqual([8]);

    const { calls: calls2, builder: builder2 } = fakeProductsQuery();
    await searchProductsForLookup(fakeSupabase(builder2), "cg", 3);
    expect(calls2.find((c) => c.method === "limit")?.args).toEqual([3]);
  });

  it("query vacía no consulta nada y devuelve una lista vacía", async () => {
    const { calls, builder } = fakeProductsQuery();
    const result = await searchProductsForLookup(fakeSupabase(builder), "");

    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });
});
