import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";

const logWarn = vi.fn();
const logError = vi.fn();

vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: (...a: unknown[]) => logWarn(...a), error: (...a: unknown[]) => logError(...a) },
  errorText: (err: unknown) => (err instanceof Error ? err.message : JSON.stringify(err)),
}));

import { crearEffectsDeSombra, leerVistoDeSombra, type DepsDeEffectsDeSombra } from "./effects-sombra";
import { estadoInicial, type EstadoSeba, type ResumenDeTurno } from "./tipos";

// Martes 17/11/2026 11:00 en Caracas: la tienda está abierta.
const AHORA = new Date("2026-11-17T15:00:00.000Z");
// Sábado 21/11/2026 11:00 en Caracas: cerrada.
const AHORA_CERRADO = new Date("2026-11-21T15:00:00.000Z");

/**
 * Fake de Supabase que REGISTRA tabla, operación, payload y cada filtro con su
 * operador, columna y valor. Además FALLA el test (lanza) ante cualquier escritura
 * que no sea el `insert` de `agent_shadow_drafts`: es la regla dura de la sombra.
 */
interface Filtro {
  operador: string;
  columna: string;
  valor: unknown;
}
interface Operacion {
  tabla: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  columnas?: string;
  filtros: Filtro[];
  orden?: { columna: string; ascending: boolean };
  limite?: number;
  terminal: "lista" | "single" | "maybeSingle";
}
interface Respuesta {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

function crearFake(responder: (op: Operacion) => Respuesta = () => ({})) {
  const operaciones: Operacion[] = [];

  function constructor(tabla: string) {
    const op: Operacion = { tabla, op: "select", filtros: [], terminal: "lista" };
    const filtro = (operador: string) => (columna: string, valor: unknown) => {
      op.filtros.push({ operador, columna, valor });
      return q;
    };
    const q = {
      select(columnas?: string) {
        op.columnas = columnas;
        return q;
      },
      insert(payload: unknown) {
        op.op = "insert";
        op.payload = payload;
        return q;
      },
      update(payload: unknown) {
        op.op = "update";
        op.payload = payload;
        return q;
      },
      delete() {
        op.op = "delete";
        return q;
      },
      upsert(payload: unknown) {
        op.op = "insert";
        op.payload = payload;
        return q;
      },
      eq: filtro("eq"),
      gte: filtro("gte"),
      gt: filtro("gt"),
      in: filtro("in"),
      order(columna: string, opciones?: { ascending?: boolean }) {
        op.orden = { columna, ascending: opciones?.ascending ?? true };
        return q;
      },
      limit(n: number) {
        op.limite = n;
        return q;
      },
      single() {
        op.terminal = "single";
        return q;
      },
      maybeSingle() {
        op.terminal = "maybeSingle";
        return q;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        operaciones.push(op);
        if (op.op !== "select" && !(op.op === "insert" && tabla === "agent_shadow_drafts")) {
          return Promise.reject(new Error(`ESCRITURA PROHIBIDA en sombra: ${op.op} sobre ${tabla}`)).then(resolve, reject);
        }
        const r = responder(op);
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(resolve, reject);
      },
    };
    return q;
  }

  const client = { from: (tabla: string) => constructor(tabla) } as unknown as SupabaseClient<Database>;
  const escrituras = () => operaciones.filter((o) => o.op !== "select");
  return { client, operaciones, escrituras };
}

const CONV = "conv-1";

function resumen(extra: Partial<ResumenDeTurno> = {}): ResumenDeTurno {
  return {
    accion: "answered",
    resumen: "Cotizó un casco.",
    rafaga: ["precio del casco"],
    triggerMessageId: "msg-9",
    estadoAntes: null,
    estadoDespues: null,
    herramientas: ["buscar_repuesto"],
    productos: ["p1", "p2"],
    guardas: [{ guarda: "precio", fragmento: "$99" }],
    contexto: { iaGlobal: true, asesorAsignado: false, asesorEscribioHaceMin: null },
    tokens: { input: 1000, output: 200, cachedInput: 300, reasoning: 50 },
    modelo: "google/gemini-3.1-flash",
    duracionMs: 4321,
    ...extra,
  };
}

function crear(
  extra: Partial<DepsDeEffectsDeSombra> = {},
  responder?: (op: Operacion) => Respuesta
) {
  const fake = crearFake(responder);
  const deps: DepsDeEffectsDeSombra = {
    supabase: fake.client,
    conversationId: CONV,
    modo: "sombra",
    businessHours: DEFAULT_BUSINESS_HOURS,
    ahora: () => AHORA,
    asesorAsignado: false,
    llamadas: () => [{ phase: "redactar", inputTokens: 1000 }],
    ...extra,
  };
  return { efectos: crearEffectsDeSombra(deps), deps, ...fake };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("efectos de sombra: un turno entero", () => {
  it("produce EXACTAMENTE un insert en agent_shadow_drafts y CERO escrituras en cualquier otra tabla", async () => {
    const { efectos, escrituras, operaciones } = crear();
    const estado: EstadoSeba = { ...estadoInicial(AHORA), etapa: "cotizado" };
    const visto = { hasta: "2026-11-17T14:59:00.000Z", ids: ["m8", "m9"] };

    efectos.escribiendo();
    await efectos.enviarTexto("Hola, soy Seba", "fijo");
    await efectos.enviarTexto("El casco cuesta $50", "modelo");
    await efectos.enviarImagen("https://sbk.example/casco.jpg", "Casco LS2");
    await efectos.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: "quiere comprar el casco" });
    await efectos.guardarCarrito([{ productId: "p1", cantidad: 1, priceKind: "promocion" }]);
    await efectos.guardarEstado(estado);
    await efectos.marcarVisto(visto);
    await efectos.cerrar(resumen());

    expect(escrituras()).toHaveLength(1);
    expect(escrituras()[0].tabla).toBe("agent_shadow_drafts");
    expect(escrituras()[0].op).toBe("insert");
    // Ninguna otra tabla fue ni siquiera consultada con una escritura.
    expect(operaciones.filter((o) => o.tabla !== "agent_shadow_drafts" && o.op !== "select")).toHaveLength(0);
  });

  it("el payload trae mensajes en orden, escalaria, motivo/área/nota, estados, contexto y llamadas", async () => {
    const { efectos, escrituras } = crear();
    const estadoAntes: EstadoSeba = { ...estadoInicial(AHORA), etapa: "entender" };
    const estadoGuardado: EstadoSeba = { ...estadoInicial(AHORA), etapa: "cotizado" };
    const visto = { hasta: "2026-11-17T14:59:00.000Z", ids: ["m8", "m9"] };

    await efectos.enviarTexto("Hola, soy Seba", "fijo");
    await efectos.enviarTexto("El casco cuesta $50", "modelo");
    await efectos.enviarImagen("https://sbk.example/casco.jpg", "Casco LS2");
    await efectos.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: "quiere comprar el casco" });
    await efectos.guardarCarrito([{ productId: "p1", cantidad: 2, priceKind: "estandar" }]);
    await efectos.guardarEstado(estadoGuardado);
    await efectos.marcarVisto(visto);
    await efectos.cerrar(resumen({ estadoAntes, estadoDespues: null }));

    const fila = escrituras()[0].payload as Record<string, unknown>;
    expect(fila.conversation_id).toBe(CONV);
    expect(fila.modo).toBe("sombra");
    expect(fila.trigger_message_id).toBe("msg-9");
    expect(fila.rafaga).toEqual(["precio del casco"]);
    expect(fila.mensajes).toEqual([
      { orden: 1, tipo: "texto", texto: "Hola, soy Seba", origen: "fijo" },
      { orden: 2, tipo: "texto", texto: "El casco cuesta $50", origen: "modelo" },
      { orden: 3, tipo: "imagen", texto: "Casco LS2", origen: "herramienta", mediaUrl: "https://sbk.example/casco.jpg" },
    ]);
    expect(fila.herramientas).toEqual(["buscar_repuesto"]);
    expect(fila.productos).toEqual(["p1", "p2"]);
    expect(fila.escalaria).toBe(true);
    expect(fila.motivo).toBe("listo_para_comprar");
    expect(fila.area).toBe("ventas");
    expect(fila.nota).toBe("quiere comprar el casco");
    expect(fila.estado_antes).toEqual(estadoAntes);
    // El estado que el turno guardó gana sobre el del resumen.
    expect(fila.estado_despues).toEqual(estadoGuardado);
    expect(fila.guardas).toEqual([{ guarda: "precio", fragmento: "$99" }]);
    expect(fila.contexto).toEqual({
      ia_global: true,
      asesor_asignado: false,
      asesor_escribio_hace_min: null,
      visto,
      carrito: [{ productId: "p1", cantidad: 2, priceKind: "estandar" }],
      accion: "answered",
      resumen: "Cotizó un casco.",
    });
    expect(fila.model).toBe("google/gemini-3.1-flash");
    expect(fila.input_tokens).toBe(1000);
    expect(fila.output_tokens).toBe(200);
    expect(fila.cached_input_tokens).toBe(300);
    expect(fila.reasoning_tokens).toBe(50);
    expect(fila.llamadas).toEqual([{ phase: "redactar", inputTokens: 1000 }]);
    expect(fila.duration_ms).toBe(4321);
  });

  it("sin pase: escalaria false y motivo/área/nota null; sin estado guardado usa el del resumen", async () => {
    const { efectos, escrituras } = crear();
    const despues: EstadoSeba = { ...estadoInicial(AHORA), etapa: "cotizado" };

    await efectos.cerrar(resumen({ estadoDespues: despues, tokens: null, modelo: null }));

    const fila = escrituras()[0].payload as Record<string, unknown>;
    expect(fila.escalaria).toBe(false);
    expect(fila.motivo).toBeNull();
    expect(fila.area).toBeNull();
    expect(fila.nota).toBeNull();
    expect(fila.estado_despues).toEqual(despues);
    expect(fila.input_tokens).toBe(0);
    expect(fila.model).toBeNull();
    expect(fila.mensajes).toEqual([]);
    expect((fila.contexto as Record<string, unknown>).visto).toBeNull();
    expect((fila.contexto as Record<string, unknown>).carrito).toBeNull();
  });

  it("modo y sugerencia_estado: copiloto con mensajes → pendiente; copiloto sin mensajes y sombra → null", async () => {
    const copiloto = crear({ modo: "copiloto" });
    await copiloto.efectos.enviarTexto("hola", "modelo");
    await copiloto.efectos.cerrar(resumen());
    const fila = copiloto.escrituras()[0].payload as Record<string, unknown>;
    expect(fila.modo).toBe("copiloto");
    expect(fila.sugerencia_estado).toBe("pendiente");

    const vacio = crear({ modo: "copiloto" });
    await vacio.efectos.cerrar(resumen());
    expect((vacio.escrituras()[0].payload as Record<string, unknown>).sugerencia_estado).toBeNull();

    const sombra = crear({ modo: "sombra" });
    await sombra.efectos.enviarTexto("hola", "modelo");
    await sombra.efectos.cerrar(resumen());
    expect((sombra.escrituras()[0].payload as Record<string, unknown>).sugerencia_estado).toBeNull();
  });

  it("el modo es el que se pidió y los envíos siempre dicen ok", async () => {
    expect(crear({ modo: "sombra" }).efectos.modo).toBe("sombra");
    expect(crear({ modo: "copiloto" }).efectos.modo).toBe("copiloto");
    const { efectos } = crear();
    expect(await efectos.enviarTexto("x", "modelo")).toEqual({ ok: true });
    expect(await efectos.enviarImagen("https://x/y.jpg", null)).toEqual({ ok: true });
  });

  it("una imagen sin pie guarda texto vacío", async () => {
    const { efectos, escrituras } = crear();
    await efectos.enviarImagen("https://x/y.jpg", null);
    await efectos.cerrar(resumen());
    const mensajes = (escrituras()[0].payload as { mensajes: unknown[] }).mensajes;
    expect(mensajes).toEqual([{ orden: 1, tipo: "imagen", texto: "", origen: "herramienta", mediaUrl: "https://x/y.jpg" }]);
  });

  it("cerrar con error de base no lanza: deja el error en el log", async () => {
    const { efectos } = crear({}, () => ({ error: { message: "no escribe" } }));
    await expect(efectos.cerrar(resumen())).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("sombra_borrador_no_escrito", expect.objectContaining({ conversationId: CONV }));
  });

  it("cerrar tampoco lanza si el insert revienta con una excepción", async () => {
    const fake = crearFake();
    const roto = {
      from: () => {
        throw new Error("cliente roto");
      },
    } as unknown as SupabaseClient<Database>;
    const efectos = crearEffectsDeSombra({
      supabase: roto,
      conversationId: CONV,
      modo: "sombra",
      businessHours: DEFAULT_BUSINESS_HOURS,
      ahora: () => AHORA,
      asesorAsignado: false,
    });
    void fake;
    await expect(efectos.cerrar(resumen())).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("sombra_borrador_no_escrito", expect.any(Object));
  });
});

