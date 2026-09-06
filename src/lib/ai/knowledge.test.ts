import { beforeEach, describe, expect, it, vi } from "vitest";

// D3 (6/9/2026): mismo patrón que tools.test.ts — se espía `log.error` sin
// tragarse el resto del módulo real (`errorText`) con `importOriginal()`,
// para no arrastrar de más ni perder el comportamiento real de `log.warn`/
// `log.info` si algún día `knowledge.ts` los usa.
const { logErrorMock } = vi.hoisted(() => ({ logErrorMock: vi.fn() }));
vi.mock("@/lib/log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log")>();
  return { ...actual, log: { ...actual.log, error: logErrorMock } };
});

import { buildKnowledgeTool } from "@/lib/ai/knowledge";

// ---------------------------------------------------------------------------
// D3 (6/9/2026): `buildKnowledgeTool` se tragaba en silencio el `error` que
// devolvía Supabase — la respuesta al modelo ya era "no se pudo consultar",
// pero no quedaba rastro en el log del servidor. Mismo defecto y misma
// corrección que `buildCatalogTool`/`buildOrderHistoryTool` en `tools.ts`.
// ---------------------------------------------------------------------------

/** Un Supabase falso cuya cadena de `knowledge_entries` termina en error, en vez de datos. */
function createFailingKnowledgeSupabase() {
  return {
    from(table: string) {
      if (table === "knowledge_entries") {
        return {
          select: () => ({
            eq: () => ({
              limit: async () => ({ data: null, error: { message: "boom" } }),
            }),
          }),
        };
      }
      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
  };
}

/** Un Supabase falso cuya cadena de `knowledge_entries` devuelve las filas dadas. */
function createFakeKnowledgeSupabase(rows: { title: string; content: string; category: { name: string } | null }[]) {
  return {
    from(table: string) {
      if (table === "knowledge_entries") {
        return {
          select: () => ({
            eq: () => ({
              limit: async () => ({ data: rows, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
  };
}

describe("un error de la base deja rastro en el log (D3, 6/9/2026)", () => {
  beforeEach(() => {
    logErrorMock.mockClear();
  });

  it("con error de Supabase devuelve la lista vacía de siempre y deja rastro en el log", async () => {
    const tool = buildKnowledgeTool({
      // @ts-expect-error -- fake mínimo suficiente para este test
      supabase: createFailingKnowledgeSupabase(),
      conversationId: "conv-fallo-biblioteca",
    });

    // El tema necesita al menos una palabra de tres letras o más — con "tema"
    // vacío `execute` corta antes de tocar Supabase (`searchTerms` vacío).
    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ tema: "envíos a Maracaibo" }, { toolCallId: "t1", messages: [] })) as {
      resultados: unknown[];
      error?: string;
    };

    expect(result.resultados).toEqual([]);
    expect(result.error).toBe("No se pudo consultar la biblioteca en este momento.");

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      "herramienta_biblioteca_fallo",
      expect.objectContaining({ conversationId: "conv-fallo-biblioteca" })
    );
    const detail = logErrorMock.mock.calls[0][1].detail as string;
    expect(typeof detail).toBe("string");
    expect(detail.length).toBeGreaterThan(0);
  });

  it("camino feliz: con una fila que calza el tema, no se llama a log.error", async () => {
    const tool = buildKnowledgeTool({
      // @ts-expect-error -- fake mínimo suficiente para este test
      supabase: createFakeKnowledgeSupabase([
        {
          title: "Envíos a domicilio",
          content: "Hacemos envíos a Maracaibo y el resto del país en 48 horas.",
          category: { name: "Envíos" },
        },
      ]),
      conversationId: "conv-ok",
    });

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ tema: "envíos a Maracaibo" }, { toolCallId: "t1", messages: [] })) as {
      resultados: { titulo: string }[];
    };

    expect(result.resultados).toHaveLength(1);
    expect(result.resultados[0].titulo).toBe("Envíos a domicilio");
    expect(logErrorMock).not.toHaveBeenCalled();
  });
});
