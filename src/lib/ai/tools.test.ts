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

// T3a (28/9/2026): la memoria del pedido (`catalog-memory.ts`) pide Redis. Se
// le da un `FakeRedis` de la cola, nuevo en cada test (`beforeEach` más
// abajo), y una palanca `falla` para simular el corte o la falta de
// REDIS_URL — la herramienta tiene que seguir funcionando sin memoria.
const redisEstado = vi.hoisted(() => ({ redis: null as unknown, falla: null as Error | null }));
vi.mock("@/lib/redis", () => ({
  getRedis: () => {
    if (redisEstado.falla) throw redisEstado.falla;
    return redisEstado.redis;
  },
}));

import { FakeRedis } from "@/lib/ai/fake-redis";
import {
  buildCatalogTool,
  buildEscalateTool,
  buildOrderHistoryTool,
  PREGUNTA_QUE_BUSCA_INSTRUCTION,
  RECORDATORIO_SALUDO,
  type CatalogOutcome,
  type EscalationOutcome,
} from "@/lib/ai/tools";
import type { BusinessHours } from "@/lib/business-hours";
import { revealsIdentity } from "@/lib/ai/identity-guard";
import {
  PREGUNTA_FILTRO,
  PREGUNTA_FILTRO_PRODUCTO,
  TEXTO_CONFIRMAR_INVENTARIO,
  TEXTO_NO_IDENTIFICADO,
  TEXTO_SIN_STOCK,
} from "@/lib/ai/seba";
import { normalize } from "@/lib/ai/catalog-search";
import { log } from "@/lib/log";

/**
 * T3, "Seba atiende el mostrador" (18/9/2026): `buildCatalogTool` ganó un
 * segundo parámetro que se acumula entre llamadas del mismo turno. Los tests
 * viejos de este archivo no necesitan mirarlo — solo pasarlo para que el tool
 * pueda escribir en él — así que este helper les da uno nuevo en cada
 * llamada, salvo los tests nuevos que sí lo inspeccionan.
 */
function nuevoCatalogOutcome(): CatalogOutcome {
  return {
    ran: false,
    conExistencia: false,
    agotados: false,
    sinResultados: false,
    generico: false,
    cotizacion: [],
    preguntaFiltro: null,
    consultas: [],
    masOpciones: [],
  };
}

beforeEach(() => {
  redisEstado.redis = new FakeRedis();
  redisEstado.falla = null;
});

/**
 * Fila mínima que `buscar_productos` (la migración 20260926010000)
 * devolvería. T2, plan "La búsqueda encuentra lo que el cliente pide"
 * (25-26/9/2026): reemplaza a la vieja `FakeProductRow` (una fila de
 * `products` con `product_compatibility` embebido) porque `buildCatalogTool`
 * ya no consulta `products` directo — llama al RPC.
 *
 * `puntaje`/`puntaje_moto` son OPCIONALES: si no se dan, el fake los calcula
 * solo (`puntajeAuto`, más abajo) a partir de si el NOMBRE del producto
 * contiene alguna alternativa de CADA grupo de la consulta real — así la
 * mayoría de los tests no tiene que llevar la cuenta a mano de cuántos
 * términos calza cada fila, igual que `products.search_text` en la base
 * real. Los tests que necesitan control fino (una fila con puntaje MENOR al
 * máximo, a propósito; la moto que calza en una sola fila) lo pasan
 * explícito.
 */
interface FakeRpcRow {
  id: string;
  name: string;
  brand: string;
  price: number;
  currency: "USD" | "VES";
  stock_quantity: number;
  /** Opcional: sin fecha, la herramienta no puede saber la antigüedad y no avisa de nada. */
  updated_at?: string;
  compatibilidad?: { moto_brand: string; moto_model: string }[];
  puntaje?: number;
  /** Fuerza `puntaje_moto_nombre` (la moto CON NOMBRE; la cilindrada nunca cuenta acá). */
  puntaje_moto?: number;
}

/**
 * Simula, sin ejecutar SQL, si `searchText` (el nombre del producto) calza
 * por lo menos una alternativa de CADA grupo — igual que el puntaje real
 * (inicio de palabra), pero con `includes()`: acá no se prueba la SQL (eso
 * lo hace `supabase/tests/buscar_productos.sql`), solo se deriva un puntaje
 * consistente sin que cada test lo escriba a mano.
 */
function puntajeAuto(searchText: string, grupos: string[][]): number {
  const texto = normalize(searchText);
  return grupos.filter((grupo) => grupo.some((alt) => texto.includes(normalize(alt)))).length;
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

/** Los argumentos con los que `buildCatalogTool` llama a `buscar_productos` (migración 20260928010000). */
interface AppliedRpcArgs {
  p_terminos: string[][];
  p_moto: string[][];
  p_limite: number;
  p_opcionales: string[][];
  p_cilindrada: string[][];
}

/**
 * Lo que devolvería `buscar_productos` (migración 20260928010000) para
 * `products`, sin ejecutar SQL: puntajes por inclusión de la alternativa en
 * el nombre, los conteos sobre el conjunto COMPLETO antes del límite, y el
 * MISMO orden que el SQL (puntaje, moto con nombre, empieza con el producto,
 * cilindrada, opcionales, con stock, nombre). Lo comparten los dos fakes de
 * este archivo. Cuando `puntaje`/`puntaje_moto` vienen en la fila, mandan
 * (los tests que necesitan control fino).
 */
function simularBuscarProductos(products: FakeRpcRow[], args: AppliedRpcArgs) {
  const conPuntaje = products
    .map((p) => {
      const texto = normalize(p.name);
      return {
        ...p,
        puntaje: p.puntaje ?? puntajeAuto(p.name, args.p_terminos),
        puntaje_opcional: puntajeAuto(p.name, args.p_opcionales ?? []),
        puntaje_moto_nombre: p.puntaje_moto ?? puntajeAuto(p.name, args.p_moto ?? []),
        puntaje_moto_cilindrada: puntajeAuto(p.name, args.p_cilindrada ?? []),
        empieza_con_producto: (args.p_terminos[0] ?? []).some((alt) => texto.startsWith(normalize(alt))),
      };
    })
    .filter((p) => p.puntaje > 0);

  if (conPuntaje.length === 0) return [];

  const puntajeMaximo = Math.max(...conPuntaje.map((p) => p.puntaje));
  const delMaximo = conPuntaje.filter((p) => p.puntaje === puntajeMaximo);
  const puntajeMotoMaximo = Math.max(0, ...delMaximo.map((p) => p.puntaje_moto_nombre));
  const delMaximoYMoto = delMaximo.filter((p) => p.puntaje_moto_nombre === puntajeMotoMaximo);

  const ordenado = [...conPuntaje].sort(
    (a, b) =>
      b.puntaje - a.puntaje ||
      b.puntaje_moto_nombre - a.puntaje_moto_nombre ||
      Number(b.empieza_con_producto) - Number(a.empieza_con_producto) ||
      b.puntaje_moto_cilindrada - a.puntaje_moto_cilindrada ||
      b.puntaje_opcional - a.puntaje_opcional ||
      Number(b.stock_quantity > 0) - Number(a.stock_quantity > 0) ||
      a.name.localeCompare(b.name)
  );

  return ordenado.slice(0, args.p_limite ?? 10).map((p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    price: p.price,
    currency: p.currency,
    stock_quantity: p.stock_quantity,
    updated_at: p.updated_at ?? null,
    compatibilidad: p.compatibilidad ?? [],
    puntaje: p.puntaje,
    puntaje_moto: p.puntaje_moto_nombre + p.puntaje_moto_cilindrada,
    puntaje_maximo: puntajeMaximo,
    filas_con_puntaje_maximo: delMaximo.length,
    puntaje_moto_maximo: puntajeMotoMaximo,
    filas_con_maximo_y_moto: delMaximoYMoto.length,
    puntaje_opcional: p.puntaje_opcional,
    empieza_con_producto: p.empieza_con_producto,
    puntaje_moto_nombre: p.puntaje_moto_nombre,
    puntaje_moto_cilindrada: p.puntaje_moto_cilindrada,
    filas_con_maximo_y_stock: delMaximoYMoto.filter((f) => f.stock_quantity > 0).length,
  }));
}

