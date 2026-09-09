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

import { buildCatalogTool, buildEscalateTool, buildOrderHistoryTool, type EscalationOutcome } from "@/lib/ai/tools";
import type { BusinessHours } from "@/lib/business-hours";

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
    });

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
  });

  // @ts-expect-error -- firma simplificada del test
  return (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
    results: { stock: number }[];
    inventarioDesactualizado?: boolean;
    instruccionParaTuRespuesta?: string;
  };
}

describe("buildCatalogTool — qué tan viejo es lo que está cotizando", () => {
  it("con el inventario de hoy afirma con normalidad, sin advertencias", async () => {
    const result = await cotizar([producto({ id: "prod-1", updated_at: haceDias(0) })]);

    expect(result.inventarioDesactualizado).toBe(false);
    expect(result.instruccionParaTuRespuesta).toBeUndefined();
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
  it("se lo dice al modelo en palabras cuando alguno viene en cero", async () => {
    const result = await cotizar([producto({ id: "prod-1", stock_quantity: 0, updated_at: haceDias(0) })]);

    expect(result.results[0].stock).toBe(0);
    expect(result.instruccionParaTuRespuesta).toMatch(/cero/i);
    expect(result.instruccionParaTuRespuesta).toMatch(/asesor/i);
  });

  it("no dice nada de eso cuando todos tienen unidades", async () => {
    const result = await cotizar([producto({ id: "prod-1", stock_quantity: 4, updated_at: haceDias(0) })]);

    expect(result.instruccionParaTuRespuesta).toBeUndefined();
  });

  /** Las dos advertencias son independientes y pueden salir juntas. */
  it("con un repuesto en cero y el inventario viejo, avisa de las dos cosas", async () => {
    const result = await cotizar([producto({ id: "prod-1", stock_quantity: 0, updated_at: haceDias(5) })]);

    expect(result.instruccionParaTuRespuesta).toMatch(/cero/i);
    expect(result.instruccionParaTuRespuesta).toMatch(/5 días/);
  });
});

// ---------------------------------------------------------------------------
// Frente B4 ("El reloj dice la verdad", 5/9/2026): la despedida al escalar
// sin ningún asesor conectado tiene que decir cuándo lo van a atender. Antes
// de esto la instrucción era siempre la misma frase genérica, sin importar
// si eran las 10 am de un lunes o las 10 pm de un domingo.
// ---------------------------------------------------------------------------
describe("buildEscalateTool — instrucción de despedida cuando no hay asesores", () => {
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

  it("con asesor asignado, la instrucción no cambia", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: "María" });

    const result = await ejecutar({ escalated: false });

    expect(result.instruccionParaTuRespuesta).toBe(
      "Ya está asignado a María. Dile al cliente que un asesor lo va a atender."
    );
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
  });

  it("sin businessStatus en el resultado (compatibilidad), cae al texto de 'en breve'", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: null, unassigned: true });

    const result = await ejecutar({ escalated: false });

    expect(result.instruccionParaTuRespuesta).toMatch(/en breve/);
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
    const tool = buildCatalogTool({
      // @ts-expect-error -- fake mínimo suficiente para este test
      supabase: createFailingCatalogSupabase(),
      conversationId: "conv-fallo-catalogo",
      contactId: "contact-1",
    });

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      error?: string;
    };

    expect(result.results).toEqual([]);
    expect(result.error).toBe("No se pudo consultar el catálogo en este momento.");

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
    });

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
    };

    expect(result.results).toHaveLength(1);
    expect(logErrorMock).not.toHaveBeenCalled();
  });
});
