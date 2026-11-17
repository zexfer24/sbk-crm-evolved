import { beforeEach, describe, expect, it, vi } from "vitest";
import { tool, type generateText, type LanguageModel } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { SeenMarker } from "@/lib/ai/history-line";
import type { buildCatalogTool, CatalogOutcome, ConsultaCatalogo, LineaCotizada } from "@/lib/ai/tools";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import type { PaymentMethodConfig } from "@/lib/payment-methods";
import type { Product } from "@/lib/types";

const logInfo = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();

vi.mock("@/lib/log", () => ({
  log: {
    info: (...a: unknown[]) => logInfo(...a),
    warn: (...a: unknown[]) => logWarn(...a),
    error: (...a: unknown[]) => logError(...a),
  },
  errorText: (err: unknown) => (err instanceof Error ? err.message : JSON.stringify(err)),
}));
// El turno no importa estos módulos en los tests: todo entra por `deps`. Se mockean para no cargar los SDK de IA
// ni el grafo de lecturas del inventario por sus valores por defecto.
vi.mock("@/lib/ai/model", () => ({
  getAgentModel: vi.fn(),
  currentAgentModelLabel: vi.fn(() => "openai/modelo-real"),
}));
vi.mock("@/lib/inventory-data", () => ({ fetchProductsByIds: vi.fn() }));
vi.mock("@/lib/ai/bcv", () => ({ getBcvRate: vi.fn() }));
vi.mock("@/lib/ai/wait-readings", () => ({ esperarLecturas: vi.fn() }));

import { crearEffectsDeMemoria, type GuionDeMemoria } from "./effects-memoria";
import { type HistorialDeTurno, type DatosDeTurno } from "./contexto";
import {
  SEBA2_MAX_MENSAJES,
  SEBA2_MAX_OUTPUT_TOKENS,
  SEBA2_MAX_PASOS,
  runSeba2Turn,
  type DepsDeTurno,
  type EntradaDeTurno,
} from "./turno";
import {
  LINEA_CIERRE_COTIZACION,
  PREGUNTA_QUE_BUSCA,
  TEXTO_COMPROBANTE_RECIBIDO,
  TEXTO_PASE,
} from "./textos";
import type { EstadoSeba } from "./tipos";

// ---------------------------------------------------------------------------
// El turno de Seba v2 (S8c, 17/11/2026): efectos de memoria + `deps` inyectadas.
// El modelo es una función guionada que invoca las herramientas como lo haría el
// SDK (`tools.<nombre>.execute(entrada, opciones)`) y respeta `stopWhen`. Ningún
// caso depende del reloj real: `AHORA` viaja en la entrada del turno.
// ---------------------------------------------------------------------------

// Martes 17/11/2026 11:00 en Caracas: la tienda está abierta.
const AHORA = new Date("2026-11-17T15:00:00.000Z");
const OPCIONES_DE_HERRAMIENTA = { toolCallId: "t1", messages: [], context: {} };

const ID_CASCO = "11111111-1111-4111-8111-111111111111";

// ---------------------------------------------------------------- fixtures

function producto(over: Partial<Product> = {}): Product {
  return {
    id: ID_CASCO,
    name: "IMPERMEABLE GIVI TALLA L",
    brand: null,
    price: 30,
    currency: "USD",
    stockQuantity: 5,
    description: null,
    isActive: true,
    updatedAt: "2026-11-17T10:00:00.000Z",
    compatibility: [],
    weightKg: 1.2,
    shippingFeeUsd: 3,
    precioDivisaUsd: null,
    saintCode: "00123",
    saintAddedAt: null,
    saintRemovedAt: null,
    fotos: [],
    ...over,
  };
}

function metodo(over: Partial<PaymentMethodConfig> = {}): PaymentMethodConfig {
  return {
    key: "pago_movil",
    label: "Pago móvil",
    currency: "VES",
    instructions: "Banco X\nTeléfono 0414-0000000\nCédula V-00000000",
    sebaEntrega: true,
    isActive: true,
    sortOrder: 10,
    updatedAt: "2026-11-17T10:00:00.000Z",
    ...over,
  };
}

const BIENVENIDA = "Bienvenido a SBK Motors. Enviamos a todo el país y aceptamos Cashea.";
const FRASE_FIJA = "Cuéntame qué repuesto necesitas.";

function datos(extra: Partial<DatosDeTurno> = {}): DatosDeTurno {
  return {
    conversacion: {
      id: "conv-1",
      contactId: "contacto-1",
      assignedAgentId: null,
      aiEnabled: true,
      status: "open",
      welcomeSentAt: null,
      lastCustomerMessageAt: AHORA.toISOString(),
      escalationArea: null,
    },
    customerName: null,
    config: {
      welcomeText: BIENVENIDA,
      welcomeFollowups: [FRASE_FIJA],
      casheaDatosText: "Para generar tu enlace necesito:\n✅ Cédula del titular\n✅ Nombre completo",
      casheaMinimoUsd: 25,
      casheaSeisCuotasDesdeUsd: 100,
    },
    metodos: [metodo(), metodo({ key: "transferencia", label: "Transferencia", sortOrder: 20 })],
    businessHours: DEFAULT_BUSINESS_HOURS,
    tiendaAbierta: true,
    cuandoAbre: null,
    lessons: { global: [], chat: [] },
    nombresDeAsesores: ["Pedro"],
    escaladaAbierta: false,
    esperaDeAsesor: null,
    asesorEscribioHaceMin: null,
    ...extra,
  };
}

interface Linea {
  rol: "user" | "assistant";
  texto: string;
  /** Minutos ANTES de AHORA. */
  hace: number;
  id: string;
  lectura?: { status: string; text: string | null; fields: unknown } | null;
}

function historial(lineas: Linea[]): HistorialDeTurno {
  return {
    messages: lineas.map((l) => ({ role: l.rol, content: l.texto })),
    createdAt: lineas.map((l) => new Date(AHORA.getTime() - l.hace * 60_000).toISOString()),
    ids: lineas.map((l) => l.id),
    lecturas: lineas.map((l) => l.lectura ?? null),
  };
}

const cliente = (id: string, texto: string, hace: number, lectura?: Linea["lectura"]): Linea => ({
  rol: "user",
  texto,
  hace,
  id,
  lectura,
});
const bot = (id: string, texto: string, hace: number): Linea => ({ rol: "assistant", texto, hace, id });

/** Una conversación ya empezada hace una hora: la ventana NO es nueva y no hay apertura. */
const CONVERSACION_VIVA: Linea[] = [cliente("m0", "hola", 60), bot("m0b", "Dime, ¿qué buscas?", 59)];

function consulta(resultado: ConsultaCatalogo["resultado"] = "con_existencia"): ConsultaCatalogo {
  return {
    v: 2,
    query: "impermeable",
    productos: null,
    moto: [],
    cilindrada: [],
    grupos: [],
    opcionales: [],
    variantes: [],
    anio: [],
    motoMarca: [],
    motoIgnorada: false,
    calzaEntero: false,
    relajados: [],
    avisos: [],
    corregido: null,
    correccionDescartada: null,
    decision: "",
    cotizados: [],
    conteos: null,
    resultado,
  };
}

function linea(productId: string, nombre: string, stock: number, extra: Partial<LineaCotizada> = {}): LineaCotizada {
  return { productId, nombre, precioUsd: 30, precioBs: 1200, stock, productoPedido: null, ...extra };
}

// ---------------------------------------------------------- catálogo falso

type GuionDeCatalogo = (outcome: CatalogOutcome) => unknown;

/** La búsqueda de v1 falsa: muta el `catalogOutcome` como lo haría la real y devuelve una salida con precios (la fuente de las cifras). */
function catalogoFalso(guion: GuionDeCatalogo): typeof buildCatalogTool {
  return ((_deps: unknown, outcome: CatalogOutcome) =>
    tool({
      description: "búsqueda falsa de v1",
      inputSchema: z.object({ query: z.string().optional() }),
      execute: async () => guion(outcome),
    })) as unknown as typeof buildCatalogTool;
}