function createFakeSupabase(
  products: FakeRpcRow[],
  synonyms: FakeSynonymRow[] = [],
  conversationId = "conv-1",
  /**
   * T3b (28/9/2026): lo que devolvería `corregir_terminos` (migración
   * 20260928020000) — solo para los términos que de verdad llegan en
   * `p_terminos`, como haría la función real. Vacío por defecto: el corrector
   * "no encuentra nada que corregir" y la búsqueda sigue como antes.
   */
  correcciones: { original: string; corregido: string }[] = []
) {
  const insertedQuotes: Record<string, unknown>[] = [];
  /** T3b: los argumentos de cada llamada a `corregir_terminos`, en orden. */
  const correctorCalls: { p_terminos: string[]; p_protegidos: string[] }[] = [];
  /** T2 (25-26/9/2026): los argumentos de la última llamada a `buscar_productos`, o null si no se llegó a llamar. */
  let appliedRpcArgs: AppliedRpcArgs | null = null;
  /** T3a (28/9/2026): TODAS las llamadas a `buscar_productos`, en orden (listas de productos, reintento con más filas). */
  const rpcCalls: AppliedRpcArgs[] = [];
  /**
   * F (20/9/2026): el filtro `.or()` que le llegó a `ai_lessons` —
   * `scope.eq.global,conversation_id.eq.<esta conversación>` — para poder
   * assertar su literal exacto además de su efecto.
   */
  let appliedSynonymFilter: string | null = null;
  /** F (20/9/2026): el tope (`MAX_SYNONYM_LESSONS`) que le llegó a `.limit()` en la consulta de sinónimos. */
  let appliedSynonymLimit: number | null = null;

  const client = {
    // T2 (25-26/9/2026): `buildCatalogTool` ya no consulta `products`
    // directo, llama a `buscar_productos` por RPC. El fake replica lo que
    // hace la migración: descarta lo que no calza ningún grupo (puntaje 0)
    // ANTES de calcular los máximos, calcula los cuatro agregados sobre el
    // conjunto COMPLETO (antes del límite) y recién ahí ordena y recorta a
    // `p_limite` — el mismo orden que `order by puntaje desc, puntaje_moto
    // desc, (stock_quantity > 0) desc, name`.
    rpc(name: string, rawArgs: AppliedRpcArgs | { p_terminos: string[]; p_protegidos: string[] }) {
      if (name === "corregir_terminos") {
        const a = rawArgs as { p_terminos: string[]; p_protegidos: string[] };
        correctorCalls.push(a);
        return Promise.resolve({
          data: correcciones.filter((c) => a.p_terminos.includes(c.original)),
          error: null,
        });
      }
      if (name !== "buscar_productos") {
        throw new Error(`Fake Supabase: rpc no soportada en este test: ${name}`);
      }
      const args = rawArgs as AppliedRpcArgs;
      appliedRpcArgs = args;
      rpcCalls.push(args);
      return Promise.resolve({ data: simularBuscarProductos(products, args), error: null });
    },
    from(table: string) {
      if (table === "conversation_quotes") {
        return {
          insert: (rows: Record<string, unknown>[]) => {
            insertedQuotes.push(...rows);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      // T5c (18/9/2026): sinónimos activos que `buildCatalogTool` lee antes
      // de armar los grupos. Vacío por defecto, para que el resto de los
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
                    limit: async (n: number) => {
                      appliedSynonymLimit = n;
                      return {
                        data: synonyms.filter(
                          (s) => (s.scope ?? "global") === "global" || s.conversationId === conversationId
                        ),
                        error: null,
                      };
                    },
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
    rpcCalls,
    correctorCalls,
    getAppliedRpcArgs: () => appliedRpcArgs,
    getAppliedSynonymFilter: () => appliedSynonymFilter,
    getAppliedSynonymLimit: () => appliedSynonymLimit,
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

    // T4 (25-26/9/2026, mismo plan): `formatQuote` suma "BCV" después del
    // dólar -- ver precio.ts/precio.test.ts.
    expect(result.results[0].precio).toBe("$18,50 BCV (Bs. 740,00)");
    expect(result.results[0]).not.toHaveProperty("precioUsd");
    expect(result.results[0]).not.toHaveProperty("precioBs");
  });

  /**
   * 27/9/2026 ("El mostrador busca sin salir del chat", D1/D3): un repuesto
   * cuyo precio real está en bolívares (Saint) se cotiza en dólares
   * redondeado hacia ARRIBA al siguiente múltiplo de $0,10, no al centavo
   * más cercano -- la misma regla que Inventario y el carrito del cierre de
   * venta. `getBcvRate` está mockeada en 40 (arriba, línea 4); 87 / 40 =
   * 2,175 sin redondear.
   */
  it("un repuesto en VES se cotiza en dólares redondeado hacia arriba al siguiente múltiplo de $0,10", async () => {
    const { client, insertedQuotes } = createFakeSupabase([
      {
        id: "prod-ves-1",
        name: "Carburador PZ27",
        brand: "Genérico",
        price: 87,
        currency: "VES",
        stock_quantity: 5,
      },
    ]);

    const tool = buildCatalogTool({
      // @ts-expect-error -- fake mínimo
      supabase: client,
      conversationId: "conv-1",
      contactId: "contact-1",
    }, nuevoCatalogOutcome());

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
      results: { precio: string }[];
    };

    expect(result.results[0].precio).toBe("$2,20 BCV (Bs. 87,00)");
    expect(insertedQuotes[0]).toMatchObject({ price_usd: 2.2, price_bs: 87, bcv_rate: 40 });
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
   * T2 (25-26/9/2026): el fake de `buscar_productos` (`createFakeSupabase`)
   * no ejecuta SQL de verdad —igual que antes con `.or()`—, así que la
   * forma correcta de probar la expansión es mirar el GRUPO que le llega en
   * `p_terminos` (`getAppliedRpcArgs`): con el sinónimo activo tiene que
   * traer el término real como alternativa, además de la jerga; sin él,
   * solo la jerga.
   */
  it("con el sinónimo activo, el grupo que le llega en p_terminos incluye el término real además de la jerga", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase(
      [
        {
          id: "prod-1",
          name: "Pastillas de freno Bera",
          brand: "Bera",
          price: 12,
          currency: "USD",
          stock_quantity: 4,
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
    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["pastilla", "pastillas de freno"]]);
  });

  it("sin ningún sinónimo cargado, el grupo solo trae la jerga tal cual la escribió el cliente", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase([
      {
        id: "prod-1",
        name: "Pastillas de freno Bera",
        brand: "Bera",
        price: 12,
        currency: "USD",
        stock_quantity: 4,
      },
    ]);

    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      nuevoCatalogOutcome()
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "pastilla" }, { toolCallId: "t1", messages: [] });

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["pastilla"]]);
  });

  /**
   * La consulta real (tools.ts) filtra `is_active = true`: un sinónimo
   * desactivado nunca debería llegar hasta acá. La segunda guarda —que
   * `catalogTermGroups` también ignore `isActive === false` si algo lo
   * pasara igual— se prueba a nivel de función pura en
   * catalog-search.test.ts ("un sinónimo inactivo no agrega ninguna
   * alternativa"), donde es más directo de armar sin fingir toda la cadena
   * de Supabase.
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
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
      // T2 (25-26/9/2026): con sinónimos vacíos, la búsqueda de "pastilla"
      // no encuentra nada — no hace falta simular una fila de verdad, este
      // test solo mira el filtro de `ai_lessons`.
      rpc: async () => ({ data: [], error: null }),
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
    const { client, getAppliedRpcArgs } = createFakeSupabase(
      [
        {
          id: "prod-1",
          name: "Pastillas de freno Bera",
          brand: "Bera",
          price: 12,
          currency: "USD",
          stock_quantity: 4,
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

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["pastilla"]]);
  });

  /**
   * F (20/9/2026): `MAX_SYNONYM_LESSONS` no se exporta (es privado de
   * tools.ts), así que el único modo de fijar su valor exacto es mirar el
   * tope que de verdad le llega a `.limit()` en la consulta de sinónimos.
   */
  it("pide como tope MAX_SYNONYM_LESSONS = 200 a la consulta de sinónimos", async () => {
    const { client, getAppliedSynonymLimit } = createFakeSupabase([]);

    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      nuevoCatalogOutcome()
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "pastilla" }, { toolCallId: "t1", messages: [] });

    expect(getAppliedSynonymLimit()).toBe(200);
  });

  it("un sinónimo 'solo este chat' de ESTA conversación SÍ expande la búsqueda", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase(
      [
        {
          id: "prod-1",
          name: "Pastillas de freno Bera",
          brand: "Bera",
          price: 12,
          currency: "USD",
          stock_quantity: 4,
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

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["pastilla", "pastillas de freno"]]);
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
    // T2 (25-26/9/2026): "a" sola no deja ningún término reconocible
    // (`catalogTermGroups` no tiene el fallback-a-la-frase-entera que sí
    // tiene `searchTerms`, ver catalog-search.ts) — se usa "repuesto", que
    // SÍ calza el nombre de los 200 productos del fixture.
    // T3a (28/9/2026): con la moto calzando la consulta NUNCA es genérica y
    // se cotiza (un genérico ya no entrega resultados, solo la pregunta).
    const muchos = Array.from({ length: 200 }, (_, i) => ({
      id: `prod-${i}`,
      name: `Repuesto Bera ${i}`,
      brand: "Genérico",
      price: 10,
      currency: "USD" as const,
      stock_quantity: 3,
    }));
    const { client, rpcCalls } = createFakeSupabase(muchos);

    const tool = buildCatalogTool({
      // @ts-expect-error -- fake mínimo suficiente para este test
      supabase: client,
      conversationId: "conv-1",
      contactId: "contact-1",
    }, nuevoCatalogOutcome());

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "repuesto", motoBrand: "bera" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      hayMas?: boolean;
    };

    // T1/T2 (25-26/9/2026): el orden y el recorte ya no los hace `tools.ts`
    // en memoria — se le pide a la base `p_limite = MAX_CATALOG_RESULTS`
    // (10) y `buscar_productos` es quien ordena TODO el conjunto de
    // candidatos antes de recortar (antes: `.limit(31)` SIN order, el bug
    // de origen de esta ola). La PRIMERA llamada pide 10.
    // 29/9/2026: con la moto calzando y más de una con existencia la
    // herramienta vuelve a pedir 50 (para elegir la de mayor existencia) y al
    // modelo le llega UNA sola (hotfix del 29/9/2026, decisión del operador),
    // no diez ni tres.
    expect(rpcCalls[0].p_limite).toBe(10);
    expect(result.results.length).toBe(1);
  });

  it("avisa al modelo cuando hubo que recortar, para que pida precisar", async () => {
    const muchos = Array.from({ length: 200 }, (_, i) => ({
      id: `prod-${i}`,
      name: `Repuesto Bera ${i}`,
      brand: "Genérico",
      price: 10,
      currency: "USD" as const,
      stock_quantity: 3,
    }));
    const { client } = createFakeSupabase(muchos);

    const tool = buildCatalogTool({
      // @ts-expect-error -- fake mínimo
      supabase: client,
      conversationId: "conv-1",
      contactId: "contact-1",
    }, nuevoCatalogOutcome());

    // @ts-expect-error -- firma simplificada
    const result = (await tool.execute({ query: "repuesto", motoBrand: "bera" }, { toolCallId: "t1", messages: [] })) as {
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
function producto(overrides: Partial<FakeRpcRow> & { id: string }): FakeRpcRow {
  return {
    name: "Carburador PZ27",
    brand: "Genérico",
    price: 18,
    currency: "USD",
    stock_quantity: 12,
    ...overrides,
  };
}

function haceDias(dias: number): string {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

async function cotizar(products: FakeRpcRow[]) {
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
  it("mide por lo que se cotiza: la mejor opción (la de más existencia) es la vieja aunque haya otra reciente", async () => {
    // Hotfix 29/9/2026: se cotiza UNA sola, la de mayor existencia; la
    // antigüedad se mide sobre esa, no sobre las que quedaron sin mostrar.
    const result = await cotizar([
      producto({ id: "prod-1", stock_quantity: 3, updated_at: haceDias(0) }),
      producto({ id: "prod-2", name: "Carburador PZ30", stock_quantity: 12, updated_at: haceDias(9) }),
    ]);

    expect(result.inventarioDesactualizado).toBe(true);
    expect(result.instruccionParaTuRespuesta).toMatch(/9 días/);
  });

  it("en una lista mide por el resultado más viejo de los cotizados, no por el más reciente", async () => {
    const { client } = createFakeSupabase([
      producto({ id: "prod-1", name: "Carburador PZ27", updated_at: haceDias(0) }),
      producto({ id: "prod-2", name: "Bujia NGK", updated_at: haceDias(9) }),
    ]);
    const tool = buildCatalogTool({
      // @ts-expect-error -- fake mínimo
      supabase: client,
      conversationId: "conv-1",
      contactId: "contact-1",
    }, nuevoCatalogOutcome());

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "", productos: ["carburador", "bujia"] }, { toolCallId: "t1", messages: [] })) as {
      inventarioDesactualizado?: boolean;
      instruccionParaTuRespuesta?: string;
    };

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
// T1, plan "La escalada se hace una vez y la búsqueda responde" (21/9/2026).
// Medido en producción el 21/9/2026: los dos únicos turnos donde
// `escalarAAsesor` se llamó DOS veces en el mismo turno gastaron 145.000
// tokens de entrada y ~65.800 de salida cada uno (0,108 USD, 5 min de
// redacción). `prepareStep`/`tool-choice.ts` (ver agent.ts) frena el paso
// SIGUIENTE, pero no cubre dos tool calls dentro del MISMO paso — acá se
// prueba que `buildEscalateTool.execute` corta esa segunda llamada por su
// cuenta, sin depender de `prepareStep`.
// ---------------------------------------------------------------------------
describe("buildEscalateTool — una escalada por turno (T1, 'La escalada se hace una vez y la búsqueda responde', 21/9/2026)", () => {
  beforeEach(() => {
    escalateConversationMock.mockReset();
  });

  it("la segunda llamada en el mismo turno NO llama a escalateConversation y devuelve el resultado de la primera", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: "María" });
    const outcome: EscalationOutcome = { escalated: false };
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo: la herramienta reenvía supabase tal
      // cual a escalateConversation, que está mockeado en este archivo.
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      outcome
    );

    const primerInput = { motivo: "intencion_compra" as const, resumen: "Quiere comprar un carburador" };
    // @ts-expect-error -- la firma real de `execute` de `ai` es más genérica que lo que necesitamos simular acá
    const primero = await tool.execute(primerInput, { toolCallId: "t1", messages: [] });

    // Segunda llamada del MISMO turno, con un motivo/resumen distintos: si
    // se ejecutara de nuevo, `escalateConversationMock` (con
    // `mockResolvedValue` fijo) devolvería lo mismo igual, así que lo que
    // prueba de verdad este test es el conteo de llamadas, no el contenido.
    const segundoInput = { motivo: "seguimiento" as const, resumen: "Insiste en el mismo pedido" };
    // @ts-expect-error -- idem
    const segundo = await tool.execute(segundoInput, { toolCallId: "t2", messages: [] });

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(segundo).toEqual(primero);
  });

  it("dos tool calls en el mismo paso (sin esperar la primera) también dejan una sola escalada real", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: "María" });
    const outcome: EscalationOutcome = { escalated: false };
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      outcome
    );
    const input = { motivo: "intencion_compra" as const, resumen: "Quiere comprar un carburador" };

    await Promise.all([
      // @ts-expect-error -- idem
      tool.execute(input, { toolCallId: "t1", messages: [] }),
      // @ts-expect-error -- idem
      tool.execute(input, { toolCallId: "t2", messages: [] }),
    ]);

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
  });

  it("deja escalada_repetida_en_el_turno en el log al repetir la llamada", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: "María" });
    const escrito: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      escrito.push(String(line));
    });
    const outcome: EscalationOutcome = { escalated: false };
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      outcome
    );
    const input = { motivo: "intencion_compra" as const, resumen: "Quiere comprar un carburador" };

    // @ts-expect-error -- idem
    await tool.execute(input, { toolCallId: "t1", messages: [] });
    // @ts-expect-error -- idem
    await tool.execute(input, { toolCallId: "t2", messages: [] });
    spy.mockRestore();

    const aviso = escrito.map((line) => JSON.parse(line)).find((l) => l.event === "escalada_repetida_en_el_turno");
    expect(aviso).toMatchObject({ level: "info", conversationId: "conv-1" });
  });
});

