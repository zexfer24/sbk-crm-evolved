import { describe, expect, it, vi } from "vitest";
import { fetchTurnCatalogLinks } from "@/lib/ai/catalog-links";

/**
 * Corrección de la revisión `code-review high` del 19/9/2026, punto 6, sobre
 * T3 del plan "Nada sin leer, un solo catálogo y la factura Saint"
 * (18/9/2026). `fetchTurnCatalogLinks` es el envoltorio de SERVIDOR que usa
 * `agent.ts` en vez de `fetchActiveCatalogLinks` (`data.ts`, que avisa con
 * `console.error` porque también la usa el navegador): mismo patrón que
 * `fetchTurnLessons` (`lessons.ts`) — nunca lanza, y ante error deja
 * `turno_enlaces_no_legibles` en el log con `errorText`.
 */

/** Un Supabase falso mínimo: una consulta a `catalog_links` con `.select().eq("is_active", true).order("sort_order")`. */
function fakeSupabase(options: {
  rows?: Record<string, unknown>[];
  error?: { message: string } | null;
}) {
  const { rows = [], error = null } = options;

  return {
    from(table: string) {
      if (table !== "catalog_links") throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);

      return {
        select: () => ({
          eq: () => ({
            order: async () => {
              if (error) return { data: null, error };
              return { data: rows, error: null };
            },
          }),
        }),
      };
    },
  };
}

const ROW_CASCOS = {
  id: "link-1",
  key: "cascos",
  label: "Cascos",
  url: "https://drive.google.com/cascos",
  sort_order: 1,
  is_active: true,
  updated_by: null,
  created_at: "2026-09-18T00:00:00.000Z",
  updated_at: "2026-09-18T00:00:00.000Z",
};

describe("fetchTurnCatalogLinks", () => {
  it("mapea las columnas snake_case de la base a CatalogLink (camelCase)", async () => {
    const supabase = fakeSupabase({ rows: [ROW_CASCOS] });

    // @ts-expect-error -- fake mínimo suficiente para este test
    const links = await fetchTurnCatalogLinks(supabase, "conv-1");

    expect(links).toEqual([
      {
        id: "link-1",
        key: "cascos",
        label: "Cascos",
        url: "https://drive.google.com/cascos",
        sortOrder: 1,
        isActive: true,
        updatedBy: null,
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
      },
    ]);
  });

  it("sin ninguna fila, devuelve la lista vacía", async () => {
    const supabase = fakeSupabase({});

    // @ts-expect-error -- fake mínimo suficiente para este test
    const links = await fetchTurnCatalogLinks(supabase, "conv-1");

    expect(links).toEqual([]);
  });

  /** Ante un error de la base, nunca tumba el turno: vacío + log.warn con errorText, NO console.error. */
  it("con un error de la base, devuelve vacío y avisa con turno_enlaces_no_legibles", async () => {
    const { log } = await import("@/lib/log");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const supabase = fakeSupabase({ error: { message: "conexión perdida" } });

    // @ts-expect-error -- fake mínimo suficiente para este test
    const links = await fetchTurnCatalogLinks(supabase, "conv-1");

    expect(links).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "turno_enlaces_no_legibles",
      expect.objectContaining({ conversationId: "conv-1", detail: "conexión perdida" })
    );
    expect(consoleError).not.toHaveBeenCalled();

    warn.mockRestore();
    consoleError.mockRestore();
  });

  /** Si el cliente falso LANZA (una excepción, no un `{ error }`), tampoco se cae. */
  it("si la consulta lanza en vez de devolver un error, igual devuelve vacío sin propagar", async () => {
    const { log } = await import("@/lib/log");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const supabaseQueRompe = {
      from() {
        throw new Error("boom");
      },
    };

    // @ts-expect-error -- fake mínimo suficiente para este test
    const links = await fetchTurnCatalogLinks(supabaseQueRompe, "conv-1");

    expect(links).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "turno_enlaces_no_legibles",
      expect.objectContaining({ conversationId: "conv-1", detail: "boom" })
    );

    warn.mockRestore();
  });
});
