import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/bcv", () => ({
  getBcvRate: vi.fn(async () => ({ rate: 40, isStale: false })),
}));

// El resto de tools.ts (RECLAMO_CATEGORIES) sigue viniendo del módulo real: solo
// se reemplaza `escalateConversation`, que ya tiene su propia batería de tests
// en escalate.test.ts (incluido el cálculo real de `businessStatus`). Acá solo
// interesa CÓMO `buildEscalateTool` traduce ese resultado a la instrucción que
// lee el modelo — sin importOriginal(), que arrastraría Supabase completo.
const { escalateConversationMock } = vi.hoisted(() => ({
  escalateConversationMock: vi.fn(),
}));
vi.mock("@/lib/ai/escalate", () => ({
  RECLAMO_CATEGORIES: ["Envío", "Pago", "Producto", "Atención", "Garantía"],
  escalateConversation: escalateConversationMock,
}));

// D3 (6/9/2026): se espía `log.error` sin tragarse el resto del módulo real
// (`errorText`, `log.warn`, `log.info`) con `importOriginal()`. Un mock
// completo rompería el test de más abajo ("deja registro en el servidor
// cuando cotiza con datos viejos"), que depende de que `log.warn` escriba de
// verdad en `console.error` para poder leer la línea JSON.
const { logErrorMock } = vi.hoisted(() => ({ logErrorMock: vi.fn() }));
vi.mock("@/lib/log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log")>();
  return { ...actual, log: { ...actual.log, error: logErrorMock } };
});

import {
  buildCatalogTool,
  buildEscalateTool,
  buildOrderHistoryTool,
  RECORDATORIO_SALUDO,
  type CatalogOutcome,
  type EscalationOutcome,
} from "@/lib/ai/tools";
import type { BusinessHours } from "@/lib/business-hours";
import { revealsIdentity } from "@/lib/ai/identity-guard";
import { PREGUNTA_FILTRO, TEXTO_CONFIRMAR_INVENTARIO, TEXTO_NO_IDENTIFICADO, TEXTO_SIN_STOCK } from "@/lib/ai/seba";

/**
 * T3, "Seba atiende el mostrador" (18/9/2026): `buildCatalogTool` ganó un
 * segundo parámetro que se acumula entre llamadas del mismo turno. Los tests
 * viejos de este archivo no necesitan mirarlo — solo pasarlo para que el tool
 * pueda escribir en él — así que este helper les da uno nuevo en cada
 * llamada, salvo los tests nuevos que sí lo inspeccionan.
 */
function nuevoCatalogOutcome(): CatalogOutcome {
  return { ran: false, conExistencia: false, agotados: false, sinResultados: false, generico: false };
}

interface FakeProductRow {
  id: string;
  name: string;
  brand: string;
  price: number;
  currency: "USD" | "VES";
  stock_quantity: number;
  /** Opcional: sin fecha, la herramienta no puede saber la antigüedad y no avisa de nada. */
  updated_at?: string;
  product_compatibility: { moto_brand: string; moto_model: string }[];
}

/**
 * Fila mínima de `ai_lessons` para simular un sinónimo de búsqueda (T5c,
 * 18/9/2026). `scope`/`conversationId` son opcionales y por defecto simulan
 * un sinónimo global de siempre (F, 20/9/2026, "El resguardo antes del
 * push"): antes de esa corrida no existían, así que dejarlos sin poner
 * mantiene el comportamiento de los tests viejos de este archivo.
 */
interface FakeSynonymRow {
  synonym_from: string;
  synonym_to: string;
  scope?: "global" | "conversacion";
  conversationId?: string;
}

function createFakeSupabase(products: FakeProductRow[], synonyms: FakeSynonymRow[] = [], conversationId = "conv-1") {
  const insertedQuotes: Record<string, unknown>[] = [];
  /** Tope que la consulta le pidió a la base, o null si no pidió ninguno. */
  let appliedLimit: number | null = null;
  /** El filtro `.or()` que le llegó a `products` — sirve para ver qué términos quedaron tras expandir sinónimos (T5c, 18/9/2026). */
  let appliedFilter: string | null = null;
  /**
   * F (20/9/2026): el filtro `.or()` que le llegó a `ai_lessons` —
   * `scope.eq.global,conversation_id.eq.<esta conversación>` — para poder
   * assertar su literal exacto además de su efecto.
   */
  let appliedSynonymFilter: string | null = null;

  const client = {
    from(table: string) {
      if (table === "products") {
        return {
          select: () => ({
            eq: () => ({
              or: (filter: string) => {
                appliedFilter = filter;
                return {
                  limit: async (n: number) => {
                    appliedLimit = n;
                    return { data: products.slice(0, n), error: null };
                  },
                };
              },
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
      // T5c (18/9/2026): sinónimos activos que `buildCatalogTool` lee antes
      // de armar el filtro. Vacío por defecto, para que el resto de los
      // tests de este archivo (que no ejercitan sinónimos) no tengan que
      // enterarse de esta consulta nueva. F (20/9/2026): sumó `.or(...)`
      // ANTES de `.limit()` — el fake simula el filtro real de la base:
      // solo pasan los sinónimos `scope=global` o de ESTA conversación,
      // igual que haría Postgres con la condición de verdad.
      if (table === "ai_lessons") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                or: (filter: string) => {
                  appliedSynonymFilter = filter;
                  return {
                    limit: async () => ({
                      data: synonyms.filter(
                        (s) => (s.scope ?? "global") === "global" || s.conversationId === conversationId
                      ),
                      error: null,
                    }),
                  };
                },
              }),
            }),
          }),
        };
      }
      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
  };

  return {
    client,
    insertedQuotes,
    getAppliedLimit: () => appliedLimit,
    getAppliedFilter: () => appliedFilter,
    getAppliedSynonymFilter: () => appliedSynonymFilter,
  };
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
    }, nuevoCatalogOutcome());

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

  /**
   * El precio le llega al modelo ya escrito, y los números crudos NO viajan.
   * Si viajaran, el modelo podría reconvertirlos, redondearlos o "arreglar"
   * el formato — que es exactamente donde alucina. Sin el número, no hay
   * aritmética posible: solo copiar.
   */
  it("le entrega al modelo el precio ya escrito, sin los números crudos", async () => {
    const { client } = createFakeSupabase([
      {
        id: "prod-1",
        name: "Carburador PZ27",
        brand: "Genérico",
        price: 18.5,
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
    }, nuevoCatalogOutcome());

    // @ts-expect-error -- la firma real de `execute` de `ai` es más genérica
    const result = (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
      results: Record<string, unknown>[];
    };

    expect(result.results[0].precio).toBe("$18,50 (Bs. 740,00)");
    expect(result.results[0]).not.toHaveProperty("precioUsd");
    expect(result.results[0]).not.toHaveProperty("precioBs");
  });

  it("no inserta nada en conversation_quotes si la búsqueda no encontró resultados", async () => {
    const { client, insertedQuotes } = createFakeSupabase([]);
    const tool = buildCatalogTool({
      // @ts-expect-error -- fake mínimo
      supabase: client,
      conversationId: "conv-1",
      contactId: "contact-1",
    }, nuevoCatalogOutcome());

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "algo que no existe" }, { toolCallId: "t1", messages: [] });

    expect(insertedQuotes).toHaveLength(0);
  });
});