// ---------------------------------------------------------------------------
// T1, mismo plan (21/9/2026): tope de 600 caracteres en `resumen` — las dos
// espirales medidas en producción también inflaban este campo en cada
// llamada repetida. El esquema real (no una copia) es lo único que puede
// atrapar esto: llamar `tool.execute(...)` a mano no pasa por la validación
// de zod (mismo motivo que el describe de "el esquema acepta el motivo
// seguimiento", más arriba).
// ---------------------------------------------------------------------------
describe("buildEscalateTool — el resumen tiene tope de 600 caracteres (T1, 21/9/2026)", () => {
  function schemaDeResumen() {
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo: no se ejecuta nada, solo se lee el esquema.
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      { escalated: false }
    );
    return (tool as unknown as { inputSchema: { shape: { resumen: { parse: (v: unknown) => unknown } } } })
      .inputSchema.shape.resumen;
  }

  it("rechaza un resumen de 601 caracteres", () => {
    expect(() => schemaDeResumen().parse("a".repeat(601))).toThrow();
  });

  it("acepta un resumen de exactamente 600 caracteres", () => {
    expect(() => schemaDeResumen().parse("a".repeat(600))).not.toThrow();
  });

  /**
   * Corrección 4b de la revisión de T1 (21/9/2026): el `.max(600)` del
   * esquema existía, pero el `.describe()` no se lo decía al modelo — se
   * enteraba recién por un error de validación que le quema un paso del tool
   * loop. `.description` es la lectura real de zod (mismo patrón que el
   * resto de este archivo lee `.inputSchema.shape`).
   */
  it("el describe del campo avisa el tope de 600 caracteres", () => {
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo: no se ejecuta nada, solo se lee el esquema.
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      { escalated: false }
    );
    const schema = (tool as unknown as { inputSchema: { shape: { resumen: { description?: string } } } }).inputSchema
      .shape.resumen;

    expect(schema.description).toMatch(/600 caracteres/i);
  });
});

// ---------------------------------------------------------------------------
// T2, plan "La escalada se hace una vez y la búsqueda responde" (21/9/2026,
// D2 del operador). Medido en producción el 21/9/2026: con asesor ya
// asignado, el modelo repetía `escalarAAsesor` en cada mensaje del cliente
// (24 de 34 escaladas en la primera hora del deploy, donde bastaban 9) —
// `escalate.ts` lo detectaba (rama `alreadyAssigned`) pero la vuelta
// completa al proveedor ya se había pagado. `buildEscalateTool` acepta ahora
// un tercer parámetro (`{ restrictedToPurchase: true }`, que `agent.ts` pasa
// cuando el chat ya tiene asesor) que recorta el enum de `motivo` a
// `intencion_compra` — el modelo no puede siquiera intentar escalar con otro
// motivo, el esquema lo rechaza antes de llegar a `execute`.
// ---------------------------------------------------------------------------
describe("buildEscalateTool — modo restringido con asesor asignado (T2, 21/9/2026)", () => {
  beforeEach(() => {
    escalateConversationMock.mockReset();
  });

  function schemaDeMotivoRestringido() {
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo: no se ejecuta nada, solo se lee el esquema.
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      { escalated: false },
      { restrictedToPurchase: true }
    );
    return (tool as unknown as { inputSchema: { shape: { motivo: { parse: (v: unknown) => unknown } } } })
      .inputSchema.shape.motivo;
  }

  it("el esquema SOLO acepta intencion_compra: rechaza los seis motivos restantes", () => {
    const schema = schemaDeMotivoRestringido();

    expect(() => schema.parse("intencion_compra")).not.toThrow();
    expect(() => schema.parse("devolucion")).toThrow();
    expect(() => schema.parse("queja")).toThrow();
    expect(() => schema.parse("seguimiento")).toThrow();
    expect(() => schema.parse("confirmar_inventario")).toThrow();
    expect(() => schema.parse("sin_stock")).toThrow();
    expect(() => schema.parse("no_identificado")).toThrow();
  });

  it("sin restrictedToPurchase (u omitido), el esquema conserva los siete motivos de siempre", () => {
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      { escalated: false }
    );
    const schema = (tool as unknown as { inputSchema: { shape: { motivo: { parse: (v: unknown) => unknown } } } })
      .inputSchema.shape.motivo;

    for (const motivo of [
      "devolucion",
      "queja",
      "intencion_compra",
      "seguimiento",
      "confirmar_inventario",
      "sin_stock",
      "no_identificado",
    ]) {
      expect(() => schema.parse(motivo)).not.toThrow();
    }
  });

  it("la descripción de la herramienta avisa que el chat ya tiene asesor y que es solo para marcar la compra", () => {
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      { escalated: false },
      { restrictedToPurchase: true }
    );

    expect((tool as unknown as { description: string }).description).toMatch(/ya tiene un asesor/i);
    expect((tool as unknown as { description: string }).description).toMatch(/intencion_compra|quiere comprar/i);
  });

  it("intencion_compra en modo restringido escala igual que siempre (reenvía a escalateConversation)", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: "María", alreadyAssigned: true });
    const outcome: EscalationOutcome = { escalated: false };
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      outcome,
      { restrictedToPurchase: true }
    );

    const input = { motivo: "intencion_compra" as const, resumen: "Confirmó que quiere comprar el carburador" };
    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute(input, { toolCallId: "t1", messages: [] })) as { escalated: boolean };

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(result.escalated).toBe(true);
    expect(outcome.escalated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Corrección 4a de la revisión de T1 (21/9/2026): hasta acá `pending` quedaba
// cacheado PARA SIEMPRE en cuanto la primera llamada terminaba, sin mirar si
// de verdad escaló. Si `escalateConversation` lanzaba (o algún día devolviera
// `escalated: false`), un segundo intento legítimo del modelo en el MISMO
// turno se topaba con la promesa rota/negativa de la primera, sin poder
// volver a intentarlo — la única "segunda vuelta" posible quedaba tapada por
// un error transitorio de la primera.
// ---------------------------------------------------------------------------
describe("buildEscalateTool — pending se libera si la primera escalada no cuajó (corrección 4a, 21/9/2026)", () => {
  beforeEach(() => {
    escalateConversationMock.mockReset();
  });

  it("si la primera llamada LANZA, un segundo intento vuelve a llamar a escalateConversation", async () => {
    escalateConversationMock
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ escalated: true, assignedAgentName: "María" });
    const outcome: EscalationOutcome = { escalated: false };
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      outcome
    );
    const input = { motivo: "intencion_compra" as const, resumen: "Quiere comprar un carburador" };

    // @ts-expect-error -- idem
    await expect(tool.execute(input, { toolCallId: "t1", messages: [] })).rejects.toThrow("fetch failed");

    // @ts-expect-error -- idem
    const segundo = (await tool.execute(input, { toolCallId: "t2", messages: [] })) as { escalated: boolean };

    expect(escalateConversationMock).toHaveBeenCalledTimes(2);
    expect(segundo.escalated).toBe(true);
    expect(outcome.escalated).toBe(true);
  });

  it("si la primera llamada devuelve escalated: false, un segundo intento vuelve a llamar a escalateConversation", async () => {
    escalateConversationMock
      .mockResolvedValueOnce({ escalated: false })
      .mockResolvedValueOnce({ escalated: true, assignedAgentName: "María" });
    const outcome: EscalationOutcome = { escalated: false };
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      outcome
    );
    const input = { motivo: "intencion_compra" as const, resumen: "Quiere comprar un carburador" };

    // @ts-expect-error -- idem
    const primero = (await tool.execute(input, { toolCallId: "t1", messages: [] })) as { escalated: boolean };
    // @ts-expect-error -- idem
    const segundo = (await tool.execute(input, { toolCallId: "t2", messages: [] })) as { escalated: boolean };

    expect(primero.escalated).toBe(false);
    expect(segundo.escalated).toBe(true);
    expect(escalateConversationMock).toHaveBeenCalledTimes(2);
  });

  it("mientras la primera llamada SÍ cuajó (escalated: true), una segunda sigue cacheada (regresión del test de T1)", async () => {
    escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: "María" });
    const outcome: EscalationOutcome = { escalated: false };
    const tool = buildEscalateTool(
      // @ts-expect-error -- fake mínimo
      { supabase: {}, conversationId: "conv-1", contactId: "contact-1" },
      outcome
    );
    const input = { motivo: "intencion_compra" as const, resumen: "Quiere comprar un carburador" };

    // @ts-expect-error -- idem
    await tool.execute(input, { toolCallId: "t1", messages: [] });
    // @ts-expect-error -- idem
    await tool.execute(input, { toolCallId: "t2", messages: [] });

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
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

  /** Un Supabase falso cuyo `rpc("buscar_productos", ...)` termina en error, en vez de datos. */
  function createFailingCatalogSupabase() {
    return {
      // T5c (18/9/2026): la consulta de sinónimos corre ANTES que el rpc —
      // sin este handler, este test rompería por una tabla "no soportada"
      // antes de llegar siquiera a simular el fallo real.
      from(table: string) {
        if (table === "ai_lessons") {
          return {
            select: () => ({
              eq: () => ({ eq: () => ({ or: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
            }),
          };
        }
        throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
      },
      // T2 (25-26/9/2026): reemplaza al viejo `.from("products")...` — el
      // error ahora sale del rpc.
      rpc: async () => ({ data: null, error: { message: "boom" } }),
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

    // T2 (25-26/9/2026): a diferencia de `searchTerms` (que cae a la frase
    // entera si no queda ningún término, para no perder "R6"),
    // `catalogTermGroups` NO tiene ese fallback — una consulta en blanco no
    // deja ningún grupo.
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
  function repuestosGenericos(cantidad: number): FakeRpcRow[] {
    return Array.from({ length: cantidad }, (_, i) => ({
      id: `prod-${i}`,
      name: `Pastilla de freno ${i}`,
      brand: "Genérico",
      price: 10,
      currency: "USD" as const,
      stock_quantity: 5,
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

    // T3a (28/9/2026): cuál de las dos preguntas la decide el CÓDIGO con
    // `dependeDeLaMoto` (antes se la dejaba elegir al modelo). Las pastillas
    // de freno dependen de la moto.
    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "pastilla", dependeDeLaMoto: true }, { toolCallId: "t1", messages: [] })) as {
      instruccionParaTuRespuesta?: string;
    };

    expect(result.instruccionParaTuRespuesta).toContain(PREGUNTA_FILTRO);
    expect(result.instruccionParaTuRespuesta).not.toContain(PREGUNTA_FILTRO_PRODUCTO);
    expect(result.instruccionParaTuRespuesta).toMatch(/no escales/i);
    expect(result.instruccionParaTuRespuesta).toMatch(/no afirmes que hay existencia/i);
    expect(result.instruccionParaTuRespuesta).not.toMatch(/escalarAAsesor/);
    expect(catalogOutcome.generico).toBe(true);
    expect(catalogOutcome.conExistencia).toBe(false);
  });

  /**
   * F (20/9/2026, "El resguardo antes del push"): con genérico Y recorte a la
   * vez (más de 10 repuestos calzan), la instrucción del caso ya dice "no
   * listes, pregunta primero" — avisar "hay más" ENCIMA de eso contradice el
   * propio pedido. El `!generico &&` de la condición del recorte es lo que
   * calla ese aviso quando el turno ya va a preguntar; sin él, el modelo
   * recibiría las dos instrucciones a la vez.
   */
  it("genérico y con recorte a la vez: la instrucción de filtro NO se acompaña del aviso de recorte", async () => {
    const { client } = createFakeSupabase(repuestosGenericos(15));
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "pastilla", dependeDeLaMoto: true }, { toolCallId: "t1", messages: [] })) as {
      instruccionParaTuRespuesta?: string;
      hayMas?: boolean;
    };

    expect(result.hayMas).toBe(true);
    expect(catalogOutcome.generico).toBe(true);
    expect(result.instruccionParaTuRespuesta).toContain(PREGUNTA_FILTRO);
    expect(result.instruccionParaTuRespuesta).not.toMatch(/Hay más resultados de los que caben/i);
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

  /**
   * F (20/9/2026): "más de tres" es `> 3`, no `>= 3` — con EXACTAMENTE tres
   * resultados (y sin recorte, porque tres no pasa el tope de diez) el caso
   * sigue sin ser genérico. El test de arriba usa dos resultados y no
   * ejercita este borde.
   */
  it("con EXACTAMENTE tres resultados, no es genérico (el corte es 'más de tres', no 'tres o más')", async () => {
    const { client } = createFakeSupabase(repuestosGenericos(3));
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "pastilla" }, { toolCallId: "t1", messages: [] })) as {
      hayMas?: boolean;
    };

    expect(result.hayMas).toBe(false);
    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.conExistencia).toBe(true);
  });

  /**
   * T2, plan "La búsqueda encuentra lo que el cliente pide" (25-26/9/2026,
   * corrección del operador sobre la moto): REEMPLAZA a la regla vieja ("con
   * motoModel/motoBrand dados NUNCA es genérico"). Si el cliente dio una
   * moto pero NINGUNO de los repuestos que más calzan la nombra, la moto no
   * sirve para filtrar y se ignora — con más de tres coincidencias SIGUE
   * siendo genérico, solo que ahora el texto fijo es
   * `PREGUNTA_FILTRO_PRODUCTO` (no tiene sentido volver a preguntar la
   * moto que el cliente ya dio) y NUNCA `PREGUNTA_FILTRO`.
   */
  it("con motoModel dado pero que ninguna fila del máximo nombra (moto ignorada) y más de tres coincidencias: sigue siendo genérico, con PREGUNTA_FILTRO_PRODUCTO y SIN PREGUNTA_FILTRO", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase(repuestosGenericos(5));
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // Ninguna "Pastilla de freno N" del fixture nombra "SBR 200": la moto
    // no calza ninguna fila del máximo, así que se ignora.
    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "pastilla", motoModel: "SBR 200" }, { toolCallId: "t1", messages: [] })) as {
      instruccionParaTuRespuesta?: string;
    };

    // T3a (28/9/2026): "SBR 200" ya no llega entero como moto -- `catalogQuery`
    // separa la moto CON NOMBRE ("sbr") de la cilindrada ("200"), y solo la
    // primera puede volver verdadera la coincidencia de moto.
    expect(getAppliedRpcArgs()?.p_moto).toEqual([["sbr"]]);
    expect(getAppliedRpcArgs()?.p_cilindrada).toEqual([["200"]]);
    expect(catalogOutcome.generico).toBe(true);
    expect(catalogOutcome.conExistencia).toBe(false);
    expect(result.instruccionParaTuRespuesta).toContain(PREGUNTA_FILTRO_PRODUCTO);
    expect(result.instruccionParaTuRespuesta).not.toContain(PREGUNTA_FILTRO);
    expect(result.instruccionParaTuRespuesta).toMatch(/no escales/i);
  });

  it("con motoBrand dado pero ignorado (ninguna fila del máximo lo nombra) y más de tres coincidencias, también sigue siendo genérico", async () => {
    const { client } = createFakeSupabase(repuestosGenericos(5));
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "pastilla", motoBrand: "Bera" }, { toolCallId: "t1", messages: [] });

    expect(catalogOutcome.generico).toBe(true);
  });

  /**
   * T2 (25-26/9/2026): la moto SÍ calza en una de las filas del máximo —
   * "cotiza igual que sin moto" sería el resultado sin moto (genérico, 5
   * coincidencias); acá, con la moto calzando, NUNCA es genérico y la
   * pregunta desaparece del todo: el cliente ya filtró lo que pudo.
   */
  it("con motoModel que SÍ nombra una de las filas del máximo, no es genérico: cotiza y escala con confirmar_inventario", async () => {
    const conMoto: FakeRpcRow[] = [
      ...repuestosGenericos(5),
      { id: "prod-bera", name: "Pastilla de freno Bera SBR 200", brand: "Bera", price: 10, currency: "USD", stock_quantity: 5 },
    ];
    const { client, getAppliedRpcArgs } = createFakeSupabase(conMoto);
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

    // Mismo motivo que el test anterior (T3a, 28/9/2026).
    expect(getAppliedRpcArgs()?.p_moto).toEqual([["sbr"]]);
    expect(getAppliedRpcArgs()?.p_cilindrada).toEqual([["200"]]);
    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_CONFIRMAR_INVENTARIO);
  });
});