/** Una búsqueda que cotiza estas líneas. */
function cotiza(lineas: LineaCotizada[], extra: Partial<CatalogOutcome> = {}): GuionDeCatalogo {
  return (outcome) => {
    outcome.ran = true;
    outcome.cotizacion.push(...lineas);
    if (lineas.some((l) => l.stock > 0)) outcome.conExistencia = true;
    else outcome.agotados = true;
    outcome.consultas.push(consulta(lineas.some((l) => l.stock > 0) ? "con_existencia" : "agotados"));
    Object.assign(outcome, extra);
    return {
      results: lineas.map((l) => ({ id: l.productId, name: l.nombre, price: `${l.precioUsd} USD`, stock: l.stock })),
    };
  };
}

/** Una búsqueda que no encuentra nada. */
const sinResultados: GuionDeCatalogo = (outcome) => {
  outcome.ran = true;
  outcome.sinResultados = true;
  outcome.consultas.push(consulta("sin_resultados"));
  return { results: [] };
};

/** La biblioteca falsa: devuelve siempre este contenido. */
function bibliotecaFalsa(contenido: unknown) {
  return (() =>
    tool({
      description: "biblioteca falsa",
      inputSchema: z.object({ tema: z.string() }),
      execute: async () => contenido,
    })) as unknown as DepsDeTurno["construirBiblioteca"];
}

// ------------------------------------------------------------ modelo falso

interface PasoDeModelo {
  herramientas?: { nombre: string; entrada: unknown }[];
  texto?: string;
  lanza?: Error;
  /** Imita al SDK: un error de herramienta no lanza, queda como parte del paso y el bucle sigue hasta `stopWhen`. */
  tragaErrores?: boolean;
  uso?: { input?: number; output?: number; cache?: number; razonamiento?: number };
}

type CondicionDeParada = (o: { steps: unknown[] }) => boolean;

function crearGenerar(pasos: PasoDeModelo[]) {
  const llamadas: Record<string, unknown>[] = [];
  const mock = vi.fn(async (opciones: Record<string, unknown>) => {
    llamadas.push(opciones);
    const paso = pasos.shift() ?? { texto: "" };
    if (paso.lanza) throw paso.lanza;

    const tools = (opciones.tools ?? {}) as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>;
    const paradas = ([] as CondicionDeParada[]).concat((opciones.stopWhen ?? []) as CondicionDeParada | CondicionDeParada[]);
    const steps: { toolName: string }[] = [];
    for (const h of paso.herramientas ?? []) {
      const herramienta = tools[h.nombre];
      if (!herramienta) throw new Error(`El modelo llamó a «${h.nombre}», que no recibió`);
      try {
        await herramienta.execute(h.entrada, OPCIONES_DE_HERRAMIENTA);
      } catch (err) {
        if (!paso.tragaErrores) throw err;
      }
      steps.push({ toolName: h.nombre });
      if (paradas.some((parada) => parada({ steps }))) break;
    }

    return {
      text: paso.texto ?? "",
      steps,
      usage: {
        inputTokens: paso.uso?.input ?? 100,
        outputTokens: paso.uso?.output ?? 20,
        inputTokenDetails: { cacheReadTokens: paso.uso?.cache ?? 10 },
        outputTokenDetails: { reasoningTokens: paso.uso?.razonamiento ?? 5 },
      },
    };
  });
  return { generar: mock as unknown as typeof generateText, llamadas, mock };
}

// ------------------------------------------------------------------ montaje

interface OpcionesDeMontaje {
  historial: Linea[];
  datos?: Partial<DatosDeTurno>;
  efectos?: GuionDeMemoria;
  modelo?: PasoDeModelo[];
  productos?: Product[];
  catalogo?: GuionDeCatalogo;
  biblioteca?: unknown;
  visto?: SeenMarker | null;
  tasa?: number | null;
}

function montar(o: OpcionesDeMontaje) {
  const efectos = crearEffectsDeMemoria(o.efectos);
  const { generar, llamadas, mock } = crearGenerar([...(o.modelo ?? [])]);
  const productos = o.productos ?? [producto()];
  const modelo = vi.fn((fase: "redactar" | "identidad") => ({ model: `modelo-${fase}` as unknown as LanguageModel }));
  const deps: DepsDeTurno = {
    cargarDatos: vi.fn(async () => datos(o.datos)),
    esperarLecturas: vi.fn(async () => undefined),
    generar,
    modelo,
    etiquetaDeModelo: () => "openai/modelo-de-prueba",
    cargarProductos: vi.fn(async (ids: string[]) => productos.filter((p) => ids.includes(p.id))),
    leerTasa: vi.fn(async () => (o.tasa === undefined ? 40 : o.tasa)),
    construirCatalogo: catalogoFalso(o.catalogo ?? sinResultados),
    construirBiblioteca: bibliotecaFalsa(o.biblioteca ?? { resultados: [] }),
  };
  const entrada: EntradaDeTurno = {
    supabase: {} as SupabaseClient<Database>,
    conversationId: "conv-1",
    ahora: AHORA,
    iaGlobal: true,
    visto: o.visto ?? null,
    persistencia: "ninguna",
    cargarHistorial: async () => historial(o.historial),
    deps,
  };
  return {
    efectos,
    deps,
    llamadas,
    generar: mock,
    modelo,
    correr: () => runSeba2Turn(entrada, efectos),
  };
}

const textos = (m: ReturnType<typeof montar>) => m.efectos.registro.mensajes.map((x) => x.texto);

/** Los nombres de las herramientas que recibió una llamada al modelo. */
function herramientasDe(llamada: Record<string, unknown>): string[] {
  return Object.keys((llamada.tools ?? {}) as Record<string, unknown>).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================== los casos

describe("El turno de Seba v2: la apertura", () => {
  it("1. «Buenas» en ventana nueva: bienvenida y frase fija, ambas «fijo», y el modelo no se llama", async () => {
    const m = montar({ historial: [cliente("m1", "Buenas", 1)] });

    const resumen = await m.correr();

    expect(m.efectos.registro.mensajes).toEqual([
      { orden: 1, tipo: "texto", texto: BIENVENIDA, origen: "fijo" },
      { orden: 2, tipo: "texto", texto: FRASE_FIJA, origen: "fijo" },
    ]);
    expect(m.generar).not.toHaveBeenCalled();
    expect(resumen.accion).toBe("answered");
    expect(resumen.tokens).toBeNull();
    expect(resumen.modelo).toBeNull();
    // La frase usada queda en el estado para no repetirla en la próxima apertura.
    expect(m.efectos.registro.estado?.ultimaFraseApertura).toBe(FRASE_FIJA);
    expect(m.efectos.registro.vistos).toEqual([{ hasta: expect.any(String), ids: ["m1"] }]);
  });

  it("si otro turno ya dio la bienvenida, no se manda ni la bienvenida ni la frase y el modelo corre con «Apertura: no»", async () => {
    const m = montar({
      historial: [cliente("m1", "Buenas", 1)],
      efectos: { bienvenidaDisponible: false },
      modelo: [{ texto: "Dime qué necesitas." }],
    });

    await m.correr();

    expect(m.generar).toHaveBeenCalledTimes(1);
    expect(String(m.llamadas[0].system)).toContain("Apertura: no");
    expect(textos(m)).toEqual(["Dime qué necesitas."]);
  });

  it("2. «Precio del impermeable» en ventana nueva: bienvenida, cotización y línea de cierre; nunca «¿en qué te puedo ayudar?»", async () => {
    const m = montar({
      historial: [cliente("m1", "Precio del impermeable", 1)],
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "" }],
    });

    const resumen = await m.correr();

    const mensajes = m.efectos.registro.mensajes;
    expect(mensajes).toHaveLength(3);
    expect(mensajes[0]).toMatchObject({ texto: BIENVENIDA, origen: "fijo" });
    expect(mensajes[1]).toMatchObject({ tipo: "texto", origen: "herramienta" });
    expect(mensajes[1].texto).toContain("IMPERMEABLE GIVI TALLA L");
    expect(mensajes[1].texto).toContain("$30,00 BCV");
    expect(mensajes[2]).toMatchObject({ texto: LINEA_CIERRE_COTIZACION, origen: "fijo" });
    expect(mensajes.length).toBeLessThanOrEqual(SEBA2_MAX_MENSAJES);
    for (const t of textos(m)) expect(t.toLowerCase()).not.toContain("en qué te puedo ayudar");

    expect(String(m.llamadas[0].system)).toContain("Apertura: sí");
    expect(resumen.herramientas).toContain("buscarRepuesto");
    expect(resumen.productos).toEqual([ID_CASCO]);
    expect(m.efectos.registro.estado).toMatchObject({
      etapa: "cotizado",
      lineas: [{ productId: ID_CASCO, cantidad: 1 }],
    });
  });
});

