import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PRODUCT_SELECT,
  fetchInventoryTotals,
  fetchProductsByIds,
  fetchProductsPage,
  searchActiveProducts,
  searchProductsForLookup,
} from "@/lib/inventory-data";

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
    in: terminate("in"),
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

describe("fetchProductsPage — orden (T4, 13/10/2026)", () => {
  function ordenes(calls: { method: string; args: unknown[] }[]) {
    return calls.filter((c) => c.method === "order").map((c) => c.args);
  }

  it("«Sin peso» sin orden explícito pide primero lo que más hay: stock_quantity descendente, nombre y id de desempate", async () => {
    const { calls, builder } = fakeProductsQuery();
    // `sort: "existencia"` es lo que `parseInventoryParams` produce para sin-peso sin `orden` en la URL.
    await fetchProductsPage(fakeSupabase(builder), { query: "", filter: "sin-peso", sort: "existencia", page: 1 });

    expect(ordenes(calls)).toEqual([
      ["stock_quantity", { ascending: false }],
      ["name", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("«Sin peso» con orden=nombre explícito ordena por nombre, no por existencia", async () => {
    const { calls, builder } = fakeProductsQuery();
    await fetchProductsPage(fakeSupabase(builder), { query: "", filter: "sin-peso", sort: "nombre", page: 1 });

    expect(ordenes(calls)).toEqual([["name", { ascending: true }]]);
  });

  it("los órdenes de siempre no cambian: stock ascendente y precio descendente", async () => {
    const stock = fakeProductsQuery();
    await fetchProductsPage(fakeSupabase(stock.builder), { query: "", filter: "todos", sort: "stock", page: 1 });
    expect(ordenes(stock.calls)).toEqual([["stock_quantity", { ascending: true }]]);

    const precio = fakeProductsQuery();
    await fetchProductsPage(fakeSupabase(precio.builder), { query: "", filter: "todos", sort: "precio", page: 1 });
    expect(ordenes(precio.calls)).toEqual([["price", { ascending: false }]]);
  });
});

describe("fetchProductsPage — página fuera de rango (13/10/2026)", () => {
  /**
   * Fake aparte: la primera consulta (con `.range`) falla con PGRST103 y la
   * de reconteo (`head: true`) devuelve el total. Registra todo lo que se le
   * aplica a cada una para comprobar que lleva los MISMOS filtros.
   */
  function fakeFueraDeRango(total: number, error: unknown = { code: "PGRST103", message: "Requested range not satisfiable" }) {
    const consultas: { calls: { method: string; args: unknown[] }[] }[] = [];

    function nuevaConsulta() {
      const calls: { method: string; args: unknown[] }[] = [];
      consultas.push({ calls });
      const chain = (method: string) => (...args: unknown[]) => {
        calls.push({ method, args });
        return builder;
      };
      const builder: Record<string, unknown> = {
        select: chain("select"),
        or: chain("or"),
        eq: chain("eq"),
        lte: chain("lte"),
        gt: chain("gt"),
        order: chain("order"),
        range: (...args: unknown[]) => {
          calls.push({ method: "range", args });
          return Promise.resolve({ data: null, error, count: null });
        },
        // El reconteo no lleva range: se resuelve al esperar el builder.
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null, count: total }),
      };
      return builder;
    }

    return { consultas, supabase: { from: vi.fn(() => nuevaConsulta()) } as unknown as SupabaseClient };
  }

  it("devuelve products vacío y el total real en vez de lanzar", async () => {
    const { supabase } = fakeFueraDeRango(61);
    const result = await fetchProductsPage(supabase, { query: "", filter: "todos", sort: "nombre", page: 99 });

    expect(result).toEqual({ products: [], total: 61 });
  });

  it("reconta con head:true, count exact y los MISMOS filtros", async () => {
    const { consultas, supabase } = fakeFueraDeRango(5);
    await fetchProductsPage(supabase, { query: "tubo cg", filter: "agotados", sort: "stock", page: 99 });

    expect(consultas).toHaveLength(2);
    const [primera, reconteo] = consultas;
    expect(reconteo.calls.find((c) => c.method === "select")?.args[1]).toEqual({ count: "exact", head: true });
    expect(reconteo.calls.some((c) => c.method === "range")).toBe(false);

    const filtros = (c: { calls: { method: string; args: unknown[] }[] }) =>
      c.calls.filter((x) => ["or", "eq", "lte", "gt"].includes(x.method));
    expect(filtros(reconteo)).toEqual(filtros(primera));
    expect(filtros(reconteo).length).toBeGreaterThan(0);
  });

  it("también reconoce el status 416", async () => {
    const { supabase } = fakeFueraDeRango(3, { status: 416, message: "x" });
    const result = await fetchProductsPage(supabase, { query: "", filter: "todos", sort: "nombre", page: 9 });

    expect(result).toEqual({ products: [], total: 3 });
  });

  it("cualquier otro error sigue lanzando tal cual", async () => {
    const boom = { code: "42501", message: "permission denied" };
    const { supabase } = fakeFueraDeRango(0, boom);

    await expect(
      fetchProductsPage(supabase, { query: "", filter: "todos", sort: "nombre", page: 1 })
    ).rejects.toBe(boom);
  });

  it("si el reconteo también falla, lanza ese error", async () => {
    const boom = { code: "XX000", message: "caída" };
    const consultas: unknown[] = [];
    const supabase = {
      from: vi.fn(() => {
        const primera = consultas.length === 0;
        consultas.push(1);
        const builder: Record<string, unknown> = {
          select: () => builder,
          order: () => builder,
          range: () =>
            Promise.resolve({ data: null, error: { code: "PGRST103", message: "r" }, count: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: primera ? null : boom, count: null }),
        };
        return builder;
      }),
    } as unknown as SupabaseClient;

    await expect(
      fetchProductsPage(supabase, { query: "", filter: "todos", sort: "nombre", page: 99 })
    ).rejects.toBe(boom);
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

  it("ordena por mayor existencia (nulos al final), luego nombre y luego id", async () => {
    const { calls, builder } = fakeProductsQuery();
    await searchActiveProducts(fakeSupabase(builder), "cg");

    const order = calls.filter((c) => c.method === "order");
    expect(order.map((c) => c.args)).toEqual([
      ["stock_quantity", { ascending: false, nullsFirst: false }],
      ["name", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("pagina de a 30: range(0, 29) por defecto y range(30, 59) con offset 30", async () => {
    const first = fakeProductsQuery();
    await searchActiveProducts(fakeSupabase(first.builder), "cg");
    expect(first.calls.find((c) => c.method === "range")?.args).toEqual([0, 29]);
    expect(first.calls.find((c) => c.method === "limit")).toBeUndefined();

    const second = fakeProductsQuery();
    await searchActiveProducts(fakeSupabase(second.builder), "cg", 30, 30);
    expect(second.calls.find((c) => c.method === "range")?.args).toEqual([30, 59]);
  });

  it("query vacía no consulta nada y devuelve una lista vacía", async () => {
    const { calls, builder } = fakeProductsQuery();
    const result = await searchActiveProducts(fakeSupabase(builder), "   ");

    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("searchProductsForLookup — panel del buzón (T6 la va a usar)", () => {
  it("NO filtra por is_active y ordena activos primero, luego por mayor existencia y por nombre", async () => {
    const { calls, builder } = fakeProductsQuery();
    await searchProductsForLookup(fakeSupabase(builder), "cg");

    expect(calls.find((c) => c.method === "eq" && c.args[0] === "is_active")).toBeUndefined();

    const order = calls.filter((c) => c.method === "order");
    // T9 (29/9/2026): el desempate por `id` hace estable la paginación con
    // `range()` — dos repuestos con el mismo nombre no pueden saltar de una
    // página a otra ni repetirse entre ellas.
    // T3 (30/9/2026, plan "Ronda del cliente"): entre `is_active` y `name` va
    // la existencia de mayor a menor; `nullsFirst: false` manda los `null`
    // (Postgres los pone primero en un orden descendente) al final.
    expect(order).toEqual([
      { method: "order", args: ["is_active", { ascending: false }] },
      { method: "order", args: ["stock_quantity", { ascending: false, nullsFirst: false }] },
      { method: "order", args: ["name", { ascending: true }] },
      { method: "order", args: ["id", { ascending: true }] },
    ]);
  });

  it("pagina con range(): por defecto la primera página de 20", async () => {
    const { calls, builder } = fakeProductsQuery();
    await searchProductsForLookup(fakeSupabase(builder), "cg");

    expect(calls.find((c) => c.method === "range")?.args).toEqual([0, 19]);
    expect(calls.find((c) => c.method === "limit")).toBeUndefined();
  });

  it("respeta el tamaño de página y el desplazamiento pasados", async () => {
    const { calls, builder } = fakeProductsQuery();
    await searchProductsForLookup(fakeSupabase(builder), "cg", 3);
    expect(calls.find((c) => c.method === "range")?.args).toEqual([0, 2]);

    const { calls: calls2, builder: builder2 } = fakeProductsQuery();
    await searchProductsForLookup(fakeSupabase(builder2), "cg", 20, 40);
    expect(calls2.find((c) => c.method === "range")?.args).toEqual([40, 59]);
  });

  it("query vacía no consulta nada y devuelve una lista vacía", async () => {
    const { calls, builder } = fakeProductsQuery();
    const result = await searchProductsForLookup(fakeSupabase(builder), "");

    expect(result).toEqual([]);
    expect(calls).toEqual([]);
  });
});

/**
 * Fila cruda con la forma de PostgREST para `PRODUCT_SELECT` (los nombres de
 * columna en snake_case). Sirve para probar que `fetchProductsByIds` pasa
 * cada fila por `mapProduct`, no solo que devuelve algo.
 */
function rawProductRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    name: "PASTILLA FRENO DELANTERA",
    brand: null,
    price: "12.5",
    currency: "USD",
    stock_quantity: 7,
    description: null,
    is_active: true,
    updated_at: "2026-10-12T10:00:00Z",
    weight_kg: null,
    saint_code: "PF-01",
    saint_added_at: null,
    saint_removed_at: null,
    product_compatibility: [],
    ...overrides,
  };
}

describe("fetchProductsByIds — restaurar el carrito del Inventario (12/10/2026)", () => {
  it("ids vacío devuelve [] y no toca supabase", async () => {
    const { calls, builder } = fakeProductsQuery();
    const supabase = fakeSupabase(builder);
    const result = await fetchProductsByIds(supabase, []);

    expect(result).toEqual([]);
    expect(calls).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("deduplica los ids y consulta con .in('id', ...) por los únicos, en orden de llegada", async () => {
    const { calls, builder } = fakeProductsQuery();
    await fetchProductsByIds(fakeSupabase(builder), ["a", "b", "a"]);

    expect(calls.filter((c) => c.method === "in")).toEqual([{ method: "in", args: ["id", ["a", "b"]] }]);
    expect(calls.find((c) => c.method === "select")?.args[0]).toBe(PRODUCT_SELECT);
  });

  it("mapea cada fila a Product (stock_quantity → stockQuantity, price → número)", async () => {
    const { builder } = fakeProductsQuery({ data: [rawProductRow()] });
    const result = await fetchProductsByIds(fakeSupabase(builder), ["p-1"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "p-1",
      name: "PASTILLA FRENO DELANTERA",
      price: 12.5,
      currency: "USD",
      stockQuantity: 7,
      saintCode: "PF-01",
      compatibility: [],
    });
    expect(result[0]).not.toHaveProperty("stock_quantity");
  });

  it("lanza el error de supabase tal cual", async () => {
    const boom = { message: "permission denied", code: "42501" };
    const { builder } = fakeProductsQuery({ error: boom });

    await expect(fetchProductsByIds(fakeSupabase(builder), ["p-1"])).rejects.toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// 30/10/2026 (plan «Cada repuesto con su foto», T2)
// ---------------------------------------------------------------------------

describe("fetchProductsPage — filtro «Sin foto» (anti-join de PostgREST)", () => {
  // OJO: este test prueba la CONSULTA que se arma (alias en el select + `.is`),
  // no que PostgREST la entienda. `sin_foto:product_photos!left(id)` + `is.null`
  // es el anti-join documentado, pero hay que comprobarlo contra un PostgREST
  // real con la tabla creada por T1 antes de fusionar.
  it("con filter «sin-foto» el select suma el alias sin_foto:product_photos!left(id) y se aplica is('sin_foto', null)", async () => {
    const { calls, builder } = fakeProductsQuery();
    await fetchProductsPage(fakeSupabase(builder), { query: "", filter: "sin-foto", sort: "nombre", page: 1 });

    const select = calls.find((c) => c.method === "select");
    expect(select?.args[0]).toContain("sin_foto:product_photos!left(id)");
    // El resto del select de siempre sigue ahí.
    expect(select?.args[0]).toContain("product_photos(id, storage_path, is_primary, position)");
    expect(calls.filter((c) => c.method === "is")).toEqual([{ method: "is", args: ["sin_foto", null] }]);
  });

  // Corrección del orquestador (30/10/2026): «Sin foto» sirve para saber a qué
  // repuesto le falta foto; uno que Saint dio de baja no importa. Igual que «Sin peso».
  it("«Sin foto» lista solo repuestos activos: eq('is_active', true) además del anti-join", async () => {
    const { calls, builder } = fakeProductsQuery();
    await fetchProductsPage(fakeSupabase(builder), { query: "", filter: "sin-foto", sort: "nombre", page: 1 });

    expect(calls.filter((c) => c.method === "eq")).toEqual([{ method: "eq", args: ["is_active", true] }]);
  });

  it("con cualquier otro filtro NO aparece el alias ni el .is()", async () => {
    for (const filter of ["todos", "agotados", "bajo-stock", "inactivos", "sin-peso"] as const) {
      const { calls, builder } = fakeProductsQuery();
      await fetchProductsPage(fakeSupabase(builder), { query: "", filter, sort: "nombre", page: 1 });

      const select = calls.find((c) => c.method === "select");
      expect(select?.args[0], filter).not.toContain("sin_foto");
      expect(
        calls.some((c) => c.method === "is"),
        filter
      ).toBe(false);
    }
  });

  it("el reconteo de una página fuera de rango también lleva el anti-join (misma fuente de filtros)", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "or", "eq", "lte", "gt", "is", "order"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ method: m, args });
        return builder;
      };
    }
    builder.range = () => Promise.resolve({ data: null, error: { code: "PGRST103" }, count: null });
    // El reconteo (head) no pasa por `range`: se espera directamente el builder.
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null, count: 3 });

    const resultado = await fetchProductsPage(fakeSupabase(builder), {
      query: "",
      filter: "sin-foto",
      sort: "nombre",
      page: 99,
    });

    expect(resultado).toEqual({ products: [], total: 3 });
    const selects = calls.filter((c) => c.method === "select");
    expect(selects).toHaveLength(2);
    // El reconteo necesita el alias: sin él, `.is("sin_foto", null)` apuntaría a un embed que no existe.
    expect(selects[1].args[0]).toBe("id, sin_foto:product_photos!left(id)");
    expect(calls.filter((c) => c.method === "is")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "eq")).toEqual([
      { method: "eq", args: ["is_active", true] },
      { method: "eq", args: ["is_active", true] },
    ]);
  });
});

describe("fetchProductsPage — «Bajo stock» usa el umbral de 5", () => {
  it("lte('stock_quantity', 5) y gt('stock_quantity', 0), con literales", async () => {
    const { calls, builder } = fakeProductsQuery();
    await fetchProductsPage(fakeSupabase(builder), { query: "", filter: "bajo-stock", sort: "nombre", page: 1 });

    expect(calls.filter((c) => c.method === "lte")).toEqual([{ method: "lte", args: ["stock_quantity", 5] }]);
    expect(calls.filter((c) => c.method === "gt")).toEqual([{ method: "gt", args: ["stock_quantity", 0] }]);
  });
});

describe("fetchProductsPage — las fotos llegan en cada Product", () => {
  it("mapea product_photos a fotos ordenadas con la URL pública del bucket", async () => {
    const { builder } = fakeProductsQuery({
      data: [
        rawProductRow({
          product_photos: [
            { id: "f2", storage_path: "p-1/f2.jpg", is_primary: false, position: 1 },
            { id: "f1", storage_path: "p-1/f1.jpg", is_primary: true, position: 4 },
          ],
        }),
      ],
    });
    const supabase = {
      from: vi.fn(() => builder),
      storage: {
        from: vi.fn((bucket: string) => ({
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://sb.test/${bucket}/${path}` } }),
        })),
      },
    } as unknown as SupabaseClient;

    const { products } = await fetchProductsPage(supabase, { query: "", filter: "todos", sort: "nombre", page: 1 });

    expect(products[0].fotos.map((f) => [f.id, f.url, f.isPrimary])).toEqual([
      ["f1", "https://sb.test/product-photos/p-1/f1.jpg", true],
      ["f2", "https://sb.test/product-photos/p-1/f2.jpg", false],
    ]);
  });
});

describe("fetchInventoryTotals — conFoto", () => {
  /**
   * Fake por tabla: cada `from(tabla)` registra sus llamadas y su builder se
   * puede esperar (thenable) con el `count` de esa tabla. `products` responde 7
   * y `product_photos` 17, para que un cruce de tablas se note.
   */
  function fakeTotals(photosError: unknown = null) {
    const llamadas: { tabla: string; method: string; args: unknown[] }[] = [];
    const supabase = {
      from: (tabla: string) => {
        const resultado = {
          data: null,
          error: tabla === "product_photos" ? photosError : null,
          count: tabla === "product_photos" ? 17 : 7,
        };
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "lte", "gt", "or", "order", "limit"]) {
          b[m] = (...args: unknown[]) => {
            llamadas.push({ tabla, method: m, args });
            return b;
          };
        }
        b.maybeSingle = () => Promise.resolve({ data: { updated_at: "2026-10-30T10:00:00Z" }, error: null });
        b.then = (resolve: (v: unknown) => unknown) => resolve(resultado);
        return b;
      },
    } as unknown as SupabaseClient;
    return { supabase, llamadas };
  }

  it("conFoto es el count de product_photos con is_primary = true (una principal por repuesto)", async () => {
    const { supabase, llamadas } = fakeTotals();
    const totales = await fetchInventoryTotals(supabase);

    expect(totales.conFoto).toBe(17);
    expect(totales.productos).toBe(7);
    const deFotos = llamadas.filter((c) => c.tabla === "product_photos");
    expect(deFotos).toEqual([
      { tabla: "product_photos", method: "select", args: ["id", { count: "exact", head: true }] },
      { tabla: "product_photos", method: "eq", args: ["is_primary", true] },
    ]);
  });

  it("«Bajo stock» del contador usa lte('stock_quantity', 5)", async () => {
    const { supabase, llamadas } = fakeTotals();
    await fetchInventoryTotals(supabase);

    expect(llamadas.filter((c) => c.method === "lte" && c.args[1] === 5)).toEqual([
      { tabla: "products", method: "lte", args: ["stock_quantity", 5] },
    ]);
  });

  it("si el conteo de fotos falla, el error se propaga (no se disfraza de cero)", async () => {
    const { supabase } = fakeTotals({ message: "boom" });
    await expect(fetchInventoryTotals(supabase)).rejects.toEqual({ message: "boom" });
  });
});