/**
 * T2, plan "La búsqueda encuentra lo que el cliente pide" (25-26/9/2026):
 * la decisión completa de `buildCatalogTool` sobre lo que devuelve
 * `buscar_productos` — la tolerancia N/N-1, la restricción por
 * `puntaje_moto_maximo` (corrección del operador) y que una fila con
 * puntaje menor al máximo nunca se cotiza.
 */
describe("buildCatalogTool — la decisión sobre lo que trae buscar_productos (T2, 25-26/9/2026)", () => {
  /**
   * Mutación manual (c) del plan: la fila de puntaje máximo va junto a
   * CUATRO "vecinas" que solo calzan "motul" (puntaje 1, menor al máximo) —
   * `buscar_productos` las devolvería igual (puntaje > 0), y son las que
   * distinguen el código correcto ("cotiza SOLO la de puntaje máximo") de
   * la lógica vieja que este plan reemplaza ("cotiza TODO lo que la base
   * trajo, sin filtrar por puntaje", que habría contado 5 filas como
   * `quoted` y disparado el genérico). Ver la sección de mutaciones del
   * reporte.
   */
  it("'motul 5100 20w50' con 1 fila de puntaje máximo (y ruido de puntaje menor): cotiza SOLO la del máximo, no es genérico", async () => {
    const { client, getAppliedRpcArgs, insertedQuotes } = createFakeSupabase([
      { id: "prod-1", name: "Aceite Motul 5100 20W50", brand: "Motul", price: 18, currency: "USD", stock_quantity: 6 },
      { id: "ruido-1", name: "Aceite Motul 4T", brand: "Motul", price: 8, currency: "USD", stock_quantity: 6 },
      { id: "ruido-2", name: "Filtro de aceite Motul", brand: "Motul", price: 5, currency: "USD", stock_quantity: 6 },
      { id: "ruido-3", name: "Guante de taller Motul", brand: "Motul", price: 4, currency: "USD", stock_quantity: 6 },
      { id: "ruido-4", name: "Gorra Motul", brand: "Motul", price: 6, currency: "USD", stock_quantity: 6 },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "motul 5100 20w50" }, { toolCallId: "t1", messages: [] })) as {
      results: { nombre: string }[];
    };

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["motul"], ["5100"], ["20w50"]]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].nombre).toBe("Aceite Motul 5100 20W50");
    expect(insertedQuotes).toHaveLength(1);
    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.conExistencia).toBe(true);
  });

  it("'pastillas de freno' con 5 filas de puntaje máximo, sin moto: genérico, y p_moto va vacío", async () => {
    const cinco: FakeRpcRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `prod-${i}`,
      name: `Pastillas de freno modelo ${i}`,
      brand: "Genérico",
      price: 10,
      currency: "USD" as const,
      stock_quantity: 5,
    }));
    const { client, getAppliedRpcArgs } = createFakeSupabase(cinco);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "pastillas de freno" }, { toolCallId: "t1", messages: [] });

    expect(getAppliedRpcArgs()?.p_moto).toEqual([]);
    expect(catalogOutcome.generico).toBe(true);
  });

  it("la misma consulta con motoModel 'sbr', con una fila que la nombra: no es genérico y p_moto lleva la moto", async () => {
    const filas: FakeRpcRow[] = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `prod-${i}`,
        name: `Pastillas de freno modelo ${i}`,
        brand: "Genérico",
        price: 10,
        currency: "USD" as const,
        stock_quantity: 5,
      })),
      { id: "prod-sbr", name: "Pastillas de freno SBR", brand: "Bera", price: 10, currency: "USD", stock_quantity: 5 },
    ];
    const { client, getAppliedRpcArgs } = createFakeSupabase(filas);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    await tool.execute({ query: "pastillas de freno", motoModel: "sbr" }, { toolCallId: "t1", messages: [] });

    expect(getAppliedRpcArgs()?.p_moto).toEqual([["sbr"]]);
    expect(catalogOutcome.generico).toBe(false);
  });

  /**
   * (a) Corrección del operador sobre la moto: con la moto calzando SOLO en
   * una de las filas del máximo puntaje, se cotiza ÚNICAMENTE esa fila — no
   * las otras cuatro que también son pastillas de freno pero no son de esa
   * moto.
   */
  it("(a) 5 pastillas de freno, una BERA, con motoBrand bera: cotiza SOLO la BERA", async () => {
    const filas: FakeRpcRow[] = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `prod-${i}`,
        name: `Pastillas de freno genéricas ${i}`,
        brand: "Genérico",
        price: 10,
        currency: "USD" as const,
        stock_quantity: 5,
      })),
      { id: "prod-bera", name: "Pastillas de freno Bera", brand: "Bera", price: 12, currency: "USD", stock_quantity: 3 },
    ];
    const { client, insertedQuotes } = createFakeSupabase(filas);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "pastillas de freno", motoBrand: "bera" }, { toolCallId: "t1", messages: [] })) as {
      results: { nombre: string }[];
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0].nombre).toBe("Pastillas de freno Bera");
    expect(catalogOutcome.generico).toBe(false);
    expect(insertedQuotes).toHaveLength(1);
  });

  /**
   * (b) La moto llegó (motoModel "kavak"), pero NINGÚN aceite del fixture la
   * nombra — se ignora por completo y se cotiza igual que si no hubiera
   * llegado ninguna moto (acá, un solo resultado: no es genérico).
   */
  it("(b) 'aceite motul 5100' con motoModel kavak y ningún aceite Kavak: cotiza igual que sin moto", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase([
      { id: "prod-1", name: "Aceite Motul 5100", brand: "Motul", price: 15, currency: "USD", stock_quantity: 8 },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "aceite motul 5100", motoModel: "kavak" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
    };

    expect(getAppliedRpcArgs()?.p_moto).toEqual([["kavak"]]);
    expect(result.results).toHaveLength(1);
    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.conExistencia).toBe(true);
  });

  it("puntaje_maximo por debajo de lo requerido: no_identificado, sin cotizar nada", async () => {
    // "aceite motul 5100" -> 3 grupos, requerido = 3 (N <= 3). Se fuerza a
    // mano un puntaje de 2 -- ninguna fila real calzaría los 3 términos y
    // dejaría solo 2, pero acá se controla explícito para no depender de
    // qué nombre exacto produce ese puntaje con el auto-cálculo.
    const { client } = createFakeSupabase([
      { id: "prod-1", name: "Aceite Motul", brand: "Motul", price: 15, currency: "USD", stock_quantity: 8, puntaje: 2 },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "aceite motul 5100" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      instruccionParaTuRespuesta?: string;
    };

    expect(result.results).toEqual([]);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_NO_IDENTIFICADO);
    expect(catalogOutcome.sinResultados).toBe(true);
  });

  /**
   * T3a (28/9/2026): REEMPLAZA a la tolerancia N-1 ("con cuatro grupos o más
   * alcanza que calcen N-1"). Esa tolerancia descartaba la MARCA: "defensa
   * gxs 250" cotizaba una DEFENSA BRZ 250 porque calzaba "defensa" y "250".
   * Ahora `requerido = grupos.length`, siempre — lo que se puede descartar
   * sin perder el producto (colores, "semi", "delantero"…) ya no es
   * obligatorio, lo decide `catalogQuery` (T1), no una tolerancia ciega.
   */
  it("sin N-1: con CUATRO grupos y el máximo en tres, no cotiza (no_identificado)", async () => {
    // "aceite motor 20w50 inca" -> 4 grupos obligatorios (aceite, motor,
    // 20w50, inca). Las dos marcas que hay calzan 3 de 4: el catálogo no
    // tiene el Inca que el cliente pidió, y cotizarle otra marca es mentirle.
    const { client, insertedQuotes } = createFakeSupabase([
      { id: "castrol", name: "Aceite motor Castrol 20W50", brand: "Castrol", price: 9, currency: "USD", stock_quantity: 8 },
      { id: "ipone", name: "Aceite motor Ipone 20W50", brand: "Ipone", price: 10, currency: "USD", stock_quantity: 8 },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "aceite motor 20w50 inca" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      instruccionParaTuRespuesta?: string;
    };

    expect(result.results).toEqual([]);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_NO_IDENTIFICADO);
    expect(catalogOutcome.sinResultados).toBe(true);
    expect(catalogOutcome.conExistencia).toBe(false);
    expect(catalogOutcome.cotizacion).toEqual([]);
    expect(insertedQuotes).toHaveLength(0);
  });

  /**
   * El caso real "aceite 20w50 semi sintetico inca" (estudio del VPS,
   * 25-28/9/2026): "semi" y "sintetico" son descriptivas (opcionales), así
   * que el Inca 3 de 3 calza y las otras dos marcas (2 de 3) se quedan
   * fuera — se cotiza SOLO el Inca.
   */
  it("caso Inca: 'aceite 20w50 semi sintetico inca' cotiza el Inca aunque el nombre no diga 'semi sintetico'", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase([
      { id: "castrol", name: "Aceite Castrol 20W50 semi sintetico", brand: "Castrol", price: 9, currency: "USD", stock_quantity: 8 },
      { id: "ipone", name: "Aceite Ipone 20W50 semi sintetico", brand: "Ipone", price: 10, currency: "USD", stock_quantity: 8 },
      { id: "inca", name: "Aceite Inca 20W50 4T", brand: "Inca", price: 7, currency: "USD", stock_quantity: 12 },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "aceite 20w50 semi sintetico inca" }, { toolCallId: "t1", messages: [] })) as {
      results: { nombre: string }[];
    };

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["aceite"], ["20w50"], ["inca"]]);
    expect(getAppliedRpcArgs()?.p_opcionales).toEqual([["semi"], ["sintetico"]]);
    expect(result.results.map((r) => r.nombre)).toEqual(["Aceite Inca 20W50 4T"]);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(catalogOutcome.generico).toBe(false);
  });

  it("N=3 con puntaje máximo 2: no_identificado (sin la tolerancia, exige que calcen todos)", async () => {
    const { client } = createFakeSupabase([
      { id: "prod-1", name: "Aceite Motul", brand: "Motul", price: 15, currency: "USD", stock_quantity: 8, puntaje: 2 },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "aceite motul 5100" }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
    };

    expect(result.results).toEqual([]);
    expect(catalogOutcome.sinResultados).toBe(true);
  });

  it("una fila con puntaje menor que el máximo no se cotiza", async () => {
    const { client } = createFakeSupabase([
      { id: "prod-1", name: "Carburador PZ27", brand: "Genérico", price: 18, currency: "USD", stock_quantity: 12, puntaje: 1 },
      { id: "prod-2", name: "Carburador PZ30 repuesto", brand: "Genérico", price: 20, currency: "USD", stock_quantity: 6, puntaje: 2 },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "carburador" }, { toolCallId: "t1", messages: [] })) as {
      results: { nombre: string }[];
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0].nombre).toBe("Carburador PZ30 repuesto");
  });
});