describe("El turno de Seba v2: cotizar", () => {
  it("la línea del modelo sale con origen «modelo» si pasa las guardas, y reemplaza al cierre fijo", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable", 1)],
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "¿Lo quieres llevar? ¿Cashea o de contado?" }],
    });

    await m.correr();

    expect(m.efectos.registro.mensajes.map((x) => x.origen)).toEqual(["herramienta", "modelo"]);
    expect(textos(m)[1]).toBe("¿Lo quieres llevar? ¿Cashea o de contado?");
  });

  it("con foto y un bloque de 1.000 caracteres o menos: UNA imagen con el bloque de pie, y después la línea", async () => {
    const foto = { id: "f1", storagePath: "casco.jpg", url: "https://fotos.example/casco.jpg", isPrimary: true, position: 0 };
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable", 1)],
      productos: [producto({ fotos: [foto] })],
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "" }],
    });

    await m.correr();

    const mensajes = m.efectos.registro.mensajes;
    expect(mensajes).toHaveLength(2);
    expect(mensajes[0]).toMatchObject({ tipo: "imagen", mediaUrl: "https://fotos.example/casco.jpg", origen: "herramienta" });
    expect(mensajes[0].texto).toContain("IMPERMEABLE GIVI TALLA L");
    expect(mensajes[1]).toMatchObject({ tipo: "texto", texto: LINEA_CIERRE_COTIZACION });
  });

  it("todo agotado: se dice «Agotado», no se ofrece llevarlo ni se avanza la etapa", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable", 1)],
      productos: [producto({ stockQuantity: 0 })],
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 0)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "" }],
    });

    await m.correr();

    expect(textos(m)).toHaveLength(1);
    expect(textos(m)[0]).toContain("Agotado");
    expect(textos(m).join("\n")).not.toContain(LINEA_CIERRE_COTIZACION);
    expect(m.efectos.registro.estado?.etapa).toBe("entender");
  });

  it("una pregunta de filtro sale una sola vez, como mensaje único", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "tienen pastillas de freno?", 1)],
      catalogo: (outcome) => {
        outcome.ran = true;
        outcome.generico = true;
        outcome.preguntaFiltro = "moto";
        outcome.consultas.push(consulta("generico"));
        return { results: [] };
      },
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "pastillas" } }], texto: "" }],
    });

    await m.correr();

    expect(textos(m)).toEqual(["Claro, ¿para qué modelo y año de moto las buscas?"]);
    expect(m.efectos.registro.mensajes[0].origen).toBe("fijo");
  });

  it("el cliente no nombró un repuesto y el modelo calla: «¿Qué repuesto o accesorio estás buscando?» (no se pasa el caso)", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "tengo una consulta", 1)],
      catalogo: (outcome) => {
        outcome.ran = true;
        outcome.generico = true;
        return { results: [] };
      },
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "" } }], texto: "" }],
    });

    await m.correr();

    expect(textos(m)).toEqual([PREGUNTA_QUE_BUSCA]);
    expect(m.efectos.registro.pases).toEqual([]);
  });

  it("un texto del modelo sin búsqueda se parte por párrafos (como mucho tres mensajes)", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "a qué hora cierran?", 1)],
      modelo: [{ texto: "Abrimos de 8 a 6.\n\nLos sábados hasta la 1." }],
    });

    await m.correr();

    expect(textos(m)).toEqual(["Abrimos de 8 a 6.", "Los sábados hasta la 1."]);
    expect(m.efectos.registro.mensajes.every((x) => x.origen === "modelo")).toBe(true);
  });
});

describe("El turno de Seba v2: el flujo de pago móvil, en cuatro ráfagas encadenadas", () => {
  it("3. cotiza → acepta y elige forma → datos de pago → comprobante, y el estado de cada una alimenta la siguiente", async () => {
    const base: Linea[] = [...CONVERSACION_VIVA];

    // R1: cotiza.
    const r1 = montar({
      historial: [...base, cliente("m1", "precio del impermeable", 20)],
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "" }],
    });
    const resumen1 = await r1.correr();
    expect(resumen1.estadoDespues?.etapa).toBe("cotizado");
    const estado1 = r1.efectos.registro.estado as EstadoSeba;
    const dicho1 = textos(r1);

    // R2: acepta; el modelo pregunta cómo paga.
    const r2 = montar({
      historial: [
        ...base,
        cliente("m1", "precio del impermeable", 20),
        ...dicho1.map((t, i) => bot(`b1-${i}`, t, 19)),
        cliente("m2", "sí, lo quiero", 15),
      ],
      efectos: { estado: estado1, yaCotizados: resumen1.productos },
      modelo: [{ texto: "¿Cómo prefieres pagar, con Cashea o de contado?" }],
    });
    const resumen2 = await r2.correr();
    expect(resumen2.estadoDespues?.etapa).toBe("eligiendo_pago");
    expect(String(r2.llamadas[0].system)).toContain("Etapa: cotizado");
    expect(String(r2.llamadas[0].system)).toContain("1 × IMPERMEABLE GIVI TALLA L");
    const estado2 = r2.efectos.registro.estado as EstadoSeba;
    expect(estado2.etapa).toBe("eligiendo_pago");

    // R3: elige pago móvil y retiro: prepararPago entrega los datos y el texto del modelo se DESCARTA.
    const r3 = montar({
      historial: [
        ...base,
        cliente("m3", "pago móvil, lo retiro en tienda", 10),
      ],
      efectos: { estado: estado2, yaCotizados: resumen1.productos },
      modelo: [
        {
          herramientas: [
            {
              nombre: "prepararPago",
              entrada: {
                lineas: [{ productId: ID_CASCO, cantidad: 1 }],
                formaDePago: "pago_movil",
                entrega: "retiro",
              },
            },
          ],
          texto: "¡Listo! Ya te envié los datos, cuando pagues mándame el capture.",
        },
      ],
    });
    const resumen3 = await r3.correr();
    expect(resumen3.estadoDespues?.etapa).toBe("datos_enviados");
    expect(textos(r3)).toHaveLength(1);
    expect(textos(r3)[0]).toContain("Total: $30,00 BCV (Bs. 1.200,00)");
    expect(textos(r3)[0]).toContain("Banco X");
    expect(textos(r3).join("\n")).not.toContain("¡Listo! Ya te envié");
    expect(r3.efectos.registro.mensajes[0].origen).toBe("herramienta");
    const estado3 = r3.efectos.registro.estado as EstadoSeba;

    // R4: llega la captura del pago. El código la recibe SIN llamar al modelo.
    const comprobante = {
      tipo: "comprobante_pago",
      es_comprobante_pago: true,
      texto_visible: "Pago móvil realizado",
      comprobante: { monto: 1200, referencia: "987654", banco: "Banesco", fecha: "2026-11-17" },
    };
    const r4 = montar({
      historial: [
        ...base,
        cliente("m4", "[El cliente envió una foto]", 2, { status: "ok", text: "Comprobante", fields: comprobante }),
      ],
      efectos: { estado: estado3, yaCotizados: resumen1.productos },
    });
    const resumen4 = await r4.correr();

    expect(r4.generar).not.toHaveBeenCalled();
    expect(r4.efectos.registro.pases).toHaveLength(1);
    expect(r4.efectos.registro.pases[0]).toMatchObject({ area: "pagos", motivo: "comprobante_pago" });
    // El pase va ANTES del acuse: si fallara después, el cliente creería que alguien tiene su comprobante.
    expect(r4.efectos.registro.secuencia.indexOf("pasarAAsesor")).toBeLessThan(
      r4.efectos.registro.secuencia.indexOf("enviarTexto")
    );
    expect(textos(r4)[0]).toBe(TEXTO_COMPROBANTE_RECIBIDO);
    expect(resumen4.estadoDespues?.etapa).toBe("comprobante_recibido");
    expect(resumen4.accion).toBe("escalated");
  });

  it("un cliente que dice haber pagado con una captura de Cashea: comprobante por código, medio Cashea y se pide la cédula", async () => {
    const orden = {
      tipo: "orden_cashea",
      es_comprobante_pago: false,
      texto_visible: "Orden de compra",
      orden_cashea: { numero: "A-1" },
    };
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "[El cliente envió una foto]", 2, { status: "ok", text: "Orden", fields: orden })],
    });

    await m.correr();

    expect(m.generar).not.toHaveBeenCalled();
    expect(m.efectos.registro.pases[0]).toMatchObject({ area: "pagos", motivo: "comprobante_pago" });
    expect(textos(m).some((t) => t.includes("cédula del titular de Cashea"))).toBe(true);
  });
});