/**
 * T5c, plan "Seba atiende el mostrador" (18/9/2026, requisito 7, decisión
 * P3): "Lecciones de Seba" con `kind = 'sinonimo'` expanden lo que
 * `buscarRepuesto` busca en el catálogo — un asesor enseña que la jerga del
 * cliente ("pastilla") también es el nombre real de un repuesto ("pastillas
 * de freno") sin tocar código.
 */
describe("buildCatalogTool — sinónimos de búsqueda (T5c, 18/9/2026)", () => {
  /**
   * El fake de `products` (`createFakeSupabase`) no aplica un `ilike` de
   * verdad —igual que el resto de los tests de este archivo, que simulan
   * "encontrado"/"no encontrado" pasando distintos arreglos de productos, no
   * filtrando de verdad—, así que la forma correcta de probar la expansión
   * es mirar el FILTRO que le llega a `.or()`: con el sinónimo activo tiene
   * que traer el término real además de la jerga; sin él, solo la jerga.
   */
  it("con el sinónimo activo, el filtro que le llega a products incluye el término real además de la jerga", async () => {
    const { client, getAppliedFilter } = createFakeSupabase(
      [
        {
          id: "prod-1",
          name: "Pastillas de freno Bera",
          brand: "Bera",
          price: 12,
          currency: "USD",
          stock_quantity: 4,
          product_compatibility: [],
        },
      ],
      [{ synonym_from: "pastilla", synonym_to: "pastillas de freno" }]
    );

    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      nuevoCatalogOutcome()
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "pastilla" }, { toolCallId: "t1", messages: [] })) as {
      results: { nombre: string }[];
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0].nombre).toBe("Pastillas de freno Bera");
    expect(getAppliedFilter()).toContain("pastilla");
    expect(getAppliedFilter()).toContain("pastillas de freno");
  });

  it("sin ningún sinónimo cargado, el filtro solo trae la jerga tal cual la escribió el cliente", async () => {
    const { client, getAppliedFilter } = createFakeSupabase([
      {
        id: "prod-1",
        name: "Pastillas de freno Bera",
        brand: "Bera",
        price: 12,
        currency: "USD",
        stock_quantity: 4,
        product_compatibility: [],
      },
    ]);

    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      nuevoCatalogOutcome()
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "pastilla" }, { toolCallId: "t1", messages: [] });

    expect(getAppliedFilter()).toContain("pastilla");
    expect(getAppliedFilter()).not.toContain("pastillas de freno");
  });

  /**
   * La consulta real (tools.ts) filtra `is_active = true`: un sinónimo
   * desactivado nunca debería llegar hasta acá. La segunda guarda —que
   * `expandTerms` también ignore `isActive === false` si algo lo pasara
   * igual— se prueba a nivel de función pura en catalog-search.test.ts
   * ("ignora los sinónimos inactivos"), donde es más directo de armar sin
   * fingir toda la cadena de Supabase.
   */
  it("respeta el filtro is_active de la consulta: solo pide sinónimos activos, y el alcance es global o de esta conversación", async () => {
    const filtrosVistos: unknown[] = [];
    let synonymOrFilter: string | null = null;
    const client = {
      from(table: string) {
        if (table === "ai_lessons") {
          return {
            select: () => ({
              eq: (col: string, val: unknown) => {
                filtrosVistos.push([col, val]);
                return {
                  eq: (col2: string, val2: unknown) => {
                    filtrosVistos.push([col2, val2]);
                    return {
                      or: (filter: string) => {
                        synonymOrFilter = filter;
                        return { limit: async () => ({ data: [], error: null }) };
                      },
                    };
                  },
                };
              },
            }),
          };
        }
        if (table === "products") {
          return {
            select: () => ({
              eq: () => ({ or: () => ({ limit: async () => ({ data: [], error: null }) }) }),
            }),
          };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
    };

    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      nuevoCatalogOutcome()
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "pastilla" }, { toolCallId: "t1", messages: [] });

    expect(filtrosVistos).toContainEqual(["kind", "sinonimo"]);
    expect(filtrosVistos).toContainEqual(["is_active", true]);

    // F (20/9/2026, "El resguardo antes del push", C3): sin este filtro, un
    // sinónimo guardado como "Solo este chat" (scope='conversacion') se
    // aplicaba a TODOS los chats. El literal exacto que le llega a `.or()`.
    expect(synonymOrFilter).toBe(`scope.eq.global,conversation_id.eq."conv-1"`);
  });

  /**
   * F (20/9/2026): un sinónimo "Solo este chat" de OTRA conversación no
   * puede expandir la búsqueda de esta — el fake `createFakeSupabase` ya
   * simula el filtro real (solo pasan `scope=global` o los de ESTA
   * conversación), así que este caso ejercita el efecto, no solo el
   * literal de arriba.
   */
  it("un sinónimo 'solo este chat' de OTRA conversación no expande la búsqueda de esta", async () => {
    const { client, getAppliedFilter } = createFakeSupabase(
      [
        {
          id: "prod-1",
          name: "Pastillas de freno Bera",
          brand: "Bera",
          price: 12,
          currency: "USD",
          stock_quantity: 4,
          product_compatibility: [],
        },
      ],
      [{ synonym_from: "pastilla", synonym_to: "pastillas de freno", scope: "conversacion", conversationId: "conv-otro-chat" }],
      "conv-1"
    );

    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      nuevoCatalogOutcome()
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "pastilla" }, { toolCallId: "t1", messages: [] });

    expect(getAppliedFilter()).toContain("pastilla");
    expect(getAppliedFilter()).not.toContain("pastillas de freno");
  });

  it("un sinónimo 'solo este chat' de ESTA conversación SÍ expande la búsqueda", async () => {
    const { client, getAppliedFilter } = createFakeSupabase(
      [
        {
          id: "prod-1",
          name: "Pastillas de freno Bera",
          brand: "Bera",
          price: 12,
          currency: "USD",
          stock_quantity: 4,
          product_compatibility: [],
        },
      ],
      [{ synonym_from: "pastilla", synonym_to: "pastillas de freno", scope: "conversacion", conversationId: "conv-1" }],
      "conv-1"
    );

    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      nuevoCatalogOutcome()
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "pastilla" }, { toolCallId: "t1", messages: [] });

    expect(getAppliedFilter()).toContain("pastillas de freno");
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
    }, nuevoCatalogOutcome());

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "a" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      hayMas?: boolean;
    };

    // Se pide una ventana más ancha que el tope porque los términos se unen
    // con OR y la consulta trae de más: primero se ordena por cuántos
    // términos calzan y recién ahí se recorta, para que el recorte no se
    // lleve justo el repuesto que el cliente buscaba. Al modelo le llegan 10.
    expect(getAppliedLimit()).toBe(31);
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
    }, nuevoCatalogOutcome());

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
    }, nuevoCatalogOutcome());

    // @ts-expect-error -- firma simplificada
    const result = (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
      hayMas?: boolean;
    };

    expect(result.hayMas).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// La antigüedad del inventario