/**
 * K2 (20/9/2026): corrige un efecto colateral de K (commit 3d96863, "Seba
 * consulta el inventario antes de hablar de existencias"). Caso a mano del
 * mismo día, +584140000012: el cliente reabrió un chat con "hola, otra
 * consulta"; el clasificador lo marcó consulta_disponibilidad (la confusión
 * consulta_disponibilidad↔otro es el desacuerdo dominante del clasificador,
 * ver CLAUDE.md); K obligó al paso 0 a llamar a buscarRepuesto SIN que el
 * cliente hubiera nombrado ningún repuesto; la herramienta devolvió sin
 * resultados y la red de seguridad de agent.ts escaló con no_identificado
 * ("no especificó qué repuesto..."), quemando un asesor por un mensaje vago
 * que antes de K la IA respondía preguntando qué necesita.
 */
describe("buildCatalogTool — el cliente todavía no nombró repuesto (K2, 20/9/2026)", () => {
  it("con la bandera y sin ningún término real en el query, NO consulta products ni sinónimos, y marca generico (no sinResultados)", async () => {
    const { client, getAppliedRpcArgs, getAppliedSynonymFilter } = createFakeSupabase([]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "", clienteNoNombroRepuesto: true }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      instruccionParaTuRespuesta?: string;
    };

    expect(result.results).toEqual([]);
    expect(result.instruccionParaTuRespuesta).toBe(PREGUNTA_QUE_BUSCA_INSTRUCTION);
    expect(catalogOutcome.ran).toBe(true);
    expect(catalogOutcome.generico).toBe(true);
    expect(catalogOutcome.sinResultados).toBe(false);
    // Ni el catálogo ni los sinónimos se consultaron: el corte pasa ANTES.
    expect(getAppliedRpcArgs()).toBeNull();
    expect(getAppliedSynonymFilter()).toBeNull();
  });

  /**
   * K2b (20/9/2026): esta precedencia REEMPLAZA a la de K2 ("si el `query`
   * trae un término real, se BUSCA y la bandera se ignora"). Medido contra
   * el modelo real (gemini-3.1-flash-lite, conversación local del
   * +584140000032, "buenas, tienen disponible?", consulta_disponibilidad):
   * `query` es un string OBLIGATORIO del esquema, así que el modelo INVENTA
   * un texto para rellenarlo aunque marque la bandera —se vio en el log
   * temporal el argumento exacto `{"query":"repuesto genérico",
   * "clienteNoNombroRepuesto":true}"`—, y con la precedencia vieja eso
   * bastaba para que "repuesto"/"genérico" calzaran productos reales del
   * catálogo: Seba cotizó carburador/filtros/pastillas al azar y escaló con
   * confirmar_inventario. Justo el riesgo que K2 había anunciado sin
   * corregir. Ahora la bandera gana SIEMPRE, sin mirar `terms`: el riesgo
   * residual aceptado es que un modelo que la marque por error con un
   * producto de verdad en el query (el caso del casco LS2) haga que Seba
   * pregunte "¿qué buscas?" en vez de buscar — molesto (el cliente lo
   * repite) pero inofensivo, frente a cotizar al azar y quemar un asesor.
   */
  it("con la bandera y un query inventado con palabras que calzarían productos reales, NO consulta products y pregunta igual", async () => {
    const { client, getAppliedRpcArgs, getAppliedSynonymFilter } = createFakeSupabase([
      {
        id: "prod-1",
        name: "Carburador Genérico",
        brand: "Genérico",
        price: 18,
        currency: "USD",
        stock_quantity: 4,
      },
      {
        id: "prod-2",
        name: "Filtro de aire repuesto universal",
        brand: "Genérico",
        price: 6,
        currency: "USD",
        stock_quantity: 10,
      },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // Mismo texto que el modelo real mandó ese día: "repuesto genérico" NO
    // es lo que el cliente dijo, es lo que el modelo inventó para llenar el
    // campo obligatorio — y calza los dos productos del fake de arriba.
    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "repuesto genérico", clienteNoNombroRepuesto: true }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      instruccionParaTuRespuesta?: string;
    };

    expect(getAppliedRpcArgs()).toBeNull();
    expect(getAppliedSynonymFilter()).toBeNull();
    expect(result.results).toEqual([]);
    expect(result.instruccionParaTuRespuesta).toBe(PREGUNTA_QUE_BUSCA_INSTRUCTION);
    expect(catalogOutcome.ran).toBe(true);
    expect(catalogOutcome.generico).toBe(true);
    expect(catalogOutcome.sinResultados).toBe(false);
  });

  /**
   * Riesgo residual aceptado por K2b (ver el comentario del test de arriba
   * y el de `PREGUNTA_QUE_BUSCA_INSTRUCTION` en tools.ts): si el modelo
   * marca la bandera CON un producto de verdad en el query ("casco LS2"),
   * ya no se busca — Seba pregunta igual. Documentado a propósito, no es un
   * bug: el `.describe` de la bandera le dice al modelo que nunca la marque
   * si nombró un producto; si igual lo hace, preguntar es el costo elegido
   * frente a cotizar al azar.
   */
  it("con la bandera Y un query con un producto real, también pregunta: prioridad total de la bandera", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase([
      {
        id: "prod-1",
        name: "Casco LS2",
        brand: "LS2",
        price: 80,
        currency: "USD",
        stock_quantity: 3,
      },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = buildCatalogTool(
      // @ts-expect-error -- fake mínimo
      { supabase: client, conversationId: "conv-1", contactId: "contact-1" },
      catalogOutcome
    );

    // @ts-expect-error -- firma simplificada del test
    const result = (await tool.execute({ query: "casco LS2", clienteNoNombroRepuesto: true }, { toolCallId: "t1", messages: [] })) as {
      results: unknown[];
      instruccionParaTuRespuesta?: string;
    };

    expect(getAppliedRpcArgs()).toBeNull();
    expect(result.results).toEqual([]);
    expect(result.instruccionParaTuRespuesta).toBe(PREGUNTA_QUE_BUSCA_INSTRUCTION);
    expect(catalogOutcome.generico).toBe(true);
  });

  /**
   * (3) del punto "a" de la tarea original K2: sin la bandera el
   * comportamiento tiene que ser IDÉNTICO al de hoy. No se duplica un caso
   * nuevo — el test "sin términos de búsqueda reconocibles (query muy
   * corta)..." de más arriba (describe "sin resultados, escala con
   * no_identificado") ya ejercita exactamente este camino (`query: "   "`,
   * sin `clienteNoNombroRepuesto`) y sirve de testigo.
   */
});

describe("buildCatalogTool — el CatalogOutcome se acumula entre llamadas del mismo turno", () => {
  /** Un fake cuyo `rpc("buscar_productos", ...)` devuelve una lista distinta en cada llamada, en el orden dado. */
  function createSequencedFakeSupabase(secuencia: FakeRpcRow[][]) {
    let llamada = 0;
    return {
      rpc: async (name: string, args: AppliedRpcArgs) => {
        if (name !== "buscar_productos") {
          throw new Error(`Fake Supabase: rpc no soportada en este test: ${name}`);
        }
        const products = secuencia[llamada] ?? [];
        llamada += 1;
        return { data: simularBuscarProductos(products, args), error: null };
      },
      from(table: string) {
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

// ---------------------------------------------------------------------------
// T3a, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026): la herramienta usa `catalogQuery` (T1), ya no
// tolera N-1, decide "genérico" mirando el stock, recuerda el pedido en Redis
// (una sola pregunta por pedido, respuestas sueltas), y admite listas.
// ---------------------------------------------------------------------------
interface ResultadoCatalogo {
  results: { nombre: string; precio: string; stock: number }[];
  hayMas?: boolean;
  instruccionParaTuRespuesta?: string;
  porProducto?: {
    producto: string;
    estado: string;
    results: { nombre: string; precio: string; stock: number }[];
  }[];
}

function herramienta(
  client: unknown,
  outcome: CatalogOutcome,
  extra: { rafagaCliente?: string[]; conversationId?: string } = {}
) {
  return buildCatalogTool(
    // @ts-expect-error -- fake mínimo
    { supabase: client, conversationId: extra.conversationId ?? "conv-1", contactId: "contact-1", rafagaCliente: extra.rafagaCliente },
    outcome
  );
}

async function correr(tool: ReturnType<typeof buildCatalogTool>, input: Record<string, unknown>): Promise<ResultadoCatalogo> {
  // @ts-expect-error -- firma simplificada del test
  return (await tool.execute(input, { toolCallId: "t1", messages: [] })) as ResultadoCatalogo;
}

/** El pedido que la herramienta dejó en Redis para esa conversación, o null. */
async function pedidoGuardado(conversationId = "conv-1"): Promise<Record<string, unknown> | null> {
  const raw = await (redisEstado.redis as FakeRedis).get(`catalogo:pedido:${conversationId}`);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

function fila(id: string, name: string, stock = 5, price = 10): FakeRpcRow {
  return { id, name, brand: "Genérico", price, currency: "USD", stock_quantity: stock };
}

describe("buildCatalogTool — la moto se normaliza siempre (T3a)", () => {
  it("'asiento sbr' hace la MISMA llamada a buscar_productos que 'asiento' + motoModel 'sbr'", async () => {
    const a = createFakeSupabase([fila("a1", "Asiento SBR")]);
    await correr(herramienta(a.client, nuevoCatalogOutcome()), { query: "asiento sbr" });

    const b = createFakeSupabase([fila("a1", "Asiento SBR")]);
    await correr(herramienta(b.client, nuevoCatalogOutcome()), { query: "asiento", motoModel: "sbr" });

    expect(a.getAppliedRpcArgs()).toEqual(b.getAppliedRpcArgs());
    expect(a.getAppliedRpcArgs()).toEqual({
      p_terminos: [["asiento"]],
      p_opcionales: [],
      p_moto: [["sbr"]],
      p_cilindrada: [],
      p_limite: 10,
    });
  });

  it("motoBrand + motoModel se suman como moto CON NOMBRE, y su cilindrada va aparte", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase([fila("a1", "Bateria Bera Socialista 200")]);
    await correr(herramienta(client, nuevoCatalogOutcome()), {
      query: "bateria",
      motoBrand: "Bera",
      motoModel: "Socialista 200",
    });

    expect(getAppliedRpcArgs()?.p_moto).toEqual([["bera"], ["socialista"]]);
    expect(getAppliedRpcArgs()?.p_cilindrada).toEqual([["200"]]);
  });

  it("los opcionales (colores, 'delantero') viajan aparte y no exigen nada al producto", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase([fila("r1", "Rin trasero Bera")]);
    await correr(herramienta(client, nuevoCatalogOutcome()), { query: "rin trasero negro" });

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["rin"]]);
    expect(getAppliedRpcArgs()?.p_opcionales).toEqual([["trasero"], ["negro"]]);
  });
});

describe("buildCatalogTool — la cilindrada nunca vuelve verdadera la coincidencia de moto (T3a)", () => {
  /** Cuatro defensas de motos distintas: ninguna es de una GXS, y solo una lleva el 250. */
  const defensas = [
    fila("brz", "DEFENSA BRZ 250"),
    fila("ava", "DEFENSA AVA MUSTANG 200"),
    fila("horse", "DEFENSA HORSE 150"),
    fila("ek", "DEFENSA EK XPRESS 125"),
  ];

  it.each([
    ["moto normalizada por el modelo", { query: "defensa", motoModel: "gxs 250" }],
    ["todo en el query", { query: "defensa gxs 250" }],
  ])("'defensa gxs 250' (%s): NO cotiza DEFENSA BRZ 250 como coincidencia de moto, y la pregunta la hace sin repetir la moto", async (_caso, entrada) => {
    const { client, getAppliedRpcArgs, insertedQuotes } = createFakeSupabase(defensas);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), entrada);

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["defensa"]]);
    expect(getAppliedRpcArgs()?.p_moto).toEqual([["gxs"]]);
    expect(getAppliedRpcArgs()?.p_cilindrada).toEqual([["250"]]);

    // La moto no calzó (ninguna fila dice "gxs"): NO restringe al 250 —
    // sigue habiendo cuatro defensas y es genérico, sin cotizar ninguna.
    expect(catalogOutcome.generico).toBe(true);
    expect(catalogOutcome.conExistencia).toBe(false);
    expect(catalogOutcome.cotizacion).toEqual([]);
    expect(insertedQuotes).toHaveLength(0);
    expect(result.results).toEqual([]);
    // Ya dio la moto: no se le vuelve a preguntar (aunque la defensa dependa de ella).
    expect(catalogOutcome.preguntaFiltro).toBe("producto");
  });

  it("'defensa ava mustang 250' tampoco cotiza DEFENSA BRZ 250: 'ava mustang' ES una moto con nombre y calza con la fila AVA", async () => {
    const { client } = createFakeSupabase(defensas);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "defensa ava mustang 250" });

    // La moto con nombre SÍ calza (DEFENSA AVA MUSTANG 200): se cotiza esa,
    // nunca la BRZ 250 que solo comparte la cilindrada.
    expect(result.results.map((r) => r.nombre)).toEqual(["DEFENSA AVA MUSTANG 200"]);
    expect(catalogOutcome.generico).toBe(false);
  });
});