describe("El turno de Seba v2: Cashea, reclamos y la red de promesa", () => {
  it("4. Cashea: resumen y pase a ventas; ningún mensaje trae «inicial de» ni «cuota de»", async () => {
    const estado: EstadoSeba = {
      etapa: "eligiendo_pago",
      lineas: [{ productId: ID_CASCO, cantidad: 1 }],
      forma: null,
      entrega: null,
      ciudad: null,
      totalUsd: null,
      totalBs: null,
      priceKind: null,
      complementoSugerido: false,
      ultimaFraseApertura: null,
      actualizadoEn: AHORA.toISOString(),
    };
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "con cashea, lo envían a Caracas", 1)],
      efectos: { estado, yaCotizados: [ID_CASCO] },
      modelo: [
        {
          herramientas: [
            {
              nombre: "prepararPago",
              entrada: {
                lineas: [{ productId: ID_CASCO, cantidad: 1 }],
                formaDePago: "cashea",
                entrega: "envio",
                ciudad: "Caracas",
              },
            },
          ],
          texto: "Un asesor te envía el enlace por este chat.",
        },
      ],
    });

    const resumen = await m.correr();

    expect(m.efectos.registro.pases).toEqual([
      expect.objectContaining({ area: "ventas", motivo: "listo_para_comprar" }),
    ]);
    expect(textos(m)[0]).toContain("Total: $30,00 BCV");
    expect(textos(m)[0]).toContain("Cédula del titular");
    for (const t of textos(m)) {
      expect(t.toLowerCase()).not.toContain("inicial de");
      expect(t.toLowerCase()).not.toContain("cuota de");
    }
    expect(resumen.estadoDespues?.etapa).toBe("con_asesor");
    expect(resumen.accion).toBe("escalated");
  });

  it("5. Reclamo: el modelo pasa el caso con «reclamo_producto»: un envío, pase a «reclamos» y el pase ANTES del envío", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "el casco me llegó roto", 1)],
      modelo: [
        {
          herramientas: [
            {
              nombre: "pasarAAsesor",
              entrada: {
                motivo: "reclamo_producto",
                nota: "El cliente recibió el casco roto y quiere una solución.",
                mensajeAlCliente: "Lamentamos lo ocurrido. Ya pasé tu caso al área de reclamos y te escriben por este mismo chat.",
              },
            },
          ],
          texto: "Texto que no debe salir.",
        },
      ],
    });

    await m.correr();

    expect(m.efectos.registro.pases).toEqual([expect.objectContaining({ area: "reclamos", motivo: "reclamo_producto" })]);
    expect(textos(m)).toHaveLength(1);
    expect(textos(m)[0]).toMatch(/^Lamentamos lo ocurrido/);
    expect(m.efectos.registro.secuencia.indexOf("pasarAAsesor")).toBeLessThan(
      m.efectos.registro.secuencia.indexOf("enviarTexto")
    );
  });

  it("13. si una herramienta termina el turno, el texto del modelo se DESCARTA", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "quiero hablar con una persona", 1)],
      modelo: [
        {
          herramientas: [
            {
              nombre: "pasarAAsesor",
              entrada: {
                motivo: "pide_persona",
                nota: "El cliente pide hablar con una persona.",
                mensajeAlCliente: "Claro, ya pasé tu caso a un asesor de ventas y te escribe por este chat.",
              },
            },
          ],
          texto: "Y además te cuento que tenemos ofertas.",
        },
      ],
    });

    await m.correr();

    expect(textos(m)).toHaveLength(1);
    expect(textos(m).join("\n")).not.toContain("ofertas");
  });

  it("15. red de promesa: un texto enviado que afirma un asesor sin pase se vuelve verdad pasando el caso por código", async () => {
    // La cotización de una moto sin calce trae «El asesor te confirma cuál le sirve a tu SBR.» (texto de v1, origen herramienta).
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "tienen un asiento para mi sbr?", 1)],
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)], {
        avisos: [{ tipo: "moto_sin_calce", moto: "SBR", productoPedido: null }],
      }),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "asiento" } }], texto: "" }],
    });

    const resumen = await m.correr();

    expect(textos(m).join("\n")).toContain("El asesor te confirma cuál le sirve a tu SBR.");
    expect(m.efectos.registro.pases).toHaveLength(1);
    expect(m.efectos.registro.pases[0]).toMatchObject({ area: "ventas", motivo: "otro" });
    expect(m.efectos.registro.pases[0].nota).toContain("El asesor te confirma");
    // Sin texto nuevo: el cliente ya leyó la promesa.
    expect(m.efectos.registro.mensajes.filter((x) => x.origen === "fijo")).toHaveLength(1); // solo el cierre de la cotización
    expect(resumen.accion).toBe("escalated");
  });

  it("la red de promesa no se dispara por la bienvenida configurada ni con la escalada ya abierta", async () => {
    // Ventana nueva con una pregunta: sale la bienvenida (que habla de un asesor) y el modelo contesta sin promesas.
    const conPromesa = montar({
      historial: [cliente("m1", "a qué hora abren?", 1)],
      datos: { config: { ...datos().config, welcomeText: "Un asesor te atiende cuando lo necesites." } },
      modelo: [{ texto: "Abrimos de lunes a viernes." }],
    });
    await conPromesa.correr();
    expect(textos(conPromesa)).toEqual(["Un asesor te atiende cuando lo necesites.", "Abrimos de lunes a viernes."]);
    expect(conPromesa.efectos.registro.pases).toEqual([]);

    const escalada = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "y cuándo me escriben?", 1)],
      datos: { escaladaAbierta: true, esperaDeAsesor: { area: "ventas", minutos: 12 } },
      modelo: [{ texto: "Un asesor te confirma en cuanto pueda." }],
    });
    await escalada.correr();
    expect(escalada.efectos.registro.pases).toEqual([]);
    expect(textos(escalada)).toEqual(["Un asesor te confirma en cuanto pueda."]);
  });
});

describe("El turno de Seba v2: con la escalada abierta", () => {
  const ESPERA = { escaladaAbierta: true, esperaDeAsesor: { area: "ventas" as const, minutos: 12 } };

  it("6a. «gracias» solo: cero envíos, silencio «cortesia_tras_escalada» y el modelo no se llama", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "gracias", 1)],
      datos: ESPERA,
    });

    const resumen = await m.correr();

    expect(m.efectos.registro.mensajes).toEqual([]);
    expect(m.efectos.registro.silencios).toEqual(["cortesia_tras_escalada"]);
    expect(m.generar).not.toHaveBeenCalled();
    expect(m.efectos.registro.vistos).toHaveLength(1);
    expect(resumen.accion).toBe("skipped");
  });

  it("6b. una pregunta: el modelo recibe SOLO «consultarBiblioteca» y la línea de espera; sin texto, nota para el asesor y cero envíos", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "es para una SBR 2020", 1)],
      datos: ESPERA,
      modelo: [{ texto: "" }],
    });

    await m.correr();

    expect(herramientasDe(m.llamadas[0])).toEqual(["consultarBiblioteca"]);
    expect(String(m.llamadas[0].system)).toContain("Espera de asesor: sí, área ventas desde hace 12 min");
    expect(String(m.llamadas[0].system)).toContain("Apertura: no");
    expect(m.efectos.registro.mensajes).toEqual([]);
    expect(m.efectos.registro.notas).toEqual([
      "Mientras espera al asesor, el cliente agregó: «es para una SBR 2020»",
    ]);
    expect(m.efectos.registro.pases).toEqual([]);
    expect(m.efectos.registro.vistos).toHaveLength(1);
  });

  it("6c. si el modelo contesta algo informativo que pasa las guardas, sale UN mensaje y no hay nota", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "a qué hora abren?", 1)],
      datos: ESPERA,
      modelo: [{ texto: "Abrimos de lunes a viernes.\n\nLos sábados hasta la 1." }],
    });

    await m.correr();

    expect(textos(m)).toEqual(["Abrimos de lunes a viernes.\n\nLos sábados hasta la 1."]);
    expect(m.efectos.registro.notas).toEqual([]);
  });

  it("si el texto del modelo no pasa las guardas (ni reescrito), no se le escribe: queda en una nota para el asesor", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "cuál es el precio?", 1)],
      datos: ESPERA,
      modelo: [{ texto: "Son 99$ BCV, un descuento." }, { texto: "Entonces son 99$ BCV." }],
    });

    const resumen = await m.correr();

    expect(m.efectos.registro.mensajes).toEqual([]);
    expect(m.efectos.registro.notas[0]).toContain("«cuál es el precio?»");
    expect(resumen.guardas).toHaveLength(2);
  });

  it("la nota cita como mucho cinco líneas de 300 caracteres", async () => {
    const largas = Array.from({ length: 7 }, (_, i) => cliente(`m${i + 1}`, `${i + 1}${"x".repeat(400)}`, 7 - i));
    const m = montar({ historial: [...CONVERSACION_VIVA, ...largas], datos: ESPERA, modelo: [{ texto: "" }] });

    await m.correr();

    const nota = m.efectos.registro.notas[0];
    expect(nota.match(/«/g)).toHaveLength(5);
    expect(nota).toContain("(+2 más)");
    expect(nota).toContain(`${"x".repeat(299)}…»`);
  });

  it("si la nota para el asesor no se puede escribir, el turno LANZA antes de marcar «visto»", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "es para una SBR", 1)],
      datos: ESPERA,
      efectos: { notaLanza: new Error("no se pudo escribir") },
      modelo: [{ texto: "" }],
    });

    await expect(m.correr()).rejects.toThrow("no se pudo escribir");

    expect(m.efectos.registro.vistos).toEqual([]);
    expect(m.efectos.registro.cierre?.accion).toBe("error");
  });

  it("un comprobante con la escalada abierta se recibe igual, por código", async () => {
    const comprobante = { tipo: "comprobante_pago", es_comprobante_pago: true, texto_visible: "Pago móvil" };
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "[El cliente envió una foto]", 1, { status: "ok", text: "c", fields: comprobante })],
      datos: ESPERA,
    });

    await m.correr();

    expect(m.generar).not.toHaveBeenCalled();
    expect(m.efectos.registro.pases[0]).toMatchObject({ area: "pagos", motivo: "comprobante_pago" });
  });
});

