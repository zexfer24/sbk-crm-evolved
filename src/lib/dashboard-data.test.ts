import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchLeadTotal } from "@/lib/dashboard-data";

// ---------------------------------------------------------------------------
// Fake mínimo del cliente Supabase: solo entiende la cadena que emite
// `fetchLeadTotal` (`.from().select(cols, {count, head}).not(col, op, val)`),
// igual de chico que el patrón de `data-inbox-counts.test.ts` pero sin el
// motor de `.or()`/`.eq()` que esa consulta no usa.
// ---------------------------------------------------------------------------

interface Filtro {
  op: string;
  column: string;
  value: unknown;
}

function createFakeSupabase(result: { count: number | null; error: unknown }) {
  let opciones: unknown;
  const filtros: Filtro[] = [];

  const client = {
    from() {
      return {
        select(_columns: string, options?: unknown) {
          opciones = options;
          return {
            not(column: string, op: string, value: unknown) {
              filtros.push({ op, column, value });
              return Promise.resolve(result);
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, filtros, getOpciones: () => opciones };
}

describe("fetchLeadTotal", () => {
  it("cuenta conversations con last_customer_message_at no nulo, sin traer filas", async () => {
    const { client, filtros, getOpciones } = createFakeSupabase({ count: 42, error: null });

    const total = await fetchLeadTotal(client);

    expect(total).toBe(42);
    expect(filtros).toEqual([{ op: "is", column: "last_customer_message_at", value: null }]);
    expect(getOpciones()).toEqual({ count: "exact", head: true });
  });

  it("count null (PostgREST sin cabecera Prefer de conteo) cae a 0", async () => {
    const { client } = createFakeSupabase({ count: null, error: null });

    const total = await fetchLeadTotal(client);

    expect(total).toBe(0);
  });

  it("propaga el error de Supabase en vez de devolver 0 en silencio", async () => {
    const boom = new Error("conexión perdida");
    const { client } = createFakeSupabase({ count: null, error: boom });

    await expect(fetchLeadTotal(client)).rejects.toBe(boom);
  });
});
