import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchActiveCatalogLinks } from "@/lib/data";

// ---------------------------------------------------------------------------
// T7, plan "Nada sin leer, un solo catálogo y la factura Saint" (19/9/2026).
// `fetchActiveCatalogLinks` promete "nunca lanza" (mismo criterio que
// `fetchBusinessHours`): un enlace de catálogo es un dato de conveniencia que
// no debe tumbar un turno de IA ni dejar la bandeja sin abrir. Hasta esta
// tarea el `try/catch` solo cubría el `error` que devuelve Supabase, no una
// EXCEPCIÓN de verdad (p. ej. `fetch failed` de red) — este archivo prueba
// las dos vías por separado, más el caso feliz (mapeo de snake_case a
// camelCase, en el orden que ya trajo la consulta).
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  key: string;
  label: string;
  url: string;
  sort_order: number;
  is_active: boolean;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

function createFakeSupabase(
  result: { data: FakeRow[] | null; error: unknown } | { throw: unknown }
) {
  const calls: { eq?: [string, unknown]; order?: string } = {};

  const client = {
    from(table: string) {
      if (table !== "catalog_links") throw new Error(`tabla inesperada: ${table}`);
      return {
        select() {
          return {
            eq(column: string, value: unknown) {
              calls.eq = [column, value];
              return {
                order(column2: string) {
                  calls.order = column2;
                  if ("throw" in result) throw result.throw;
                  return Promise.resolve(result);
                },
              };
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("fetchActiveCatalogLinks", () => {
  it("ante un error devuelto por Supabase, cae a [] sin lanzar", async () => {
    const { client, calls } = createFakeSupabase({
      data: null,
      error: { message: "permission denied" },
    });

    const result = await fetchActiveCatalogLinks(client);

    expect(result).toEqual([]);
    // Sigue pidiendo solo los activos, en orden: el fallback no cambia la
    // forma de la consulta.
    expect(calls.eq).toEqual(["is_active", true]);
    expect(calls.order).toBe("sort_order");
  });

  it("ante una EXCEPCIÓN de verdad (p. ej. fetch failed de red), también cae a [] sin lanzar", async () => {
    const { client } = createFakeSupabase({ throw: new TypeError("fetch failed") });

    // Antes de T7 esto se colaba entero: el `try/catch` solo envolvía el
    // `{data, error}` que Supabase devuelve, no una excepción lanzada antes
    // de llegar a esa forma. Este caso es la mutación de verificación: sin
    // el `try/catch` que envuelve la consulta entera, `await` relanza y el
    // test queda rojo.
    await expect(fetchActiveCatalogLinks(client)).resolves.toEqual([]);
  });

  it("con éxito, mapea cada fila de snake_case a camelCase y conserva el orden que trajo la consulta", async () => {
    const rows: FakeRow[] = [
      {
        id: "link-1",
        key: "cascos",
        label: "Cascos",
        url: "https://drive.google.com/file/d/abc",
        sort_order: 1,
        is_active: true,
        updated_by: "agent-1",
        created_at: "2026-09-01T10:00:00Z",
        updated_at: "2026-09-10T10:00:00Z",
      },
      {
        id: "link-2",
        key: "ubicacion",
        label: "Ubicación",
        url: "https://maps.app.goo.gl/xyz",
        sort_order: 99,
        is_active: true,
        updated_by: null,
        created_at: "2026-09-02T10:00:00Z",
        updated_at: "2026-09-02T10:00:00Z",
      },
    ];
    const { client } = createFakeSupabase({ data: rows, error: null });

    const result = await fetchActiveCatalogLinks(client);

    expect(result).toEqual([
      {
        id: "link-1",
        key: "cascos",
        label: "Cascos",
        url: "https://drive.google.com/file/d/abc",
        sortOrder: 1,
        isActive: true,
        updatedBy: "agent-1",
        createdAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-10T10:00:00Z",
      },
      {
        id: "link-2",
        key: "ubicacion",
        label: "Ubicación",
        url: "https://maps.app.goo.gl/xyz",
        sortOrder: 99,
        isActive: true,
        updatedBy: null,
        createdAt: "2026-09-02T10:00:00Z",
        updatedAt: "2026-09-02T10:00:00Z",
      },
    ]);
  });
});