describe("El turno de Seba v2: sin nada que contestar y modos sin envío", () => {
  it("7. sin ráfaga pendiente: cero envíos, silencio «sin_mensaje_nuevo» y el modelo no se llama", async () => {
    const mensaje = cliente("m1", "precio del casco", 5);
    const visto: SeenMarker = { hasta: new Date(AHORA.getTime() - 5 * 60_000).toISOString(), ids: ["m1"] };
    const m = montar({ historial: [mensaje], visto });

    const resumen = await m.correr();

    expect(m.efectos.registro.mensajes).toEqual([]);
    expect(m.efectos.registro.silencios).toEqual(["sin_mensaje_nuevo"]);
    expect(m.generar).not.toHaveBeenCalled();
    expect(m.efectos.registro.vistos).toEqual([]);
    expect(resumen.accion).toBe("skipped");
    expect(m.efectos.registro.cierre).toBe(resumen);
  });

  it("8. en sombra y copiloto el historial que recibe el modelo termina en el cliente aunque el cargado traiga una respuesta posterior; en real no", async () => {
    const conRespuesta: Linea[] = [
      cliente("m1", "precio del casco", 10),
      bot("m2", "Tenemos el casco a 30$ BCV.", 9),
    ];

    for (const modo of ["sombra", "copiloto", "memoria"] as const) {
      const m = montar({ historial: conRespuesta, efectos: { modo }, modelo: [{ texto: "Claro, te ayudo con el casco." }] });
      await m.correr();
      const mensajes = m.llamadas[0].messages as { role: string }[];
      expect(mensajes.at(-1)?.role).toBe("user");
      expect(mensajes).toHaveLength(1);
    }

    // En real el historial se ve completo: la respuesta ya salió y no queda nada que contestar.
    const real = montar({ historial: conRespuesta, modelo: [{ texto: "no debe llamarse" }] });
    (real.efectos as { modo: string }).modo = "real";
    await real.correr();
    expect(real.generar).not.toHaveBeenCalled();
    expect(real.efectos.registro.silencios).toEqual(["sin_mensaje_nuevo"]);
  });
});

describe("El turno de Seba v2: cesión, tope y fallos de envío", () => {
  it("9. cesión: con un mensaje nuevo del cliente tras el primer envío, el segundo no sale", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable", 1)],
      efectos: { mensajeNuevoTrasEnvios: 1 },
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "¿Lo quieres llevar?" }],
    });

    const resumen = await m.correr();

    expect(m.efectos.registro.mensajes).toHaveLength(1);
    expect(m.efectos.registro.mensajes[0].origen).toBe("herramienta");
    // Contestó algo: se marca visto (el mensaje nuevo queda por delante de la marca).
    expect(m.efectos.registro.vistos).toHaveLength(1);
    expect(resumen.accion).toBe("answered");
  });

  it("si cede antes de enviar nada, no se marca «visto» ni se avanza el estado: la ráfaga sigue pendiente", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable", 1)],
      efectos: { mensajeNuevoTrasEnvios: 0 },
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "" }],
    });

    const resumen = await m.correr();

    expect(m.efectos.registro.mensajes).toEqual([]);
    expect(m.efectos.registro.vistos).toEqual([]);
    expect(m.efectos.registro.secuencia).not.toContain("guardarEstado");
    expect(resumen.accion).toBe("skipped");
    expect(resumen.estadoDespues?.etapa).toBe("entender");
  });

  it("un envío que falla antes de enviar nada: no se intenta ninguno más, no se marca «visto» y no se relanza", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable", 1)],
      efectos: { envioFalla: true },
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "¿Lo quieres llevar?" }],
    });

    const resumen = await m.correr();

    expect(m.efectos.registro.secuencia.filter((x) => x === "enviarTexto")).toHaveLength(1);
    expect(m.efectos.registro.vistos).toEqual([]);
    expect(resumen.accion).toBe("error");
  });

  it("14a. nunca más de tres mensajes: bienvenida + foto con pie + línea son exactamente tres", async () => {
    const foto = { id: "f1", storagePath: "casco.jpg", url: "https://fotos.example/casco.jpg", isPrimary: true, position: 0 };
    const m = montar({
      historial: [cliente("m1", "precio del impermeable", 1)],
      productos: [producto({ fotos: [foto] })],
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "" }],
    });

    await m.correr();

    expect(m.efectos.registro.mensajes.map((x) => x.tipo)).toEqual(["texto", "imagen", "texto"]);
  });

  it("14b. con un bloque de más de 1.000 caracteres la foto va sin pie; la línea se une al bloque para no pasar de tres", async () => {
    const nombreLargo = `IMPERMEABLE ${"GIVI ".repeat(220)}`.trim();
    const foto = { id: "f1", storagePath: "casco.jpg", url: "https://fotos.example/casco.jpg", isPrimary: true, position: 0 };
    const m = montar({
      historial: [cliente("m1", "precio del impermeable", 1)],
      productos: [producto({ name: nombreLargo, fotos: [foto] })],
      catalogo: cotiza([linea(ID_CASCO, nombreLargo, 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "" }],
    });

    await m.correr();

    const mensajes = m.efectos.registro.mensajes;
    expect(mensajes).toHaveLength(SEBA2_MAX_MENSAJES);
    expect(mensajes.map((x) => x.tipo)).toEqual(["texto", "imagen", "texto"]);
    expect(mensajes[1].texto).toBe("");
    expect(mensajes[2].texto).toContain(nombreLargo);
    expect(mensajes[2].texto).toContain(LINEA_CIERRE_COTIZACION);
  });

  it("14c. un texto largo del modelo tras la bienvenida: lo que sobra se une al último mensaje, nada se pierde", async () => {
    const m = montar({
      historial: [cliente("m1", "hola, a qué hora cierran y dónde quedan?", 1)],
      modelo: [{ texto: "Uno.\n\nDos.\n\nTres.\n\nCuatro." }],
    });

    await m.correr();

    const dichos = textos(m);
    expect(dichos).toHaveLength(SEBA2_MAX_MENSAJES);
    expect(dichos[0]).toBe(BIENVENIDA);
    expect(dichos.join("\n")).toContain("Cuatro.");
  });
});