describe("efectos de sombra: el pase", () => {
  it("devuelve asignado true con el horario calculado, sin escribir nada", async () => {
    const { efectos, operaciones } = crear();
    const r = await efectos.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" });
    expect(r).toEqual({ asignado: true, abierta: true, cuandoAbre: null, yaTeniaAsesor: false });
    expect(operaciones).toHaveLength(0);
  });

  it("con asesor ya asignado: yaTeniaAsesor true", async () => {
    const { efectos } = crear({ asesorAsignado: true });
    expect((await efectos.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" })).yaTeniaAsesor).toBe(true);
  });

  it("con la tienda cerrada dice cuándo abre", async () => {
    const { efectos } = crear({ ahora: () => AHORA_CERRADO });
    const r = await efectos.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" });
    expect(r.abierta).toBe(false);
    expect(r.cuandoAbre).toMatch(/^el lunes a partir de las /);
  });

  it("si hay dos pases, el borrador guarda el último", async () => {
    const { efectos, escrituras } = crear();
    await efectos.pasarAAsesor({ area: "pagos", motivo: "comprobante_pago", nota: "a" });
    await efectos.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: "b" });
    await efectos.cerrar(resumen());
    const fila = escrituras()[0].payload as Record<string, unknown>;
    expect(fila).toMatchObject({ motivo: "listo_para_comprar", area: "ventas", nota: "b" });
  });
});