//
// El catálogo se cargó el 24 de agosto de 2026 y no se volvió a tocar: la
// sincronización vive en una aplicación del dueño y todavía no corre. La
// herramienta estaba apagada justamente por eso, y encenderla sin que la IA
// sepa con qué está cotizando cambiaría "precio viejo en 2 escenarios" por
// "precio viejo en 5.438 filas". Lo que más pesa no es el precio: es que un
// stock de hace cuatro días le haga prometer al cliente algo ya vendido.
// ---------------------------------------------------------------------------

/** Un producto con la antigüedad que se quiera, listo para pasarle al fake. */
function producto(overrides: Partial<FakeProductRow> & { id: string }): FakeProductRow {
  return {
    name: "Carburador PZ27",
    brand: "Genérico",
    price: 18,
    currency: "USD",
    stock_quantity: 12,
    product_compatibility: [],
    ...overrides,
  };
}

function haceDias(dias: number): string {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

async function cotizar(products: FakeProductRow[]) {
  const { client } = createFakeSupabase(products);
  const tool = buildCatalogTool({
    // @ts-expect-error -- fake mínimo
    supabase: client,
    conversationId: "conv-1",
    contactId: "contact-1",
  }, nuevoCatalogOutcome());

  // @ts-expect-error -- firma simplificada del test
  return (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
    results: { stock: number }[];
    inventarioDesactualizado?: boolean;
    instruccionParaTuRespuesta?: string;
  };
}

describe("buildCatalogTool — qué tan viejo es lo que está cotizando", () => {
  /**
   * T3 (18/9/2026): antes de esta corrida, "sin advertencias" significaba
   * `instruccionParaTuRespuesta` ausente del todo. Ahora SIEMPRE hay una
   * instrucción de caso (acá, `confirmar_inventario`, porque el único
   * producto tiene existencia) — lo que sigue sin aparecer es el aviso de
   * antigüedad, que es lo que este test de verdad mide.
   */
  it("con el inventario de hoy no trae aviso de antigüedad (sí la instrucción de existencia, que ahora es siempre)", async () => {
    const result = await cotizar([producto({ id: "prod-1", updated_at: haceDias(0) })]);

    expect(result.inventarioDesactualizado).toBe(false);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_CONFIRMAR_INVENTARIO);
    expect(result.instruccionParaTuRespuesta).not.toMatch(/no se actualiza desde hace/i);
  });

  it("con el inventario de hace una semana se lo dice al modelo, con la antigüedad y el asesor", async () => {
    const result = await cotizar([producto({ id: "prod-1", updated_at: haceDias(7) })]);

    expect(result.inventarioDesactualizado).toBe(true);
    expect(result.instruccionParaTuRespuesta).toMatch(/7 días/);
    expect(result.instruccionParaTuRespuesta).toMatch(/asesor/i);
    expect(result.instruccionParaTuRespuesta).toMatch(/no afirmes/i);
  });

  /**
   * Un dato es tan viejo como el más viejo que se está afirmando: si de tres
   * repuestos cotizados uno lleva una semana sin tocarse, la respuesta entera
   * lleva esa reserva. Al revés —quedarse con el más nuevo— dejaría pasar
   * justo el que puede estar vendido.
   */
  it("mide por el resultado más viejo, no por el más reciente", async () => {
    const result = await cotizar([
      producto({ id: "prod-1", updated_at: haceDias(0) }),
      producto({ id: "prod-2", name: "Carburador PZ30", updated_at: haceDias(9) }),
    ]);

    expect(result.inventarioDesactualizado).toBe(true);
    expect(result.instruccionParaTuRespuesta).toMatch(/9 días/);
  });

  /** Sin fecha en la fila no se inventa una antigüedad ni se calla: no hay nada que afirmar sobre eso. */
  it("sin fecha de actualización no da el inventario por viejo", async () => {
    const result = await cotizar([producto({ id: "prod-1" })]);

    expect(result.inventarioDesactualizado).toBe(false);
  });

  it("deja registro en el servidor cuando cotiza con datos viejos", async () => {
    const escrito: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      escrito.push(String(line));
    });

    await cotizar([producto({ id: "prod-1", updated_at: haceDias(4) })]);
    spy.mockRestore();

    const aviso = escrito.map((line) => JSON.parse(line)).find((l) => l.event === "inventario_desactualizado");
    expect(aviso).toMatchObject({ level: "warn", dias: 4 });
  });
});