describe("El turno de Seba v2: las guardas de salida", () => {
  const cotizaYLineaDe = (linea1: string, ...reescrituras: string[]) =>
    montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable", 1)],
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [
        { herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: linea1 },
        ...reescrituras.map((texto) => ({ texto })),
      ],
    });

  it("10a. el modelo se nombra «Seba»: una reescritura; si pasa, sale la reescrita", async () => {
    const m = cotizaYLineaDe("Soy Seba, ¿lo quieres llevar?", "¿Lo quieres llevar?");

    const resumen = await m.correr();

    expect(textos(m)).toHaveLength(2);
    expect(textos(m)[1]).toBe("¿Lo quieres llevar?");
    expect(m.efectos.registro.mensajes[1].origen).toBe("modelo");
    expect(resumen.guardas).toHaveLength(1);

    // La reescritura: sin herramientas, con el modelo de «identidad», tope de 300 tokens y el mismo system y mensajes.
    expect(m.generar).toHaveBeenCalledTimes(2);
    const reescritura = m.llamadas[1];
    expect(reescritura.tools).toBeUndefined();
    expect(reescritura.maxOutputTokens).toBe(300);
    expect(reescritura.model).toBe("modelo-identidad");
    expect(reescritura.system).toBe(m.llamadas[0].system);
    const mensajes = reescritura.messages as { role: string; content: string }[];
    expect(mensajes.at(-1)?.role).toBe("user");
    expect(mensajes.at(-1)?.content).toContain("Reescribe tu respuesta");
    expect(mensajes.at(-1)?.content).not.toMatch(/seba/i);
  });

  it("10b. si la reescritura tampoco pasa, sale el respaldo (la línea fija) y las dos guardas quedan en el resumen", async () => {
    const m = cotizaYLineaDe("Soy Seba, ¿lo quieres llevar?", "Seba te atiende, ¿lo llevas?");

    const resumen = await m.correr();

    expect(textos(m)).toHaveLength(2);
    expect(m.efectos.registro.mensajes[1]).toMatchObject({ texto: LINEA_CIERRE_COTIZACION, origen: "fijo" });
    expect(resumen.guardas).toHaveLength(2);
    expect(resumen.guardas.every((g) => g.guarda === "nombre_propio" || g.guarda === "identidad")).toBe(true);
    expect(m.generar).toHaveBeenCalledTimes(2);
  });

  it("si la reescritura lanza, se trata como una que no pasó (respaldo fijo), sin tumbar el turno", async () => {
    const m = cotizaYLineaDe("Soy Seba, ¿lo quieres llevar?");
    m.generar.mockImplementationOnce(m.generar.getMockImplementation()!).mockImplementationOnce(async () => {
      throw new Error("proveedor caído");
    });

    const resumen = await m.correr();

    expect(m.efectos.registro.mensajes[1]).toMatchObject({ texto: LINEA_CIERRE_COTIZACION, origen: "fijo" });
    expect(resumen.accion).toBe("answered");
  });

  it("una cifra con fuente en la biblioteca de ESTE turno puede citarse; sin esa consulta, se frena", async () => {
    const conFuente = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "cuál es la compra mínima?", 1)],
      biblioteca: { resultados: [{ title: "Cashea", content: "La compra mínima con Cashea es de $25 BCV." }] },
      modelo: [
        {
          herramientas: [{ nombre: "consultarBiblioteca", entrada: { tema: "cashea" } }],
          texto: "La compra mínima con Cashea es de $25 BCV.",
        },
      ],
    });
    const r1 = await conFuente.correr();
    expect(textos(conFuente)).toEqual(["La compra mínima con Cashea es de $25 BCV."]);
    expect(r1.herramientas).toContain("consultarBiblioteca");
    expect(r1.guardas).toEqual([]);

    const sinFuente = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "cuál es la compra mínima?", 1)],
      modelo: [{ texto: "La compra mínima con Cashea es de $25 BCV." }, { texto: "Son $25 BCV de mínimo." }],
    });
    const r2 = await sinFuente.correr();
    expect(r2.guardas.map((g) => g.guarda)).toEqual(["cifra_sin_fuente", "cifra_sin_fuente"]);
    // Sin texto usable, el cliente nunca queda sin respuesta ni sin dueño.
    expect(sinFuente.efectos.registro.pases).toHaveLength(1);
  });
});

describe("El turno de Seba v2: cuando el modelo no deja nada que decir", () => {
  it("11a. sin texto tras una búsqueda sin resultados: pase por código con «no_identificado»", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "busco una pieza rara", 1)],
      catalogo: sinResultados,
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "pieza rara" } }], texto: "" }],
    });

    const resumen = await m.correr();

    expect(m.efectos.registro.pases).toHaveLength(1);
    expect(m.efectos.registro.pases[0]).toMatchObject({ area: "ventas", motivo: "no_identificado" });
    expect(m.efectos.registro.pases[0].nota).toContain("«busco una pieza rara»");
    expect(textos(m)).toEqual([TEXTO_PASE.ventas]);
    expect(resumen.accion).toBe("escalated");
    expect(m.efectos.registro.estado?.etapa).toBe("con_asesor");
  });

  it("11b. sin texto y sin búsqueda: pase por código con «otro»", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "hmm", 1)],
      modelo: [{ texto: "   " }],
    });

    await m.correr();

    expect(m.efectos.registro.pases[0]).toMatchObject({ area: "ventas", motivo: "otro" });
    expect(m.efectos.registro.pases[0].nota).toContain("«hmm»");
  });
});

describe("El turno de Seba v2: cuando algo falla", () => {
  it("12a. si el modelo lanza sin haber enviado nada: cierra con «error» y RELANZA (quien llama reintenta)", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable", 1)],
      modelo: [{ lanza: new Error("proveedor caído") }],
    });

    await expect(m.correr()).rejects.toThrow("proveedor caído");

    expect(m.efectos.registro.cierre?.accion).toBe("error");
    expect(m.efectos.registro.mensajes).toEqual([]);
    expect(m.efectos.registro.vistos).toEqual([]);
    expect(m.efectos.registro.pases).toEqual([]);
  });

  it("12b. si lanza DESPUÉS de la bienvenida: no relanza, pasa el caso por código sin texto adicional", async () => {
    const m = montar({
      historial: [cliente("m1", "a qué hora cierran?", 1)],
      modelo: [{ lanza: new Error("proveedor caído") }],
    });

    const resumen = await m.correr();

    expect(textos(m)).toEqual([BIENVENIDA]);
    expect(m.efectos.registro.pases).toHaveLength(1);
    expect(m.efectos.registro.pases[0]).toMatchObject({ area: "ventas", motivo: "otro" });
    expect(m.efectos.registro.pases[0].nota).toContain("No se pudo redactar la respuesta (falló el proveedor)");
    expect(m.efectos.registro.pases[0].nota).toContain("«a qué hora cierran?»");
    expect(resumen.accion).toBe("escalated");
  });

  it("12c. si ese pase también lanza: cierra con «error» y relanza", async () => {
    const m = montar({
      historial: [cliente("m1", "a qué hora cierran?", 1)],
      efectos: { paseLanza: new Error("sin asesores") },
      modelo: [{ lanza: new Error("proveedor caído") }],
    });

    await expect(m.correr()).rejects.toThrow("sin asesores");

    expect(m.efectos.registro.cierre?.accion).toBe("error");
  });

  it("una excepción de las lecturas del turno (datos) cierra con «error» y relanza, sin enviar nada", async () => {
    const m = montar({ historial: [cliente("m1", "hola", 1)] });
    m.deps.cargarDatos = vi.fn(async () => {
      throw new Error("la conversación no existe");
    });

    await expect(m.correr()).rejects.toThrow("la conversación no existe");

    expect(m.efectos.registro.mensajes).toEqual([]);
    expect(m.efectos.registro.cierre?.accion).toBe("error");
  });

  it("si prepararPago envió el resumen pero el pase falló (el SDK no lanza), el turno pasa el caso por código", async () => {
    const estado: EstadoSeba = {
      etapa: "eligiendo_pago",
      lineas: [{ productId: ID_CASCO, cantidad: 1 }],
      forma: null,
      entrega: null,
      ciudad: null,
      totalUsd: null,
      totalBs: null,
      priceKind: null,
      complementoSugerido: false,
      ultimaFraseApertura: null,
      actualizadoEn: AHORA.toISOString(),
    };
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "con cashea, envío a Caracas", 1)],
      efectos: { estado, yaCotizados: [ID_CASCO] },
      modelo: [
        {
          herramientas: [
            {
              nombre: "prepararPago",
              entrada: { lineas: [{ productId: ID_CASCO, cantidad: 1 }], formaDePago: "cashea", entrega: "envio", ciudad: "Caracas" },
            },
          ],
          texto: "Un asesor te envía el enlace.",
          tragaErrores: true,
        },
      ],
    });
    // El primer pase falla (lo intenta `prepararPago`); el del respaldo del turno sale bien.
    const original = m.efectos.pasarAAsesor.bind(m.efectos);
    let intentos = 0;
    m.efectos.pasarAAsesor = async (i) => {
      intentos += 1;
      if (intentos === 1) throw new Error("falló una vez");
      return original(i);
    };

    const resumen = await m.correr();

    expect(textos(m)).toHaveLength(1);
    expect(textos(m)[0]).toContain("Cédula del titular");
    expect(m.efectos.registro.pases).toHaveLength(1);
    expect(m.efectos.registro.pases[0]).toMatchObject({ area: "ventas", motivo: "otro" });
    expect(resumen.accion).toBe("escalated");
    // Lo que dijo el modelo después no sale: la herramienta ya terminó el turno.
    expect(textos(m).join("\n")).not.toContain("Un asesor te envía el enlace");
  });
});

