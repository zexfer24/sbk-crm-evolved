import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/bcv", () => ({
  getBcvRate: vi.fn(async () => ({ rate: 40, isStale: false })),
}));

import { buildCatalogTool } from "@/lib/ai/tools";

interface FakeProductRow {
  id: string;
  name: string;
  brand: string;
  price: number;
  currency: "USD" | "VES";
  stock_quantity: number;
  product_compatibility: { moto_brand: string; moto_model: string }[];
}

function createFakeSupabase(products: FakeProductRow[]) {
  const insertedQuotes: Record<string, unknown>[] = [];
  /** Tope que la consulta le pidió a la base, o null si no pidió ninguno. */
  let appliedLimit: number | null = null;

  const client = {
    from(table: string) {
      if (table === "products") {
        return {
          select: () => ({
            eq: () => ({
              or: () => ({
                limit: async (n: number) => {
                  appliedLimit = n;
                  return { data: products.slice(0, n), error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "conversation_quotes") {
        return {
          insert: (rows: Record<string, unknown>[]) => {
            insertedQuotes.push(...rows);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
  };

  return { client, insertedQuotes, getAppliedLimit: () => appliedLimit };
}

describe("buildCatalogTool — registro de cotizaciones", () => {
  it("guarda en conversation_quotes cada resultado que le devuelve al modelo, con el precio exacto cotizado", async () => {
    const { client, insertedQuotes } = createFakeSupabase([
      {
        id: "prod-1",
        name: "Carburador PZ27",
        brand: "Genérico",
        price: 18,
        currency: "USD",
        stock_quantity: 12,
        product_compatibility: [],
      },
    ]);

    const tool = buildCatalogTool({
      // @ts-expect-error -- fake mínimo suficiente para este test
      supabase: client,
      conversationId: "conv-1",
      contactId: "contact-1",
    });

    // @ts-expect-error -- la firma real de `execute` de `ai` es más genérica que lo que necesitamos simular acá
    const result = (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
    };

    expect(result.results).toHaveLength(1);
    expect(insertedQuotes).toHaveLength(1);
    expect(insertedQuotes[0]).toMatchObject({
      conversation_id: "conv-1",
      product_id: "prod-1",
      product_name: "Carburador PZ27",
      price_usd: 18,
      price_bs: 720,
      bcv_rate: 40,
    });
  });

  it("no inserta nada en conversation_quotes si la búsqueda no encontró resultados", async () => {
    const { client, insertedQuotes } = createFakeSupabase([]);
    const tool = buildCatalogTool({
      // @ts-expect-error -- fake mínimo
      supabase: client,
      conversationId: "conv-1",
      contactId: "contact-1",
    });

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "algo que no existe" }, { toolCallId: "t1", messages: [] });

    expect(insertedQuotes).toHaveLength(0);
  });
});

describe("buildCatalogTool — tope de resultados", () => {
  /**
   * Sin tope, un término genérico devolvía el catálogo entero al contexto del
   * modelo: nombre, marca, precios, stock y compatibilidades de cada
   * producto. Con cientos de repuestos eso multiplica el costo del turno, y
   * se repite en cada paso del tool loop.
   */
  it("le pide un tope a la base en vez de traer todo el catálogo", async () => {
    const muchos = Array.from({ length: 200 }, (_, i) => ({
      id: `prod-${i}`,
      name: `Repuesto ${i}`,
      brand: "Genérico",
      price: 10,
      currency: "USD" as const,
      stock_quantity: 3,
      product_compatibility: [],
    }));
    const { client, getAppliedLimit } = createFakeSupabase(muchos);

    const tool = buildCatalogTool({
      // @ts-expect-error -- fake mínimo suficiente para este test
      supabase: client,
      conversationId: "conv-1",
      contactId: "contact-1",
    });

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "a" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      hayMas?: boolean;
    };

    // Se piden 11 —uno de más— para saber si quedó algo fuera sin contar el
    // catálogo entero, pero al modelo solo le llegan 10.
    expect(getAppliedLimit()).toBe(11);
    expect(result.results.length).toBe(10);
  });

  it("avisa al modelo cuando hubo que recortar, para que pida precisar", async () => {
    const muchos = Array.from({ length: 200 }, (_, i) => ({
      id: `prod-${i}`,
      name: `Repuesto ${i}`,
      brand: "Genérico",
      price: 10,
      currency: "USD" as const,
      stock_quantity: 3,
      product_compatibility: [],
    }));
    const { client } = createFakeSupabase(muchos);

    const tool = buildCatalogTool({
      // @ts-expect-error -- fake mínimo
      supabase: client,
      conversationId: "conv-1",
      contactId: "contact-1",
    });

    // @ts-expect-error -- firma simplificada
    const result = (await tool.execute({ query: "a" }, { toolCallId: "t1", messages: [] })) as {
      hayMas?: boolean;
    };

    expect(result.hayMas).toBe(true);
  });

  it("con pocos resultados no dice que haya más", async () => {
    const { client } = createFakeSupabase([
      {
        id: "prod-1",
        name: "Carburador PZ27",
        brand: "Genérico",
        price: 18,
        currency: "USD",
        stock_quantity: 12,
        product_compatibility: [],
      },
    ]);

    const tool = buildCatalogTool({
      // @ts-expect-error -- fake mínimo
      supabase: client,
      conversationId: "conv-1",
      contactId: "contact-1",
    });

    // @ts-expect-error -- firma simplificada
    const result = (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
      hayMas?: boolean;
    };

    expect(result.hayMas).toBe(false);
  });
});