describe("efectos de sombra: lecturas", () => {
  const HACE_24H = new Date(AHORA.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const HACE_72H = new Date(AHORA.getTime() - 72 * 60 * 60 * 1000).toISOString();

  it("leerEstado devuelve el estado_despues del último borrador de ESTA conversación y ESTE modo, si es vigente", async () => {
    const estado: EstadoSeba = { ...estadoInicial(AHORA), etapa: "eligiendo_pago" };
    const { efectos, operaciones } = crear({ modo: "copiloto" }, () => ({ data: { estado_despues: estado } }));

    expect(await efectos.leerEstado()).toEqual(estado);

    const lectura = operaciones[0];
    expect(lectura.tabla).toBe("agent_shadow_drafts");
    expect(lectura.columnas).toBe("estado_despues");
    expect(lectura.filtros).toEqual([
      { operador: "eq", columna: "conversation_id", valor: CONV },
      { operador: "eq", columna: "modo", valor: "copiloto" },
    ]);
    expect(lectura.orden).toEqual({ columna: "created_at", ascending: false });
    expect(lectura.limite).toBe(1);
  });

  it("leerEstado: null si venció (más de 7 días), si no hay borrador, si es basura o si la base falla", async () => {
    const viejo: EstadoSeba = { ...estadoInicial(new Date("2026-11-09T14:59:00.000Z")), etapa: "cotizado" };
    expect(await crear({}, () => ({ data: { estado_despues: viejo } })).efectos.leerEstado()).toBeNull();
    expect(await crear({}, () => ({ data: null })).efectos.leerEstado()).toBeNull();
    expect(await crear({}, () => ({ data: { estado_despues: { etapa: "inventada" } } })).efectos.leerEstado()).toBeNull();
    expect(await crear({}, () => ({ error: { message: "x" } })).efectos.leerEstado()).toBeNull();
    expect(logWarn).toHaveBeenCalledWith("sombra_estado_no_legible", expect.any(Object));
  });

  it("reclamarBienvenida: true solo si no hay borrador de las últimas 24 h y el sello de la conversación no es reciente", async () => {
    const { efectos, operaciones, escrituras } = crear({}, (op) =>
      op.tabla === "agent_shadow_drafts" ? { data: [] } : { data: { welcome_sent_at: null } }
    );

    expect(await efectos.reclamarBienvenida()).toBe(true);

    const borradores = operaciones.find((o) => o.tabla === "agent_shadow_drafts")!;
    // Cualquier modo: no filtra por `modo`.
    expect(borradores.filtros).toEqual([
      { operador: "eq", columna: "conversation_id", valor: CONV },
      { operador: "gte", columna: "created_at", valor: HACE_24H },
    ]);
    expect(borradores.limite).toBe(1);
    expect(escrituras()).toHaveLength(0);
  });

  it("reclamarBienvenida: false si hay un borrador de hace 2 h", async () => {
    const { efectos } = crear({}, (op) =>
      op.tabla === "agent_shadow_drafts" ? { data: [{ id: "d1" }] } : { data: { welcome_sent_at: null } }
    );
    expect(await efectos.reclamarBienvenida()).toBe(false);
  });

  it("reclamarBienvenida: false si la conversación ya tiene un sello de menos de 24 h; true si es más viejo", async () => {
    const reciente = new Date(AHORA.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const viejo = new Date(AHORA.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const r = (sello: string) => (op: Operacion) =>
      op.tabla === "agent_shadow_drafts" ? { data: [] } : { data: { welcome_sent_at: sello } };

    expect(await crear({}, r(reciente)).efectos.reclamarBienvenida()).toBe(false);
    expect(await crear({}, r(viejo)).efectos.reclamarBienvenida()).toBe(true);
  });

  it("reclamarBienvenida: false si la base falla (valor neutro, sin lanzar)", async () => {
    const { efectos } = crear({}, () => ({ error: { message: "x" } }));
    expect(await efectos.reclamarBienvenida()).toBe(false);
  });

  it("productosYaCotizados une las cotizaciones (72 h) y los productos de los borradores (72 h)", async () => {
    const { efectos, operaciones } = crear({}, (op) =>
      op.tabla === "conversation_quotes"
        ? { data: [{ product_id: "p1" }, { product_id: null }] }
        : { data: [{ productos: ["p2", "p3"] }, { productos: ["p1"] }, { productos: null }] }
    );

    const ids = await efectos.productosYaCotizados();

    expect([...ids].sort()).toEqual(["p1", "p2", "p3"]);
    const cotizaciones = operaciones.find((o) => o.tabla === "conversation_quotes")!;
    expect(cotizaciones.filtros).toEqual([
      { operador: "eq", columna: "conversation_id", valor: CONV },
      { operador: "gte", columna: "quoted_at", valor: HACE_72H },
    ]);
    const borradores = operaciones.find((o) => o.tabla === "agent_shadow_drafts")!;
    expect(borradores.columnas).toBe("productos");
    expect(borradores.filtros).toEqual([
      { operador: "eq", columna: "conversation_id", valor: CONV },
      { operador: "gte", columna: "created_at", valor: HACE_72H },
    ]);
  });

  it("productosYaCotizados: si una de las dos fuentes falla, usa la otra y avisa", async () => {
    const { efectos } = crear({}, (op) =>
      op.tabla === "conversation_quotes" ? { error: { message: "x" } } : { data: [{ productos: ["p2"] }] }
    );
    expect([...(await efectos.productosYaCotizados())]).toEqual(["p2"]);
    expect(logWarn).toHaveBeenCalledWith("sombra_cotizados_no_legibles", expect.any(Object));
  });

  it("hayMensajeNuevoDelCliente: siempre false, sin consultar nada (la sombra no cede)", async () => {
    const { efectos, operaciones } = crear();
    expect(await efectos.hayMensajeNuevoDelCliente()).toBe(false);
    expect(operaciones).toHaveLength(0);
  });
});

describe("leerVistoDeSombra", () => {
  it("lee contexto.visto del último borrador de la conversación y el modo", async () => {
    const visto = { hasta: "2026-11-17T14:59:00.000Z", ids: ["m1"] };
    const fake = crearFake(() => ({ data: { contexto: { visto, accion: "answered" } } }));

    expect(await leerVistoDeSombra(fake.client, CONV, "copiloto")).toEqual(visto);

    const lectura = fake.operaciones[0];
    expect(lectura.tabla).toBe("agent_shadow_drafts");
    expect(lectura.columnas).toBe("contexto");
    expect(lectura.filtros).toEqual([
      { operador: "eq", columna: "conversation_id", valor: CONV },
      { operador: "eq", columna: "modo", valor: "copiloto" },
    ]);
    expect(lectura.orden).toEqual({ columna: "created_at", ascending: false });
    expect(lectura.limite).toBe(1);
  });

  it("devuelve null sin borrador, sin visto, con un visto mal formado o con error de base", async () => {
    expect(await leerVistoDeSombra(crearFake(() => ({ data: null })).client, CONV, "sombra")).toBeNull();
    expect(await leerVistoDeSombra(crearFake(() => ({ data: { contexto: { visto: null } } })).client, CONV, "sombra")).toBeNull();
    expect(
      await leerVistoDeSombra(crearFake(() => ({ data: { contexto: { visto: { hasta: 5, ids: "x" } } } })).client, CONV, "sombra")
    ).toBeNull();
    expect(await leerVistoDeSombra(crearFake(() => ({ error: { message: "x" } })).client, CONV, "sombra")).toBeNull();
    expect(logWarn).toHaveBeenCalledWith("sombra_visto_no_legible", expect.any(Object));
  });
});

describe("efectos de sombra: silencios y notas para el asesor", () => {
  it("guardan silencio y notas dentro de contexto del borrador, sin escribir nada más", async () => {
    const { efectos, escrituras } = crear();

    await efectos.registrarSilencio("cortesia_tras_escalada");
    await efectos.anotarParaAsesor("Mientras espera al asesor, el cliente agregó: «es para una SBR 2020»");
    await efectos.anotarParaAsesor("Mientras espera al asesor, el cliente agregó: «gracias»");
    await efectos.marcarVisto({ hasta: "2026-11-17T14:59:00.000Z", ids: ["m9"] });
    await efectos.cerrar(resumen({ accion: "skipped", resumen: "Cortesía con la escalada abierta." }));

    expect(escrituras()).toHaveLength(1);
    const fila = escrituras()[0].payload as Record<string, unknown>;
    const contexto = fila.contexto as Record<string, unknown>;
    expect(contexto.silencio).toBe("cortesia_tras_escalada");
    expect(contexto.notas).toEqual([
      "Mientras espera al asesor, el cliente agregó: «es para una SBR 2020»",
      "Mientras espera al asesor, el cliente agregó: «gracias»",
    ]);
    // La marca «visto» sigue viajando: es de donde la sombra la lee en el turno siguiente.
    expect(contexto.visto).toEqual({ hasta: "2026-11-17T14:59:00.000Z", ids: ["m9"] });
  });

  it("sin silencio ni notas, `contexto` no trae esas claves", async () => {
    const { efectos, escrituras } = crear();
    await efectos.enviarTexto("Hola", "fijo");
    await efectos.cerrar(resumen());
    const contexto = (escrituras()[0].payload as Record<string, unknown>).contexto as Record<string, unknown>;
    expect(contexto).not.toHaveProperty("silencio");
    expect(contexto).not.toHaveProperty("notas");
  });

  it("cortesia_tras_escalada sin mensajes SÍ inserta borrador (lleva la marca «visto» del turno siguiente)", async () => {
    const { efectos, escrituras } = crear();
    await efectos.registrarSilencio("cortesia_tras_escalada");
    await efectos.cerrar(resumen({ accion: "skipped" }));
    expect(escrituras()).toHaveLength(1);
  });

  it("sin_mensaje_nuevo y ningún mensaje: NO inserta borrador (nada que comparar, solo ruido en el panel)", async () => {
    const { efectos, escrituras, operaciones } = crear();
    await efectos.registrarSilencio("sin_mensaje_nuevo");
    await efectos.cerrar(resumen({ accion: "skipped" }));
    expect(escrituras()).toHaveLength(0);
    expect(operaciones.filter((o) => o.op === "insert")).toHaveLength(0);
  });

  it("sin_mensaje_nuevo pero CON un mensaje enviado: sí inserta (el silencio no manda si el turno habló)", async () => {
    const { efectos, escrituras } = crear();
    await efectos.registrarSilencio("sin_mensaje_nuevo");
    await efectos.enviarTexto("Hola", "fijo");
    await efectos.cerrar(resumen());
    expect(escrituras()).toHaveLength(1);
  });

  it("anotarParaAsesor no lanza ni escribe en la base: la sombra solo lo guarda en memoria", async () => {
    const { efectos, operaciones } = crear();
    await expect(efectos.anotarParaAsesor("nota")).resolves.toBeUndefined();
    expect(operaciones).toHaveLength(0);
  });
});