describe("buildCatalogTool — un repuesto en cero no se ofrece como disponible", () => {
  /**
   * El stock viaja al modelo tal cual (un repuesto activo en cero se sigue
   * cotizando, ver aiVisibility), y el prompt ya dice que hay que avisar. Pero
   * el prompt es el guion, no la cerradura: acá se le dice con el resultado en
   * la mano, que es lo que el modelo tiene delante cuando redacta.
   */
  /**
   * T3 (18/9/2026): reemplaza a la vieja `SIN_STOCK_INSTRUCTION` ("alguno de
   * estos repuestos está en cero"), que avisaba sin obligar a escalar. Con
   * TODOS los resultados en cero, la instrucción es el texto literal que
   * dictó el cliente (requisito 4) y el motivo `sin_stock`.
   */
  it("se lo dice al modelo en palabras cuando todos vienen en cero, con el texto fijo y el motivo sin_stock", async () => {
    const result = await cotizar([producto({ id: "prod-1", stock_quantity: 0, updated_at: haceDias(0) })]);

    expect(result.results[0].stock).toBe(0);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_SIN_STOCK);
    expect(result.instruccionParaTuRespuesta).toMatch(/asesor/i);
    expect(result.instruccionParaTuRespuesta).toMatch(/motivo sin_stock/);
  });

  it("con existencia, la instrucción es la de confirmar inventario, no la de agotado", async () => {
    const result = await cotizar([producto({ id: "prod-1", stock_quantity: 4, updated_at: haceDias(0) })]);

    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_CONFIRMAR_INVENTARIO);
    expect(result.instruccionParaTuRespuesta).not.toContain(TEXTO_SIN_STOCK);
  });

  /** Las dos advertencias son independientes y pueden salir juntas. */
  it("con un repuesto en cero y el inventario viejo, avisa de las dos cosas", async () => {
    const result = await cotizar([producto({ id: "prod-1", stock_quantity: 0, updated_at: haceDias(5) })]);

    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_SIN_STOCK);
    expect(result.instruccionParaTuRespuesta).toMatch(/5 días/);
  });
});