describe("buildCatalogTool — 'genérico' se decide con el stock (T3a)", () => {
  it("'botas impermeable' con siete filas en cero: sin_stock, nunca genérico, y sin afirmar existencia", async () => {
    const botas = Array.from({ length: 7 }, (_, i) => fila(`bota-${i}`, `BOTAS IMPERMEABLE MODELO ${i}`, 0));
    const { client, insertedQuotes } = createFakeSupabase(botas);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "botas impermeable" });

    expect(catalogOutcome.agotados).toBe(true);
    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.conExistencia).toBe(false);
    expect(catalogOutcome.preguntaFiltro).toBeNull();
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_SIN_STOCK);
    expect(result.instruccionParaTuRespuesta).toMatch(/motivo sin_stock/);
    expect(result.instruccionParaTuRespuesta).not.toMatch(/tenemos/i);
    // Hotfix 29/9/2026 (decisión del operador): con todo agotado se nombra
    // SOLO el producto pedido (la mejor fila), nunca una lista de agotados.
    expect(result.results).toHaveLength(1);
    expect(catalogOutcome.cotizacion).toHaveLength(1);
    expect(insertedQuotes).toHaveLength(1);
  });

  it("de seis filas que calzan, dos con stock: cotiza UNA sola (la de más existencia) y no pregunta", async () => {
    const filas = [
      ...Array.from({ length: 4 }, (_, i) => fila(`sin-${i}`, `GUANTE INVIERNO SIN STOCK ${i}`, 0)),
      fila("con-1", "GUANTE INVIERNO ALPINESTARS", 3),
      fila("con-2", "GUANTE INVIERNO FOX", 2),
    ];
    const { client } = createFakeSupabase(filas);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "guante invierno" });

    // Hotfix 29/9/2026: una sola opción, la de mayor existencia (3 contra 2).
    expect(result.results.map((r) => r.nombre)).toEqual(["GUANTE INVIERNO ALPINESTARS"]);
    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_CONFIRMAR_INVENTARIO);
  });

  it("de más de tres filas con stock: sigue siendo genérico, y la instrucción prohíbe afirmar existencia", async () => {
    const filas = Array.from({ length: 5 }, (_, i) => fila(`g-${i}`, `GUANTE INVIERNO ${i}`, 4));
    const { client } = createFakeSupabase(filas);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "guante invierno" });

    expect(catalogOutcome.generico).toBe(true);
    expect(result.instruccionParaTuRespuesta).toMatch(/no afirmes que hay existencia/i);
    expect(result.instruccionParaTuRespuesta).toMatch(/no escales/i);
  });

  it("si las filas con stock quedaron más allá del límite, vuelve a pedir más filas para encontrarlas", async () => {
    // Doce con el producto al principio del nombre (van primero, sin stock) y
    // dos con stock que el orden deja detrás: la primera llamada (10 filas)
    // no las trae.
    const filas = [
      ...Array.from({ length: 12 }, (_, i) => fila(`sin-${i}`, `BOTA IMPERMEABLE ${i}`, 0)),
      fila("con-1", "ZAPATO BOTA IMPERMEABLE A", 3),
      fila("con-2", "ZAPATO BOTA IMPERMEABLE B", 1),
    ];
    const { client, rpcCalls } = createFakeSupabase(filas);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "bota impermeable" });

    expect(rpcCalls.map((c) => c.p_limite)).toEqual([10, 50]);
    // Hotfix 29/9/2026: de las dos con stock se cotiza UNA, la de mayor existencia.
    expect(result.results.map((r) => r.nombre)).toEqual(["ZAPATO BOTA IMPERMEABLE A"]);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(catalogOutcome.generico).toBe(false);
  });
});

describe("buildCatalogTool — una sola pregunta por pedido (T3a)", () => {
  const cascos = Array.from({ length: 5 }, (_, i) => fila(`casco-${i}`, `CASCO INTEGRAL MARCA ${i}`, 3, 50 + i));

  it("la primera consulta genérica pregunta y deja preguntaHechaPara; la segunda, del mismo producto, entrega UNA con stock", async () => {
    const { client } = createFakeSupabase(cascos);

    const primera = nuevoCatalogOutcome();
    const r1 = await correr(herramienta(client, primera), { query: "casco" });
    expect(primera.generico).toBe(true);
    expect(primera.preguntaFiltro).toBe("producto");
    expect(r1.results).toEqual([]);
    expect(r1.instruccionParaTuRespuesta).toContain(PREGUNTA_FILTRO_PRODUCTO);
    expect((await pedidoGuardado())?.preguntaHechaPara).toBe("casco");

    // Otro turno (herramienta nueva): la pregunta ya se hizo.
    const segunda = nuevoCatalogOutcome();
    const r2 = await correr(herramienta(client, segunda), { query: "casco" });
    expect(segunda.generico).toBe(false);
    expect(segunda.preguntaFiltro).toBeNull();
    expect(segunda.conExistencia).toBe(true);
    expect(r2.results).toHaveLength(1);
    expect(r2.instruccionParaTuRespuesta).toContain(TEXTO_CONFIRMAR_INVENTARIO);
    expect(r2.instruccionParaTuRespuesta).toMatch(/confirmar_inventario/);
  });

  it("en el MISMO turno una segunda llamada idéntica sigue siendo la pregunta (no se la come la memoria recién escrita)", async () => {
    const { client } = createFakeSupabase(cascos);
    const outcome = nuevoCatalogOutcome();
    const tool = herramienta(client, outcome);

    await correr(tool, { query: "casco" });
    const repetida = await correr(tool, { query: "casco" });

    expect(outcome.generico).toBe(true);
    expect(outcome.conExistencia).toBe(false);
    expect(repetida.results).toEqual([]);
  });

  it("un pedido que REFINA al preguntado ('casco negro' tras preguntar por 'casco') no vuelve a preguntar", async () => {
    const { client } = createFakeSupabase(cascos);
    await correr(herramienta(client, nuevoCatalogOutcome()), { query: "casco" });

    const outcome = nuevoCatalogOutcome();
    const result = await correr(herramienta(client, outcome), { query: "casco negro" });

    expect(outcome.generico).toBe(false);
    expect(outcome.conExistencia).toBe(true);
    expect(result.results).toHaveLength(1);
  });

  it("otro producto genérico distinto SÍ vuelve a preguntar", async () => {
    const guantes = Array.from({ length: 5 }, (_, i) => fila(`guante-${i}`, `GUANTE MARCA ${i}`, 3));
    const { client } = createFakeSupabase([...cascos, ...guantes]);
    await correr(herramienta(client, nuevoCatalogOutcome()), { query: "casco" });

    const outcome = nuevoCatalogOutcome();
    await correr(herramienta(client, outcome), { query: "guante" });

    expect(outcome.generico).toBe(true);
    expect(outcome.preguntaFiltro).toBe("producto");
  });

  it.each([["no sé"], ["muéstrame todos"], ["los que tengas"], ["me da igual"]])(
    "si la ráfaga del cliente dice «%s», NO pregunta: entrega UNA con stock y escala con confirmar_inventario",
    async (frase) => {
      const { client } = createFakeSupabase(cascos);
      const outcome = nuevoCatalogOutcome();

      const result = await correr(herramienta(client, outcome, { rafagaCliente: ["Tienen cascos?", frase] }), {
        query: "casco",
      });

      expect(outcome.generico).toBe(false);
      expect(outcome.preguntaFiltro).toBeNull();
      expect(outcome.conExistencia).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.instruccionParaTuRespuesta).toContain(TEXTO_CONFIRMAR_INVENTARIO);
    }
  );

  it("preguntaFiltro: 'moto' solo si el repuesto depende de la moto y el cliente todavía no la dio", async () => {
    const pastillas = Array.from({ length: 5 }, (_, i) => fila(`p-${i}`, `PASTILLAS DE FRENO MODELO ${i}`, 3));

    const a = nuevoCatalogOutcome();
    const ra = await correr(herramienta(createFakeSupabase(pastillas).client, a), {
      query: "pastillas de freno",
      dependeDeLaMoto: true,
    });
    expect(a.preguntaFiltro).toBe("moto");
    expect(ra.instruccionParaTuRespuesta).toContain(PREGUNTA_FILTRO);
    expect(ra.instruccionParaTuRespuesta).not.toContain(PREGUNTA_FILTRO_PRODUCTO);

    // Ya dio la moto (aunque ninguna fila la nombre): no se la vuelve a pedir.
    redisEstado.redis = new FakeRedis();
    const b = nuevoCatalogOutcome();
    const rb = await correr(herramienta(createFakeSupabase(pastillas).client, b), {
      query: "pastillas de freno",
      motoModel: "kavak",
      dependeDeLaMoto: true,
    });
    expect(b.preguntaFiltro).toBe("producto");
    expect(rb.instruccionParaTuRespuesta).toContain(PREGUNTA_FILTRO_PRODUCTO);
    expect(rb.instruccionParaTuRespuesta).not.toContain(PREGUNTA_FILTRO);

    // No depende de la moto (o el modelo no dijo nada): la pregunta del producto.
    redisEstado.redis = new FakeRedis();
    const c = nuevoCatalogOutcome();
    await correr(herramienta(createFakeSupabase(pastillas).client, c), { query: "pastillas de freno" });
    expect(c.preguntaFiltro).toBe("producto");
  });
});

describe("buildCatalogTool — la respuesta suelta se combina con el pedido anterior (T3a)", () => {
  it("'24' tras 'asiento' + moto sbr busca asiento 24 para la sbr", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase([
      fila("a1", "ASIENTO SBR"),
      fila("a2", "ASIENTO SBR 24"),
    ]);
    await correr(herramienta(client, nuevoCatalogOutcome()), { query: "asiento", motoModel: "sbr" });

    const result = await correr(herramienta(client, nuevoCatalogOutcome()), { query: "24" });

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["asiento"], ["24"]]);
    expect(getAppliedRpcArgs()?.p_moto).toEqual([["sbr"]]);
    expect(result.results.map((r) => r.nombre)).toEqual(["ASIENTO SBR 24"]);
  });

  it("'20w50' tras 'aceite inca' busca aceite inca 20w50", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase([
      fila("i1", "ACEITE INCA 20W50 4T"),
      fila("i2", "ACEITE INCA 15W40 4T"),
    ]);
    await correr(herramienta(client, nuevoCatalogOutcome()), { query: "aceite inca" });

    const result = await correr(herramienta(client, nuevoCatalogOutcome()), { query: "20w50" });

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["aceite"], ["inca"], ["20w50"]]);
    expect(result.results.map((r) => r.nombre)).toEqual(["ACEITE INCA 20W50 4T"]);
    // El pedido se acumula: la próxima respuesta suelta parte de todo lo dicho.
    expect((await pedidoGuardado())?.ultimoQuery).toBe("aceite inca 20w50");
  });

  it("'Talla M' tras 'casco frankie negro' busca casco frankie con negro y talla como opcionales", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase([fila("c1", "CASCO FRANKIE NEGRO TALLA M")]);
    await correr(herramienta(client, nuevoCatalogOutcome()), { query: "casco frankie negro" });

    await correr(herramienta(client, nuevoCatalogOutcome()), { query: "Talla M" });

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["casco"], ["frankie"]]);
    expect(getAppliedRpcArgs()?.p_opcionales).toEqual([["negro"], ["talla"]]);
  });

  it("una respuesta con un término de producto NO se combina: es otro pedido", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase([fila("a1", "ASIENTO SBR"), fila("c1", "CASCO LS2")]);
    await correr(herramienta(client, nuevoCatalogOutcome()), { query: "asiento", motoModel: "sbr" });

    await correr(herramienta(client, nuevoCatalogOutcome()), { query: "casco" });

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["casco"]]);
    expect(getAppliedRpcArgs()?.p_moto).toEqual([]);
    expect((await pedidoGuardado())?.ultimoQuery).toBe("casco");
  });

  it("sin pedido anterior, la respuesta suelta se busca tal cual", async () => {
    const { client, getAppliedRpcArgs } = createFakeSupabase([fila("x", "ALGO 24")]);
    await correr(herramienta(client, nuevoCatalogOutcome()), { query: "24" });

    expect(getAppliedRpcArgs()?.p_terminos).toEqual([["24"]]);
  });
});