describe("El turno de Seba v2: lo que le pide a sus dependencias", () => {
  it("carga los datos con el cliente, la conversación, el reloj y lo precargado de la entrada", async () => {
    const m = montar({ historial: [...CONVERSACION_VIVA, cliente("m1", "hola?", 1)], modelo: [{ texto: "Dime." }] });
    const precargado = { lessons: { global: ["Guardafango es guardabarro."], chat: [] } };
    // Se vuelve a montar la entrada con lo precargado: `montar` no lo expone.
    const entrada: EntradaDeTurno = {
      supabase: {} as SupabaseClient<Database>,
      conversationId: "conv-7",
      ahora: AHORA,
      iaGlobal: false,
      visto: null,
      persistencia: "sombra",
      precargado,
      cargarHistorial: async () => historial([...CONVERSACION_VIVA, cliente("m1", "hola?", 1)]),
      deps: m.deps,
    };

    const resumen = await runSeba2Turn(entrada, m.efectos);

    expect(m.deps.cargarDatos).toHaveBeenCalledWith(entrada.supabase, "conv-7", AHORA, precargado);
    expect(m.deps.esperarLecturas).toHaveBeenCalledWith(entrada.supabase, "conv-7");
    expect(resumen.contexto.iaGlobal).toBe(false);
  });

  it("si esperar las lecturas de adjuntos falla, el turno sigue con lo que haya", async () => {
    const m = montar({ historial: [...CONVERSACION_VIVA, cliente("m1", "hola?", 1)], modelo: [{ texto: "Dime." }] });
    m.deps.esperarLecturas = vi.fn(async () => {
      throw new Error("base lenta");
    });

    await m.correr();

    expect(textos(m)).toEqual(["Dime."]);
    expect(logWarn).toHaveBeenCalledWith("seba2_espera_de_lecturas_fallida", expect.any(Object));
  });

  it("avisa que escribe («escribiendo…») una sola vez, justo antes de llamar al modelo", async () => {
    const m = montar({ historial: [...CONVERSACION_VIVA, cliente("m1", "hola?", 1)], modelo: [{ texto: "Dime." }] });
    await m.correr();
    expect(m.efectos.registro.escribiendo).toBe(1);
    expect(m.efectos.registro.secuencia.indexOf("escribiendo")).toBeLessThan(m.efectos.registro.secuencia.indexOf("enviarTexto"));
  });
});

describe("El turno de Seba v2: el resumen", () => {
  it("17. trae tokens sumados de todas las llamadas, modelo, herramientas, productos, consultas y el contexto", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable", 1)],
      datos: {
        asesorEscribioHaceMin: 5,
        conversacion: { ...datos().conversacion, assignedAgentId: "agente-1" },
      },
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [
        {
          herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }],
          texto: "Soy Seba, ¿lo quieres llevar?",
          uso: { input: 1000, output: 100, cache: 400, razonamiento: 30 },
        },
        { texto: "¿Lo quieres llevar?", uso: { input: 500, output: 50, cache: 100, razonamiento: 10 } },
      ],
    });

    const resumen = await m.correr();

    expect(resumen.tokens).toEqual({ input: 1500, output: 150, cachedInput: 500, reasoning: 40 });
    expect(resumen.modelo).toBe("openai/modelo-de-prueba");
    expect(resumen.herramientas).toEqual(["buscarRepuesto"]);
    expect(resumen.productos).toEqual([ID_CASCO]);
    expect(resumen.consultasCatalogo).toHaveLength(1);
    expect(resumen.rafaga).toEqual(["precio del impermeable"]);
    expect(resumen.triggerMessageId).toBe("m1");
    expect(resumen.contexto).toEqual({ iaGlobal: true, asesorAsignado: true, asesorEscribioHaceMin: 5 });
    expect(resumen.duracionMs).toBeGreaterThanOrEqual(0);
    expect(resumen.estadoAntes).toBeNull();
    expect(resumen.estadoDespues?.etapa).toBe("cotizado");
    expect(resumen.resumen.length).toBeGreaterThan(0);
    // El turno devuelve el MISMO resumen que entregó a `cerrar`.
    expect(m.efectos.registro.cierre).toBe(resumen);
  });

  it("guarda el estado con `actualizadoEn` = ahora y lo hace antes de marcar visto y de cerrar", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable", 1)],
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "" }],
    });

    await m.correr();

    expect(m.efectos.registro.estado?.actualizadoEn).toBe(AHORA.toISOString());
    const sec = m.efectos.registro.secuencia;
    expect(sec.indexOf("guardarEstado")).toBeLessThan(sec.indexOf("marcarVisto"));
    expect(sec.indexOf("marcarVisto")).toBeLessThan(sec.indexOf("cerrar"));
    expect(sec.at(-1)).toBe("cerrar");
  });

  it("la llamada al modelo lleva el techo de pasos, el de tokens y una parada por herramienta que cierra el turno", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "hola?", 1)],
      modelo: [{ texto: "Dime." }],
    });

    await m.correr();

    const llamada = m.llamadas[0];
    expect(SEBA2_MAX_PASOS).toBe(5);
    expect(SEBA2_MAX_OUTPUT_TOKENS).toBe(700);
    expect(llamada.maxOutputTokens).toBe(700);
    expect(llamada.messages).toHaveLength(3);
    expect(herramientasDe(llamada)).toEqual([
      "buscarRepuesto",
      "consultarBiblioteca",
      "pasarAAsesor",
      "prepararPago",
      "recibirComprobante",
    ]);
    expect(Array.isArray(llamada.stopWhen)).toBe(true);
    expect((llamada.stopWhen as unknown[]).length).toBe(2);
    expect(llamada.model).toBe("modelo-redactar");
    expect(m.modelo).toHaveBeenCalledWith("redactar");
  });
});

// =========================================================== las pautas P1-P11
// Un caso INVENTADO por pauta (el repositorio es público: ninguna conversación, nombre ni dato de pago reales).