// ---------------------------------------------------------------------------
// Frente B4 ("El reloj dice la verdad", 5/9/2026): la despedida al escalar
// SIN ningún asesor conectado tiene que decir cuándo lo van a atender. Antes
// de esto la instrucción era siempre la misma frase genérica, sin importar
// si eran las 10 am de un lunes o las 10 pm de un domingo.
//
// Tarea 5 ("La voz cercana y la espera visible", 14/9/2026) encontró la
// misma falla del lado CON asesor y sumó las cuatro ramas de
// `escalationInstruction` (antes `unassignedEscalationInstruction`, que solo
// cubría las dos de abajo).
// ---------------------------------------------------------------------------
describe("buildEscalateTool — instrucción de despedida según asesor y horario", () => {
  beforeEach(() => {
    escalateConversationMock.mockReset();
  });

  function crearHerramienta(outcome: EscalationOutcome, deps?: { businessHours?: BusinessHours; now?: Date }) {
    return buildEscalateTool(
      // @ts-expect-error -- fake mínimo: la herramienta reenvía supabase tal
      // cual a escalateConversation, que está mockeado en este archivo.
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1", ...deps },
      outcome
    );
  }

  async function ejecutar(outcome: EscalationOutcome, deps?: { businessHours?: BusinessHours; now?: Date }) {
    const tool = crearHerramienta(outcome, deps);
    const input = { motivo: "queja" as const, resumen: "Reclama por un envío que no llegó" };
    // @ts-expect-error -- la firma real de `execute` de `ai` es más genérica que lo que necesitamos simular acá
    return (await tool.execute(input, { toolCallId: "t1", messages: [] })) as { instruccionParaTuRespuesta: string };
  }

  it("con asesor asignado y tienda abierta (o sin businessStatus, compatibilidad), la instrucción no cambia", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: "María" });

    const result = await ejecutar({ escalated: false });

    // Tarea 3 (14/9/2026): las cuatro ramas de `escalationInstruction` ganan
    // calidez explícita ("con calidez"/"agradécele"), no solo la rama con
    // asesor y tienda cerrada, que ya la traía desde B4.
    //
    // Corrección del 15/9/2026 (verificación final de "La voz de mostrador
    // con nombre propio y el cierre de v1.1"): la instrucción ahora termina
    // con RECORDATORIO_SALUDO en las cuatro ramas (ver el bug real en
    // tools.ts, arriba de `escalationInstruction`), así que el `toBe`
    // concatena la constante en vez de comparar contra el string viejo.
    expect(result.instruccionParaTuRespuesta).toBe(
      `Ya está asignado a María. Dile al cliente, con calidez, que un asesor toma su caso y le escribe por acá; agradécele la espera.${RECORDATORIO_SALUDO}`
    );
  });

  /**
   * Tarea 5 (14/9/2026): la falla que la auditoría midió del lado CON
   * asesor — la promesa nunca decía cuándo si la tienda ya había cerrado.
   */
  it("con asesor asignado y tienda cerrada con próxima apertura, agradece la paciencia y dice el día y la hora", async () => {
    escalateConversationMock.mockResolvedValue({
      escalated: true,
      assignedAgentName: "María",
      businessStatus: { open: false, closesAt: null, nextOpening: { dayLabel: "el lunes", time: "8:00 am" } },
    });

    const result = await ejecutar({ escalated: false });

    expect(result.instruccionParaTuRespuesta).toContain("María");
    expect(result.instruccionParaTuRespuesta).toContain("lunes");
    expect(result.instruccionParaTuRespuesta).toContain("8:00 am");
    expect(result.instruccionParaTuRespuesta).toMatch(/NO prometas/);
    // Corrección del 15/9/2026: ver el bug real arriba de `escalationInstruction`.
    expect(result.instruccionParaTuRespuesta).toContain(RECORDATORIO_SALUDO);
  });

  it("con asesor asignado y tienda cerrada sin ninguna apertura en los próximos 7 días, dice 'apenas la tienda vuelva a abrir'", async () => {
    escalateConversationMock.mockResolvedValue({
      escalated: true,
      assignedAgentName: "María",
      businessStatus: { open: false, closesAt: null, nextOpening: null },
    });

    const result = await ejecutar({ escalated: false });

    expect(result.instruccionParaTuRespuesta).toContain("María");
    expect(result.instruccionParaTuRespuesta).toMatch(/vuelva a abrir/);
    expect(result.instruccionParaTuRespuesta).toMatch(/NO prometas/);
    expect(result.instruccionParaTuRespuesta).not.toMatch(/undefined/);
    // Corrección del 15/9/2026: ver el bug real arriba de `escalationInstruction`.
    expect(result.instruccionParaTuRespuesta).toContain(RECORDATORIO_SALUDO);
  });

  it("sin asesores y tienda abierta, promete 'en breve' sin prometer un plazo", async () => {
    escalateConversationMock.mockResolvedValue({
      escalated: true,
      assignedAgentName: null,
      unassigned: true,
      businessStatus: { open: true, closesAt: "6:00 pm", nextOpening: null },
    });

    const result = await ejecutar({ escalated: false });

    expect(result.instruccionParaTuRespuesta).toMatch(/en breve/);
    expect(result.instruccionParaTuRespuesta).toMatch(/NO prometas/);
    // Corrección del 15/9/2026: ver el bug real arriba de `escalationInstruction`.
    expect(result.instruccionParaTuRespuesta).toContain(RECORDATORIO_SALUDO);
  });

  /**
   * El caso que motivó el frente: con la tienda cerrada un domingo (ver
   * `escalate.test.ts` para la prueba de que `escalateConversation` SÍ
   * calcula este `businessStatus` así con `now` en domingo), la instrucción
   * final que lee el modelo contiene "lunes" en vez de "en breve".
   */
  it("sin asesores y tienda cerrada con próxima apertura, dice el día y la hora exactos", async () => {
    escalateConversationMock.mockResolvedValue({
      escalated: true,
      assignedAgentName: null,
      unassigned: true,
      businessStatus: { open: false, closesAt: null, nextOpening: { dayLabel: "el lunes", time: "8:00 am" } },
    });

    const result = await ejecutar({ escalated: false });

    expect(result.instruccionParaTuRespuesta).toContain("lunes");
    expect(result.instruccionParaTuRespuesta).toContain("8:00 am");
    expect(result.instruccionParaTuRespuesta).toMatch(/NO prometas/);
    // Corrección del 15/9/2026: ver el bug real arriba de `escalationInstruction`.
    expect(result.instruccionParaTuRespuesta).toContain(RECORDATORIO_SALUDO);
  });

  it("sin asesores y sin ninguna apertura en los próximos 7 días, dice 'apenas la tienda vuelva a abrir'", async () => {
    escalateConversationMock.mockResolvedValue({
      escalated: true,
      assignedAgentName: null,
      unassigned: true,
      businessStatus: { open: false, closesAt: null, nextOpening: null },
    });

    const result = await ejecutar({ escalated: false });

    expect(result.instruccionParaTuRespuesta).toMatch(/vuelva a abrir/);
    expect(result.instruccionParaTuRespuesta).not.toMatch(/undefined/);
    // Corrección del 15/9/2026: ver el bug real arriba de `escalationInstruction`.
    expect(result.instruccionParaTuRespuesta).toContain(RECORDATORIO_SALUDO);
  });

  it("sin businessStatus en el resultado (compatibilidad), cae al texto de 'en breve'", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: null, unassigned: true });

    const result = await ejecutar({ escalated: false });

    expect(result.instruccionParaTuRespuesta).toMatch(/en breve/);
    // Corrección del 15/9/2026: ver el bug real arriba de `escalationInstruction`.
    expect(result.instruccionParaTuRespuesta).toContain(RECORDATORIO_SALUDO);
  });

  it("reenvía businessHours y now a escalateConversation, tal como los recibió", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: "María" });

    const now = new Date("2026-09-06T14:00:00.000Z");
    const businessHours: BusinessHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

    await ejecutar({ escalated: false }, { businessHours, now });

    expect(escalateConversationMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ conversationId: "conv-1", contactId: "contact-1", businessHours, now })
    );
  });

  /**
   * Tarea 3 (14/9/2026): una de las cinco frases fijas que el plan exige
   * pasar por la guarda de identidad (junto con OFF_TOPIC_REPLY, las dos
   * despedidas de agent.ts y el sufijo de catálogo apagado de prompt.ts).
   * Esta es la única de las cinco que vive en tools.ts.
   */
  it("las cuatro ramas cálidas de la instrucción pasan la guarda de identidad", async () => {
    const casos: { assignedAgentName: string | null; unassigned?: boolean; businessStatus?: unknown }[] = [
      { assignedAgentName: "María" },
      {
        assignedAgentName: "María",
        businessStatus: { open: false, closesAt: null, nextOpening: { dayLabel: "el lunes", time: "8:00 am" } },
      },
      { assignedAgentName: null, unassigned: true, businessStatus: { open: true, closesAt: "6:00 pm", nextOpening: null } },
      {
        assignedAgentName: null,
        unassigned: true,
        businessStatus: { open: false, closesAt: null, nextOpening: null },
      },
    ];

    for (const caso of casos) {
      escalateConversationMock.mockResolvedValue({ escalated: true, ...caso });
      const result = await ejecutar({ escalated: false });
      expect(revealsIdentity(result.instruccionParaTuRespuesta)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// "La IA pasa el caso a ventas apenas el cliente acepta" (8/9/2026): T2 había
// agregado una segunda confirmación para "intencion_compra", pero en
// producción el cliente contesta "ok"/"dale"/"está bien" en vez de un "sí"
// literal, el modelo no lo reconocía como el segundo sí y la conversación
// quedaba en bucle pidiendo confirmación. Se eliminó la máquina de
// reconfirmación: ahora los tres motivos ("devolucion", "queja",
// "intencion_compra") escalan igual, con el primer aviso.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Tarea 7 ("El guion atiende a quien no es cliente…", 14/9/2026): el motivo
// `seguimiento` ya lo admitía `EscalationMotivo` (escalate.ts) para la red de
// seguridad del orquestador, pero el ESQUEMA que el modelo ve en
// `buildEscalateTool` seguía con solo tres valores — el modelo nunca podría
// haberlo elegido aunque el prompt se lo pidiera. Este test mira el zod
// schema de verdad, no una copia: llamar `tool.execute(...)` a mano (como
// hacen el resto de los tests de este archivo) no pasa por la validación del
// esquema, así que no habría atrapado el enum viejo.
// ---------------------------------------------------------------------------
describe("buildEscalateTool — el esquema acepta el motivo seguimiento", () => {
  it("el zod schema de 'motivo' acepta 'seguimiento' además de los tres motivos de siempre", () => {
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo: no se ejecuta nada, solo se lee el esquema.
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      { escalated: false }
    );

    const schema = (tool as unknown as { inputSchema: { shape: { motivo: { parse: (v: unknown) => unknown } } } })
      .inputSchema.shape.motivo;

    expect(() => schema.parse("seguimiento")).not.toThrow();
    expect(() => schema.parse("devolucion")).not.toThrow();
    expect(() => schema.parse("queja")).not.toThrow();
    expect(() => schema.parse("intencion_compra")).not.toThrow();
    expect(() => schema.parse("motivo_inventado")).toThrow();
  });

  // T3, "Seba atiende el mostrador" (18/9/2026, requisitos 2/3/4 del
  // cliente): el modelo tiene que poder elegir estos tres motivos cuando
  // llama a `escalarAAsesor` tras leer la instrucción del catálogo
  // (`buildCatalogTool`, más abajo en este archivo) — sin el esquema real
  // actualizado, el prompt podría pedírselo y el modelo nunca podría hacerlo.
  it("el zod schema de 'motivo' acepta los tres motivos nuevos del catálogo (confirmar_inventario, sin_stock, no_identificado)", () => {
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo: no se ejecuta nada, solo se lee el esquema.
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      { escalated: false }
    );

    const schema = (tool as unknown as { inputSchema: { shape: { motivo: { parse: (v: unknown) => unknown } } } })
      .inputSchema.shape.motivo;

    expect(() => schema.parse("confirmar_inventario")).not.toThrow();
    expect(() => schema.parse("sin_stock")).not.toThrow();
    expect(() => schema.parse("no_identificado")).not.toThrow();
    // No hay `consulta_generica`: ese caso pide una pregunta y NO escala.
    expect(() => schema.parse("consulta_generica")).toThrow();
  });
});

describe("buildEscalateTool — intencion_compra escala con el primer aviso", () => {
  beforeEach(() => {
    escalateConversationMock.mockReset();
  });

  /** Fake que revienta si `buildEscalateTool` toca `conversations`/`messages` por su cuenta: hoy todo pasa por `escalateConversation`, que está mockeado. */
  function crearFakeSupabaseSinEscrituraDirecta(): unknown {
    return {
      from(table: string) {
        throw new Error(`Fake Supabase: no se esperaba tocar la tabla '${table}' desde buildEscalateTool`);
      },
    };
  }

  it("la primera llamada con motivo intencion_compra escala directo: llama a escalateConversation y devuelve escalated true", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: "María" });
    const outcome: EscalationOutcome = { escalated: false };
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo: si la herramienta tocara supabase
      // directo (en vez de reenviarlo a escalateConversation, mockeado),
      // el fake revienta.
      { supabase: crearFakeSupabaseSinEscrituraDirecta(), conversationId: "conv-1", contactId: "contact-1" },
      outcome
    );

    const input = { motivo: "intencion_compra" as const, resumen: "Quiere comprar un carburador" };
    // @ts-expect-error -- la firma real de `execute` de `ai` es más genérica que lo que necesitamos simular acá
    const result = (await tool.execute(input, { toolCallId: "t1", messages: [] })) as {
      escalated: boolean;
      instruccionParaTuRespuesta: string;
    };

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(escalateConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: "conv-1", contactId: "contact-1", motivo: "intencion_compra" })
    );
    expect(result.escalated).toBe(true);
    expect(outcome.escalated).toBe(true);
  });

  it("devolución y queja también escalan directo con el primer aviso", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: "María" });
    const outcome: EscalationOutcome = { escalated: false };
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo
      { supabase: crearFakeSupabaseSinEscrituraDirecta(), conversationId: "conv-1", contactId: "contact-1" },
      outcome
    );

    const input = { motivo: "devolucion" as const, resumen: "Quiere devolver un casco" };
    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute(input, { toolCallId: "t1", messages: [] })) as { escalated: boolean };

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(result.escalated).toBe(true);
    expect(outcome.escalated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D3 (6/9/2026): un error de Supabase en una herramienta del tool loop se
// tragaba en silencio — la respuesta al modelo ya era "no se pudo consultar",
// pero no quedaba ningún rastro en el log del servidor. El 5/9/2026 se buscó
// a ciegas el rastro de un "catálogo fuera de servicio" que resultó ser el
// interruptor por herramienta apagado; un error real de la base tampoco
// habría dejado nada. Estos tests verifican que ahora sí queda registrado,
// con el `conversationId` y el detalle del error, sin cambiar lo que recibe
// el modelo.
// ---------------------------------------------------------------------------
describe("un error de la base deja rastro en el log (D3, 6/9/2026)", () => {
  beforeEach(() => {
    logErrorMock.mockClear();
  });

  /** Un Supabase falso cuya cadena de `products` termina en error, en vez de datos. */
  function createFailingCatalogSupabase() {
    return {
      from(table: string) {
        if (table === "products") {
          return {
            select: () => ({
              eq: () => ({
                or: () => ({
                  limit: async () => ({ data: null, error: { message: "boom" } }),
                }),
              }),
            }),
          };
        }
        // T5c (18/9/2026): la consulta de sinónimos corre ANTES que la de
        // `products` — sin este handler, este test rompería por una tabla
        // "no soportada" antes de llegar siquiera a simular el fallo real.
        if (table === "ai_lessons") {
          return {
            select: () => ({
              eq: () => ({ eq: () => ({ or: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
            }),
          };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
    };
  }

  /** Un Supabase falso cuya cadena de `orders` termina en error, en vez de datos. */
  function createFailingOrderHistorySupabase() {
    return {
      from(table: string) {
        if (table === "orders") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: null, error: { message: "boom" } }),
                }),
              }),
            }),
          };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
    };
  }

  it("catálogo: con error de Supabase devuelve la lista vacía de siempre y deja rastro en el log", async () => {
    // T3 (18/9/2026): un error de la base tampoco deja decidir nada — se
    // guarda el `catalogOutcome` de este llamado para comprobar que queda
    // marcado `sinResultados`, igual que "no encontré nada".
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      {
        // @ts-expect-error -- fake mínimo suficiente para este test
        supabase: createFailingCatalogSupabase(),
        conversationId: "conv-fallo-catalogo",
        contactId: "contact-1",
      },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      error?: string;
      instruccionParaTuRespuesta?: string;
    };

    expect(result.results).toEqual([]);
    expect(result.error).toBe("No se pudo consultar el catálogo en este momento.");
    expect(catalogOutcome.ran).toBe(true);
    expect(catalogOutcome.sinResultados).toBe(true);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_NO_IDENTIFICADO);

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      "herramienta_catalogo_fallo",
      expect.objectContaining({ conversationId: "conv-fallo-catalogo" })
    );
    const detail = logErrorMock.mock.calls[0][1].detail as string;
    expect(typeof detail).toBe("string");
    expect(detail.length).toBeGreaterThan(0);
  });

  it("historial: con error de Supabase devuelve la lista vacía de siempre y deja rastro en el log", async () => {
    const tool = buildOrderHistoryTool({
      // @ts-expect-error -- fake mínimo suficiente para este test
      supabase: createFailingOrderHistorySupabase(),
      conversationId: "conv-fallo-historial",
      contactId: "contact-1",
    });

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({}, { toolCallId: "t1", messages: [] })) as {
      orders: unknown[];
      error?: string;
    };

    expect(result.orders).toEqual([]);
    expect(result.error).toBe("No se pudo consultar el historial de compras.");

    expect(logErrorMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      "herramienta_historial_fallo",
      expect.objectContaining({ conversationId: "conv-fallo-historial" })
    );
    const detail = logErrorMock.mock.calls[0][1].detail as string;
    expect(typeof detail).toBe("string");
    expect(detail.length).toBeGreaterThan(0);
  });

  it("camino feliz: con la consulta de catálogo devolviendo filas, no se llama a log.error", async () => {
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
      conversationId: "conv-ok",
      contactId: "contact-1",
    }, nuevoCatalogOutcome());

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
    };

    expect(result.results).toHaveLength(1);
    expect(logErrorMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T3, "Seba atiende el mostrador" (18/9/2026, requisitos 2/3/4/5 del
// cliente): las cuatro instrucciones de caso, en orden de precedencia, y el
// `CatalogOutcome` que la red de seguridad de `agent.ts` lee para escalar en
// código si el modelo se queda sin pasos antes de hacerlo por su cuenta.
// ---------------------------------------------------------------------------
describe("buildCatalogTool — sin resultados, escala con no_identificado", () => {
  it("sin ningún producto en el catálogo, la instrucción es el texto fijo y el motivo no_identificado", async () => {
    const { client } = createFakeSupabase([]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      instruccionParaTuRespuesta?: string;
    };

    expect(result.results).toEqual([]);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_NO_IDENTIFICADO);
    expect(result.instruccionParaTuRespuesta).toMatch(/motivo no_identificado/);
    expect(catalogOutcome.ran).toBe(true);
    expect(catalogOutcome.sinResultados).toBe(true);
    expect(catalogOutcome.conExistencia).toBe(false);
    expect(catalogOutcome.agotados).toBe(false);
    expect(catalogOutcome.generico).toBe(false);
  });

  /** El otro sitio "sin instrucción" que nombra el plan: sin términos reconocibles, antes de tocar la base. */
  it("sin términos de búsqueda reconocibles (query muy corta), también marca sinResultados", async () => {
    const { client } = createFakeSupabase([]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // Palabras de menos de tres letras se descartan (searchTerms), pero
    // `searchTerms` cae a la frase entera si queda algo — para que
    // `terms.length === 0` de verdad hace falta una consulta vacía tras
    // normalizar.
    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "   " }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      instruccionParaTuRespuesta?: string;
    };

    expect(result.results).toEqual([]);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_NO_IDENTIFICADO);
    expect(catalogOutcome.sinResultados).toBe(true);
  });
});