describe("buildCatalogTool — listas de productos (T3a, D5: máximo cinco)", () => {
  const baterias = fila("bat", "BATERIA BERA SOCIALISTA 12V", 4, 30);
  const arranque = fila("arr", "MOTOR DE ARRANQUE BERA SOCIALISTA", 2, 45);

  it("['bateria','arranque'] + moto 'bera socialista': una búsqueda por producto, un resultado por producto, y escala", async () => {
    const { client, rpcCalls, insertedQuotes } = createFakeSupabase([baterias, arranque]);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), {
      query: "",
      productos: ["bateria", "arranque"],
      motoModel: "bera socialista",
    });

    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls.map((c) => c.p_terminos)).toEqual([[["bateria"]], [["arranque"]]]);
    for (const llamada of rpcCalls) expect(llamada.p_moto).toEqual([["bera"], ["socialista"]]);

    expect(result.porProducto).toHaveLength(2);
    expect(result.porProducto?.map((r) => r.producto)).toEqual(["bateria", "arranque"]);
    expect(result.porProducto?.map((r) => r.results[0].nombre)).toEqual([
      "BATERIA BERA SOCIALISTA 12V",
      "MOTOR DE ARRANQUE BERA SOCIALISTA",
    ]);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_CONFIRMAR_INVENTARIO);
    expect(result.instruccionParaTuRespuesta).toMatch(/motivo confirmar_inventario/);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(catalogOutcome.cotizacion.map((l) => [l.productId, l.productoPedido])).toEqual([
      ["bat", "bateria"],
      ["arr", "arranque"],
    ]);
    expect(insertedQuotes.map((q) => q.product_id)).toEqual(["bat", "arr"]);
  });

  it("si uno de la lista no aparece, el resumen lo dice y el otro se cotiza igual", async () => {
    const { client } = createFakeSupabase([baterias]);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), {
      query: "",
      productos: ["bateria", "arranque"],
    });

    expect(result.porProducto?.map((r) => r.estado)).toEqual(["con_existencia", "sin_resultados"]);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(catalogOutcome.sinResultados).toBe(true);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_CONFIRMAR_INVENTARIO);
    expect(result.instruccionParaTuRespuesta).toMatch(/arranque/);
  });

  it("si ninguno aparece, la instrucción es la de no identificado", async () => {
    const { client } = createFakeSupabase([]);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "", productos: ["bateria", "arranque"] });

    expect(catalogOutcome.sinResultados).toBe(true);
    expect(catalogOutcome.conExistencia).toBe(false);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_NO_IDENTIFICADO);
  });

  it("en una lista un producto genérico no abre una pregunta: entrega UNA con stock", async () => {
    const cinco = Array.from({ length: 5 }, (_, i) => fila(`b-${i}`, `BATERIA MARCA ${i}`, 3));
    const { client } = createFakeSupabase(cinco);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "", productos: ["bateria"] });

    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.preguntaFiltro).toBeNull();
    expect(result.porProducto?.[0].results).toHaveLength(1);
  });

  it("el esquema acepta hasta cinco productos y rechaza seis", () => {
    const { client } = createFakeSupabase([]);
    const tool = herramienta(client, nuevoCatalogOutcome());
    const esquema = tool.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } };

    expect(esquema.safeParse({ query: "", productos: ["a", "b", "c", "d", "e"] }).success).toBe(true);
    expect(esquema.safeParse({ query: "", productos: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
  });
});

/**
 * 29/9/2026, escenario a mano: "necesito un asiento sbr" con seis "ASIENTO SBR
 * …" con stock. "sbr" viaja a `moto` y los nombres lo contienen, así que la
 * moto "calza" y la rama vieja cotizaba LOS SEIS de una vez.
 *
 * HOTFIX DE PRODUCCIÓN, 29/9/2026 (decisión del operador, reemplaza el tope de
 * tres de la misma mañana): Seba cotizaba hasta tres opciones de cada cosa
 * que pedía el cliente (más la línea «Hay N opciones más…») y mezclaba
 * productos con stock 0 con los que tenían existencia. Ahora, SIEMPRE:
 * - con stock se cotiza UNA sola opción, la mejor (relevancia de SQL y, a
 *   igual relevancia, la de MAYOR existencia); nunca un agotado si hay alguno
 *   con stock, y nunca la línea «Hay N opciones más» (`masOpciones` vacío);
 * - si todo lo que calza está agotado, se nombra SOLO el producto pedido.
 * La pregunta de filtro (genérico) no cambia.
 */
describe("buildCatalogTool — una sola opción cotizada (hotfix 29/9/2026)", () => {
  const seisAsientos = (existencias: number[]) =>
    existencias.map((stock, i) => fila(`as-${i}`, `ASIENTO SBR ${String.fromCharCode(65 + i)}`, stock, 20 + i));

  it("el caso real 'asiento sbr' con seis con stock: cotiza EXACTAMENTE una, sin pregunta, con confirmar_inventario", async () => {
    const { client, insertedQuotes } = createFakeSupabase(seisAsientos([1, 9, 3, 7, 2, 5]));
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "asiento sbr" });

    expect(result.results).toHaveLength(1);
    expect(result.results.every((r) => r.stock > 0)).toBe(true);
    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.preguntaFiltro).toBeNull();
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(catalogOutcome.cotizacion).toHaveLength(1);
    expect(insertedQuotes).toHaveLength(1);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_CONFIRMAR_INVENTARIO);
    expect(result.instruccionParaTuRespuesta).toMatch(/motivo confirmar_inventario/);
    expect(result.instruccionParaTuRespuesta).not.toMatch(/no afirmes que hay existencia/i);
  });

  it("(3) moto calza, seis con stock (1,9,3,7,2,5) a igual relevancia: cotiza SOLO la de 9 y `masOpciones` queda vacío", async () => {
    const { client } = createFakeSupabase(seisAsientos([1, 9, 3, 7, 2, 5]));
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "asiento sbr" });

    expect(result.results.map((r) => [r.nombre, r.stock])).toEqual([["ASIENTO SBR B", 9]]);
    expect(catalogOutcome.cotizacion.map((l) => l.stock)).toEqual([9]);
    expect(catalogOutcome.masOpciones).toEqual([]);
    expect(result.instruccionParaTuRespuesta).not.toMatch(/Hay más resultados de los que caben/i);
  });

  it("con exactamente cuatro con stock: cotiza solo la de mayor existencia, sin 'opciones más'", async () => {
    const { client } = createFakeSupabase(seisAsientos([2, 4, 6, 8]));
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "asiento sbr" });

    expect(result.results.map((r) => r.stock)).toEqual([8]);
    expect(catalogOutcome.masOpciones).toEqual([]);
  });

  it("los agotados no se mezclan: seis del máximo con cuatro con stock => una sola, la de más existencia", async () => {
    const { client } = createFakeSupabase(seisAsientos([0, 3, 0, 5, 4, 1]));
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "asiento sbr" });

    expect(result.results.map((r) => r.stock)).toEqual([5]);
    expect(catalogOutcome.masOpciones).toEqual([]);
  });

  it("si la de más existencia quedó más allá de las primeras 10 filas, vuelve a pedir 50 para elegir bien", async () => {
    // Doce con stock 1 (por nombre van primero, A-L) y tres al final del
    // alfabeto con más existencia: la primera llamada (10 filas) no las trae.
    const filas = [
      ...Array.from({ length: 12 }, (_, i) => fila(`bajo-${i}`, `ASIENTO SBR ${String.fromCharCode(65 + i)}`, 1)),
      fila("alto-1", "ASIENTO SBR X", 20),
      fila("alto-2", "ASIENTO SBR Y", 15),
      fila("alto-3", "ASIENTO SBR Z", 12),
    ];
    const { client, rpcCalls } = createFakeSupabase(filas);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "asiento sbr" });

    expect(rpcCalls.map((c) => c.p_limite)).toEqual([10, 50]);
    expect(result.results.map((r) => r.nombre)).toEqual(["ASIENTO SBR X"]);
    expect(catalogOutcome.masOpciones).toEqual([]);
  });

  it("(2) moto calza, UNA con stock y cinco agotadas: cotiza solo la de stock, nunca un agotado", async () => {
    const filas = [
      fila("a", "ASIENTO SBR A", 0),
      fila("b", "ASIENTO SBR B", 0),
      fila("c", "ASIENTO SBR C", 4),
      fila("d", "ASIENTO SBR D", 0),
      fila("e", "ASIENTO SBR E", 0),
      fila("f", "ASIENTO SBR F", 0),
    ];
    const { client } = createFakeSupabase(filas);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "asiento sbr" });

    expect(result.results.map((r) => [r.nombre, r.stock])).toEqual([["ASIENTO SBR C", 4]]);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(catalogOutcome.agotados).toBe(false);
    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.masOpciones).toEqual([]);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_CONFIRMAR_INVENTARIO);
    expect(result.instruccionParaTuRespuesta).not.toContain(TEXTO_SIN_STOCK);
  });

  it("(1) sin moto, dos con stock y un agotado que calzan (3 o menos): cotiza UNA con stock, nunca el agotado", async () => {
    const filas = [
      fila("a", "PASTILLA FRENO AAA", 0),
      fila("b", "PASTILLA FRENO BBB", 2),
      fila("c", "PASTILLA FRENO CCC", 6),
    ];
    const { client, insertedQuotes } = createFakeSupabase(filas);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "pastilla freno" });

    expect(result.results.map((r) => [r.nombre, r.stock])).toEqual([["PASTILLA FRENO CCC", 6]]);
    expect(catalogOutcome.generico).toBe(false);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(catalogOutcome.agotados).toBe(false);
    expect(catalogOutcome.cotizacion.map((l) => l.productId)).toEqual(["c"]);
    expect(insertedQuotes.map((q) => q.product_id)).toEqual(["c"]);
  });

  it("(5) todos agotados (cinco filas): estado agotados con UN solo producto nombrado y el texto fijo", async () => {
    const { client } = createFakeSupabase(Array.from({ length: 5 }, (_, i) => fila(`ag-${i}`, `PASTILLA FRENO ${i}`, 0)));
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "pastilla freno" });

    expect(catalogOutcome.agotados).toBe(true);
    expect(catalogOutcome.conExistencia).toBe(false);
    expect(catalogOutcome.generico).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(catalogOutcome.cotizacion).toHaveLength(1);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_SIN_STOCK);
    expect(result.instruccionParaTuRespuesta).toMatch(/motivo sin_stock/);
  });

  it("todos agotados con la moto calzando (seis asientos en cero): nombra SOLO uno", async () => {
    const { client } = createFakeSupabase(seisAsientos([0, 0, 0, 0, 0, 0]));
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "asiento sbr" });

    expect(catalogOutcome.agotados).toBe(true);
    expect(catalogOutcome.conExistencia).toBe(false);
    expect(catalogOutcome.generico).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_SIN_STOCK);
    expect(catalogOutcome.masOpciones).toEqual([]);
  });

  it("(4) ya se preguntó y hay más de tres con stock: cotiza UNA y no vuelve a preguntar", async () => {
    const { client } = createFakeSupabase(Array.from({ length: 6 }, (_, i) => fila(`g-${i}`, `ASIENTO MARCA ${i}`, i + 1)));

    // Primera vez: pregunta de filtro (no cambia).
    const primera = nuevoCatalogOutcome();
    await correr(herramienta(client, primera), { query: "asiento" });
    expect(primera.generico).toBe(true);
    expect(primera.masOpciones).toEqual([]);

    // Otro turno: la pregunta ya se hizo, se entrega UNA, la de más existencia.
    const segunda = nuevoCatalogOutcome();
    const result = await correr(herramienta(client, segunda), { query: "asiento" });
    expect(segunda.generico).toBe(false);
    expect(segunda.conExistencia).toBe(true);
    expect(result.results.map((r) => [r.nombre, r.stock])).toEqual([["ASIENTO MARCA 5", 6]]);
    expect(segunda.masOpciones).toEqual([]);
  });

  it("(4) el cliente pide ver todo con más de tres con stock: cotiza UNA, la de más existencia", async () => {
    const { client } = createFakeSupabase(Array.from({ length: 6 }, (_, i) => fila(`g-${i}`, `ASIENTO MARCA ${i}`, i + 1)));
    const outcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, outcome, { rafagaCliente: ["Tienen asientos?", "muéstrame todos"] }), {
      query: "asiento",
    });

    expect(outcome.generico).toBe(false);
    expect(result.results.map((r) => r.stock)).toEqual([6]);
    expect(outcome.masOpciones).toEqual([]);
  });

  it("(7) hay stock en la base pero las primeras 10 filas traídas son agotadas: reintenta con 50 y cotiza la de stock", async () => {
    const filas = [
      ...Array.from({ length: 12 }, (_, i) => fila(`sin-${i}`, `BOTA IMPERMEABLE ${i}`, 0)),
      fila("con-1", "ZAPATO BOTA IMPERMEABLE A", 3),
    ];
    const { client, rpcCalls } = createFakeSupabase(filas);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "bota impermeable" });

    expect(rpcCalls.map((c) => c.p_limite)).toEqual([10, 50]);
    expect(result.results.map((r) => [r.nombre, r.stock])).toEqual([["ZAPATO BOTA IMPERMEABLE A", 3]]);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(catalogOutcome.agotados).toBe(false);
  });

  it("NO REGRESION: sin moto que calce, mas de tres con stock sigue siendo generico (pregunta) y no cuenta 'mas opciones'", async () => {
    const { client } = createFakeSupabase(Array.from({ length: 6 }, (_, i) => fila(`g-${i}`, `ASIENTO MARCA ${i}`, 5)));
    const catalogOutcome = nuevoCatalogOutcome();

    await correr(herramienta(client, catalogOutcome), { query: "asiento" });

    expect(catalogOutcome.generico).toBe(true);
    expect(catalogOutcome.masOpciones).toEqual([]);
  });

  it("(6) en una lista, se cotiza UNA por producto (asientos y cubiertas)", async () => {
    const filas = [
      ...seisAsientos([1, 9, 3, 7, 2, 5]),
      fila("cub-1", "CUBIERTA SBR 80", 4),
      fila("cub-2", "CUBIERTA SBR 90", 2),
      fila("cub-3", "CUBIERTA SBR 100", 0),
    ];
    const { client } = createFakeSupabase(filas);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), {
      query: "",
      productos: ["asiento", "cubierta"],
      motoModel: "sbr",
    });

    expect(result.porProducto?.map((r) => r.results.length)).toEqual([1, 1]);
    expect(result.porProducto?.map((r) => r.results[0].stock)).toEqual([9, 4]);
    expect(catalogOutcome.cotizacion).toHaveLength(2);
    expect(catalogOutcome.masOpciones).toEqual([]);
  });
});