describe("Las pautas del operador (P1-P11)", () => {
  it("P1: escalar termina el turno: tras el pase no corre ninguna otra herramienta ni se llama de nuevo al modelo, y todas las llamadas llevan techo de tokens", async () => {
    const pase = (motivo: string) => ({
      nombre: "pasarAAsesor",
      entrada: {
        motivo,
        nota: "El cliente pidió hablar con una persona.",
        mensajeAlCliente: "Claro, ya pasé tu caso a un asesor y te escribe por este chat.",
      },
    });
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "quiero hablar con alguien", 1)],
      modelo: [{ herramientas: [pase("pide_persona"), pase("pide_persona")], texto: "" }],
    });

    await m.correr();

    expect(m.efectos.registro.pases).toHaveLength(1);
    expect(m.generar).toHaveBeenCalledTimes(1);
    for (const llamada of m.llamadas) expect(typeof llamada.maxOutputTokens).toBe("number");
  });

  it("P2: con la escalada abierta Seba no le escribe al cliente: cortesía y pendientes quedan en silencio o en la nota", async () => {
    const espera = { escaladaAbierta: true, esperaDeAsesor: { area: "ventas" as const, minutos: 3 } };
    const cortesia = montar({ historial: [...CONVERSACION_VIVA, cliente("m1", "ok gracias", 1)], datos: espera });
    await cortesia.correr();
    expect(cortesia.efectos.registro.mensajes).toEqual([]);

    const pendiente = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "es para una SBR 2020", 1)],
      datos: espera,
      modelo: [{ texto: "" }],
    });
    await pendiente.correr();
    expect(pendiente.efectos.registro.mensajes).toEqual([]);
    expect(pendiente.efectos.registro.notas).toHaveLength(1);
  });

  it("P3: una respuesta por ráfaga: tres mensajes seguidos del cliente son UN turno, y repetir el turno con la marca no vuelve a responder", async () => {
    const lineas = [
      ...CONVERSACION_VIVA,
      cliente("m1", "precio del impermeable", 3),
      cliente("m2", "talla L", 2),
      cliente("m3", "y para la sbr", 1),
    ];
    const primero = montar({
      historial: lineas,
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable L" } }], texto: "" }],
    });
    const resumen = await primero.correr();

    expect(resumen.rafaga).toEqual(["precio del impermeable", "talla L", "y para la sbr"]);
    expect(primero.generar).toHaveBeenCalledTimes(1);
    expect(textos(primero).filter((t) => t.includes("IMPERMEABLE GIVI TALLA L"))).toHaveLength(1);

    // El mismo historial con la marca que dejó el primer turno: no queda nada pendiente.
    const marca = primero.efectos.registro.vistos[0];
    const segundo = montar({ historial: lineas, visto: marca, modelo: [{ texto: "no debe llamarse" }] });
    const resumen2 = await segundo.correr();
    expect(segundo.generar).not.toHaveBeenCalled();
    expect(segundo.efectos.registro.mensajes).toEqual([]);
    expect(resumen2.accion).toBe("skipped");
  });

  it("P4: no se promete un asesor sin pasar el caso: la frase que lo afirma no sale, y si no queda texto el caso se pasa", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "me dañaron el pedido", 1)],
      modelo: [{ texto: "Un asesor ya tiene tu caso." }, { texto: "Un asesor te escribe enseguida." }],
    });

    const resumen = await m.correr();

    expect(resumen.guardas.map((g) => g.guarda)).toEqual(["promesa_sin_pase", "promesa_sin_pase"]);
    // Lo que se le dijo al cliente es el texto fijo del área, con un pase real detrás.
    expect(m.efectos.registro.pases).toHaveLength(1);
    expect(textos(m)).toEqual([TEXTO_PASE.ventas]);
  });

  it("P5: con la escalada abierta el modelo no tiene la búsqueda: Seba no cotiza ni corrige al asesor", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "y cuánto cuesta el guante?", 1)],
      datos: { escaladaAbierta: true, esperaDeAsesor: { area: "ventas", minutos: 40 } },
      modelo: [{ texto: "" }],
    });

    await m.correr();

    expect(herramientasDe(m.llamadas[0])).not.toContain("buscarRepuesto");
    expect(herramientasDe(m.llamadas[0])).not.toContain("pasarAAsesor");
  });
  it.todo(
    "P5 (parte del asesor): si un asesor escribió hace poco o tiene el chat tomado, Seba no entra — es la puerta humanClaimsChat de la costura con v1 (agent.ts, S9), fuera de este turno; aquí solo se registra `asesorEscribioHaceMin` en el contexto (caso 17)"
  );

  it("P6: ninguna cifra de dinero sin fuente en el turno: el 108$ de una conversación vieja no sale, ni se calcula una cuota de Cashea", async () => {
    const historialViejo = [
      cliente("m0", "precio del intercomunicador", 600),
      bot("m0b", "El intercomunicador sale en 108$ BCV.", 599),
      cliente("m1", "y hoy cuánto es?", 1),
    ];
    const m = montar({
      historial: historialViejo,
      modelo: [{ texto: "El intercomunicador sale en 108$ BCV." }, { texto: "Sigue en 108$ BCV." }],
    });

    const resumen = await m.correr();

    expect(textos(m).join("\n")).not.toContain("108");
    expect(resumen.guardas.map((g) => g.guarda)).toEqual(["cifra_sin_fuente", "cifra_sin_fuente"]);

    const cuota = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "cuánto pago con cashea?", 1)],
      modelo: [{ texto: "Con Cashea son 6 cuotas de 14,23 $." }, { texto: "La inicial es de 36 $." }],
    });
    const r2 = await cuota.correr();
    expect(textos(cuota).join("\n")).not.toMatch(/cuotas de|inicial es/i);
    expect(r2.guardas.length).toBeGreaterThanOrEqual(1);
  });

  it("P7: la cotización la arma el código con el nombre EXACTO; lo que el modelo reescriba del producto se descarta, y no se avanza el estado si nada salió", async () => {
    const reescrito = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable givi", 1)],
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [
        {
          herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable givi" } }],
          texto: "El impermeable Givi talla L es una gran opción.",
        },
      ],
    });
    await reescrito.correr();
    expect(textos(reescrito)[0]).toContain("• IMPERMEABLE GIVI TALLA L: $30,00 BCV");
    expect(textos(reescrito)).not.toContain("El impermeable Givi talla L es una gran opción.");
    expect(reescrito.efectos.registro.mensajes[0].origen).toBe("herramienta");

    // Si el cliente escribió en medio y el turno cedió sin enviar nada, lo cotizado NO queda como pedido tentativo.
    const cedido = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable givi", 1)],
      efectos: { mensajeNuevoTrasEnvios: 0 },
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 5)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable givi" } }], texto: "" }],
    });
    const resumen = await cedido.correr();
    expect(resumen.estadoDespues?.lineas).toEqual([]);
  });

  it("P8: la pregunta de filtro sale una vez y la bienvenida no se repite en la misma ventana", async () => {
    const pregunta = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "tienen pastillas?", 1)],
      catalogo: (outcome) => {
        outcome.ran = true;
        outcome.generico = true;
        outcome.preguntaFiltro = "producto";
        outcome.consultas.push(consulta("generico"));
        return { results: [] };
      },
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "pastillas" } }], texto: "¿De qué marca las prefieres?\n\n¿Y para qué moto?" }],
    });
    await pregunta.correr();
    expect(pregunta.efectos.registro.mensajes).toHaveLength(1);

    const segundaVentana = montar({
      historial: [cliente("m1", "Buenas", 1)],
      efectos: { bienvenidaDisponible: false },
      modelo: [{ texto: "Dime." }],
    });
    await segundaVentana.correr();
    expect(textos(segundaVentana)).not.toContain(BIENVENIDA);
  });

  it("P9: no se afirma existencia sin stock: con todo agotado el cliente lee «Agotado» y nunca «¿Lo quieres llevar?»", async () => {
    const m = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "precio del impermeable", 1)],
      productos: [producto({ stockQuantity: 0 })],
      catalogo: cotiza([linea(ID_CASCO, "IMPERMEABLE GIVI TALLA L", 0)]),
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "impermeable" } }], texto: "" }],
    });

    await m.correr();

    expect(textos(m).join("\n")).toContain("Agotado");
    expect(textos(m).join("\n")).not.toContain("¿Lo quieres llevar?");
  });

  it("P10: «no se buscó» y «no existe» son motivos distintos: con búsqueda sin resultados, «no_identificado»; sin búsqueda, «otro»", async () => {
    const buscoYNoHay = montar({
      historial: [...CONVERSACION_VIVA, cliente("m1", "busco un repuesto raro", 1)],
      catalogo: sinResultados,
      modelo: [{ herramientas: [{ nombre: "buscarRepuesto", entrada: { query: "raro" } }], texto: "" }],
    });
    await buscoYNoHay.correr();
    expect(buscoYNoHay.efectos.registro.pases[0].motivo).toBe("no_identificado");

    const noBusco = montar({ historial: [...CONVERSACION_VIVA, cliente("m1", "algo raro", 1)], modelo: [{ texto: "" }] });
    await noBusco.correr();
    expect(noBusco.efectos.registro.pases[0].motivo).toBe("otro");
  });

  it.todo(
    "P11: un escenario no se repite en la conversación — Seba v2 no usa escenarios (fase 0 queda fuera: el guion es el prompt), así que la pauta se cumple por diseño; lo comprobable aquí es que la bienvenida no se repite (P8)"
  );
});