describe("buildCatalogTool — consulta genérica: una pregunta de filtro, sin escalar", () => {
  /** Varios repuestos genéricos, sin marca ni modelo de moto en la consulta: más de tres calzan. */
  function repuestosGenericos(cantidad: number): FakeProductRow[] {
    return Array.from({ length: cantidad }, (_, i) => ({
      id: `prod-${i}`,
      name: `Pastilla de freno ${i}`,
      brand: "Genérico",
      price: 10,
      currency: "USD" as const,
      stock_quantity: 5,
      product_compatibility: [],
    }));
  }

  it("sin marca ni modelo y más de tres resultados: pregunta de filtro, generico=true, y NO escala en este turno", async () => {
    const { client } = createFakeSupabase(repuestosGenericos(5));
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "pastilla" }, { toolCallId: "t1", messages: [] })) as {
      instruccionParaTuRespuesta?: string;
    };

    expect(result.instruccionParaTuRespuesta).toContain(PREGUNTA_FILTRO);
    expect(result.instruccionParaTuRespuesta).toMatch(/no escales/i);
    expect(result.instruccionParaTuRespuesta).not.toMatch(/escalarAAsesor/);
    expect(catalogOutcome.generico).toBe(true);
    expect(catalogOutcome.conExistencia).toBe(false);
  });

  it("con tres resultados o menos, no es genérico aunque no haya marca ni modelo", async () => {
    const { client } = createFakeSupabase(repuestosGenericos(2));
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "pastilla" }, { toolCallId: "t1", messages: [] });

    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.conExistencia).toBe(true);
  });

  it("con motoModel y más de tres resultados, NO es genérico: cotiza y escala con confirmar_inventario", async () => {
    const { client } = createFakeSupabase(repuestosGenericos(5));
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "pastilla", motoModel: "SBR 200" }, { toolCallId: "t1", messages: [] })) as {
      instruccionParaTuRespuesta?: string;
    };

    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_CONFIRMAR_INVENTARIO);
  });

  it("con motoBrand y más de tres resultados, tampoco es genérico", async () => {
    const { client } = createFakeSupabase(repuestosGenericos(5));
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "pastilla", motoBrand: "Bera" }, { toolCallId: "t1", messages: [] });

    expect(catalogOutcome.generico).toBe(false);
  });
});