describe("buildCatalogTool — lo que la herramienta deja en el CatalogOutcome (T3a)", () => {
  it("cotizacion lleva el nombre exacto, el precio en USD y Bs, el stock y el producto pedido (null si no fue lista)", async () => {
    const { client } = createFakeSupabase([
      { id: "p1", name: "Aceite Inca 20W50 4T", brand: "Inca", price: 87, currency: "VES", stock_quantity: 6 },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();

    await correr(herramienta(client, catalogOutcome), { query: "aceite inca 20w50" });

    // 87 Bs / 40 = 2,175 -> 2,20 (usdFromBs, hacia arriba al $0,10).
    expect(catalogOutcome.cotizacion).toEqual([
      { productId: "p1", nombre: "Aceite Inca 20W50 4T", precioUsd: 2.2, precioBs: 87, stock: 6, productoPedido: null },
    ]);
  });

  it("no repite el mismo producto si el modelo llama dos veces a la herramienta en el turno", async () => {
    const { client } = createFakeSupabase([fila("p1", "CARBURADOR PZ27", 3)]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = herramienta(client, catalogOutcome);

    await correr(tool, { query: "carburador" });
    await correr(tool, { query: "carburador pz27" });

    expect(catalogOutcome.cotizacion).toHaveLength(1);
  });

  it("consultas registra una entrada por búsqueda, con los conjuntos que se mandaron y el resultado", async () => {
    const { client } = createFakeSupabase([fila("p1", "ASIENTO SBR NEGRO", 3)]);
    const catalogOutcome = nuevoCatalogOutcome();

    await correr(herramienta(client, catalogOutcome), { query: "asiento negro sbr 200" });
    await correr(herramienta(client, catalogOutcome), { query: "nada de nada" });

    expect(catalogOutcome.consultas).toEqual([
      {
        query: "asiento negro sbr 200",
        productos: null,
        moto: [["sbr"]],
        cilindrada: [["200"]],
        grupos: [["asiento"]],
        opcionales: [["negro"]],
        corregido: null,
        resultado: "con_existencia",
      },
      expect.objectContaining({ query: "nada de nada", resultado: "sin_resultados" }),
    ]);
  });

  it("cada búsqueda deja un log.info busqueda_catalogo con lo que se buscó, sin claves que lib/log oculte", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const { client } = createFakeSupabase([fila("p1", "ASIENTO SBR NEGRO", 3)]);
    const catalogOutcome = nuevoCatalogOutcome();
    const tool = herramienta(client, catalogOutcome);

    await correr(tool, { query: "asiento negro sbr 200" });
    await correr(tool, { query: "nada de nada" });

    const llamadas = info.mock.calls.filter(([evento]) => evento === "busqueda_catalogo");
    expect(llamadas).toHaveLength(2);
    expect(llamadas[0][1]).toEqual({
      conversationId: "conv-1",
      query: "asiento negro sbr 200",
      productos: null,
      moto: '[["sbr"]]',
      grupos: '[["asiento"]]',
      opcionales: '[["negro"]]',
      corregido: null,
      resultado: "con_existencia",
    });
    expect(llamadas[1][1]).toMatchObject({ query: "nada de nada", resultado: "sin_resultados" });
    // `lib/log` tapa toda clave que contenga "phone": ninguna viaja.
    expect(Object.keys(llamadas[0][1] as object).some((k) => /phone/i.test(k))).toBe(false);
  });

  it("una consulta sin ningún término reconocible queda como sin_terminos", async () => {
    const { client } = createFakeSupabase([]);
    const catalogOutcome = nuevoCatalogOutcome();

    await correr(herramienta(client, catalogOutcome), { query: "   " });

    expect(catalogOutcome.consultas).toEqual([
      expect.objectContaining({ resultado: "sin_terminos", grupos: [] }),
    ]);
  });
});

describe("buildCatalogTool — sin Redis la herramienta sigue funcionando como antes (T3a)", () => {
  it("con Redis caído (getRedis lanza) busca y cotiza igual, y la pregunta se repite porque nadie la recuerda", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    redisEstado.falla = new Error("Falta REDIS_URL");
    const cascos = Array.from({ length: 5 }, (_, i) => fila(`casco-${i}`, `CASCO INTEGRAL MARCA ${i}`, 3));
    const { client } = createFakeSupabase([...cascos, fila("otro", "CARBURADOR PZ27", 3)]);

    const cotiza = nuevoCatalogOutcome();
    const r = await correr(herramienta(client, cotiza), { query: "carburador" });
    expect(r.results.map((x) => x.nombre)).toEqual(["CARBURADOR PZ27"]);
    expect(cotiza.conExistencia).toBe(true);

    const primera = nuevoCatalogOutcome();
    await correr(herramienta(client, primera), { query: "casco" });
    const segunda = nuevoCatalogOutcome();
    await correr(herramienta(client, segunda), { query: "casco" });
    expect(primera.generico).toBe(true);
    expect(segunda.generico).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T3b, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026): el segundo intento tolerante a tipeos (T2). Si el
// primer intento no calza, se pide la corrección a `corregir_terminos` y se
// reintenta UNA vez. Con corrección, la respuesta la nombra y el asesor
// confirma (el cliente escribió una palabra que no estaba en el catálogo).
// ---------------------------------------------------------------------------
describe("buildCatalogTool — el corrector de tipeos como segundo intento (T3b)", () => {
  const soporte = fila("sop", "SOPORTE CELULAR IPONE 11", 5, 12);

  it("'soporte iphone' no calza; se corrige a ipone, se reintenta una vez, se cotiza y el asesor confirma", async () => {
    const { client, rpcCalls, correctorCalls } = createFakeSupabase([soporte], [], "conv-1", [
      { original: "iphone", corregido: "ipone" },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "soporte iphone" });

    // El primer intento buscó lo que escribió el cliente; el segundo, lo corregido.
    expect(rpcCalls.map((c) => c.p_terminos)).toEqual([[["soporte"], ["iphone"]], [["soporte"], ["ipone"]]]);
    // Solo los términos obligatorios viajan al corrector; las motos conocidas van protegidas.
    expect(correctorCalls).toHaveLength(1);
    expect(correctorCalls[0].p_terminos).toEqual(["soporte", "iphone"]);
    expect(correctorCalls[0].p_protegidos).toContain("bera");
    expect(correctorCalls[0].p_protegidos).toContain("beta");

    expect(result.results.map((r) => r.nombre)).toEqual(["SOPORTE CELULAR IPONE 11"]);
    expect(result.instruccionParaTuRespuesta).toContain("busqué IPONE en lugar de iphone");
    expect(result.instruccionParaTuRespuesta).toMatch(/motivo confirmar_inventario/);
    expect(catalogOutcome.conExistencia).toBe(true);
    expect(catalogOutcome.sinResultados).toBe(false);
    expect(catalogOutcome.cotizacion.map((l) => l.nombre)).toEqual(["SOPORTE CELULAR IPONE 11"]);
    expect(catalogOutcome.consultas).toEqual([
      expect.objectContaining({
        query: "soporte iphone",
        grupos: [["soporte"], ["ipone"]],
        corregido: [{ original: "iphone", corregido: "ipone" }],
        resultado: "con_existencia",
      }),
    ]);
  });

  it("sin corrección posible (el corrector no devuelve nada): sigue como hoy, no identificado y sin segundo intento", async () => {
    const { client, rpcCalls, correctorCalls } = createFakeSupabase([soporte]);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "soporte samsung" });

    expect(correctorCalls).toHaveLength(1);
    expect(rpcCalls).toHaveLength(1);
    expect(result.results).toEqual([]);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_NO_IDENTIFICADO);
    expect(catalogOutcome.sinResultados).toBe(true);
    expect(catalogOutcome.consultas[0]).toEqual(expect.objectContaining({ corregido: null, resultado: "sin_resultados" }));
  });

  it("si el primer intento calza, la RPC del corrector NO se llama", async () => {
    const { client, correctorCalls } = createFakeSupabase([soporte], [], "conv-1", [
      { original: "soporte", corregido: "soporta" },
    ]);

    await correr(herramienta(client, nuevoCatalogOutcome()), { query: "soporte celular" });

    expect(correctorCalls).toHaveLength(0);
  });

  it("si el reintento con lo corregido tampoco calza, sale no identificado y queda anotado lo que se intentó", async () => {
    const { client, rpcCalls } = createFakeSupabase([soporte], [], "conv-1", [{ original: "iphone", corregido: "ipone" }]);
    const catalogOutcome = nuevoCatalogOutcome();

    // "cargador" no está en ningún nombre: aunque iphone se corrija, el grupo obligatorio no calza.
    const result = await correr(herramienta(client, catalogOutcome), { query: "cargador iphone" });

    expect(rpcCalls).toHaveLength(2);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_NO_IDENTIFICADO);
    expect(catalogOutcome.sinResultados).toBe(true);
    expect(catalogOutcome.consultas[0].corregido).toEqual([{ original: "iphone", corregido: "ipone" }]);
  });

  it("con lo corregido agotado, la instrucción sigue siendo la de sin stock y nombra la corrección", async () => {
    const { client } = createFakeSupabase([fila("sop", "SOPORTE CELULAR IPONE 11", 0, 12)], [], "conv-1", [
      { original: "iphone", corregido: "ipone" },
    ]);
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), { query: "soporte iphone" });

    expect(catalogOutcome.agotados).toBe(true);
    expect(result.instruccionParaTuRespuesta).toContain(TEXTO_SIN_STOCK);
    expect(result.instruccionParaTuRespuesta).toContain("busqué IPONE en lugar de iphone");
  });

  it("en una lista, cada producto puede corregirse y el resumen lo nombra", async () => {
    const { client, correctorCalls } = createFakeSupabase(
      [fila("bat", "BATERIA BERA 12V", 4, 30), soporte],
      [],
      "conv-1",
      [{ original: "iphone", corregido: "ipone" }]
    );
    const catalogOutcome = nuevoCatalogOutcome();

    const result = await correr(herramienta(client, catalogOutcome), {
      query: "",
      productos: ["bateria", "soporte iphone"],
    });

    // La batería calza a la primera; solo "soporte iphone" pasa por el corrector.
    expect(correctorCalls).toHaveLength(1);
    expect(result.porProducto?.map((r) => r.estado)).toEqual(["con_existencia", "con_existencia"]);
    expect(result.instruccionParaTuRespuesta).toContain("busqué IPONE en lugar de iphone");
    expect(catalogOutcome.consultas.map((c) => c.corregido)).toEqual([null, [{ original: "iphone", corregido: "ipone" }]]);
  });
});