describe("buildCatalogTool — el CatalogOutcome se acumula entre llamadas del mismo turno", () => {
  /** Un fake cuyo `products` devuelve una lista distinta en cada llamada, en el orden dado. */
  function createSequencedFakeSupabase(secuencia: FakeProductRow[][]) {
    let llamada = 0;
    return {
      from(table: string) {
        if (table === "products") {
          return {
            select: () => ({
              eq: () => ({
                or: () => ({
                  limit: async (n: number) => {
                    const products = secuencia[llamada] ?? [];
                    llamada += 1;
                    return { data: products.slice(0, n), error: null };
                  },
                }),
              }),
            }),
          };
        }
        if (table === "conversation_quotes") {
          return { insert: async () => ({ data: null, error: null }) };
        }
        // T5c (18/9/2026): igual que en `createFakeSupabase`, vacío por defecto.
        if (table === "ai_lessons") {
          return {
            select: () => ({
              eq: () => ({ eq: () => ({ or: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
            }),
          };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
    };
  }

  it("una llamada con existencia y otra sin resultados dejan conExistencia=true Y sinResultados=true a la vez", async () => {
    const client = createSequencedFakeSupabase([
      [
        {
          id: "prod-1",
          name: "Carburador PZ27",
          brand: "Genérico",
          price: 18,
          currency: "USD",
          stock_quantity: 12,
          product_compatibility: [],
        },
      ],
      [],
    ]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] });
    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "algo que no existe" }, { toolCallId: "t2", messages: [] });

    expect(catalogOutcome.ran).toBe(true);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(catalogOutcome.sinResultados).toBe(true);
    // Lo que NO pasó en ninguna de las dos llamadas sigue en false.
    expect(catalogOutcome.agotados).toBe(false);
    expect(catalogOutcome.generico).toBe(false);
  });
});
