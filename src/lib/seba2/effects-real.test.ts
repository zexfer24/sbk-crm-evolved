import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { DeliveryOutcome } from "@/lib/ai/send";
import type { TurnTarget } from "@/lib/ai/turn-target";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";

const escalateMock = vi.fn();
const recordHandoffMock = vi.fn();
const writeSeenMock = vi.fn();
const sendTextMock = vi.fn();
const sendImageMock = vi.fn();
const escribirCarritoMock = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();

vi.mock("@/lib/ai/escalate", () => ({ escalateConversation: (...a: unknown[]) => escalateMock(...a) }));
vi.mock("@/lib/ai/handoffs", () => ({ recordHandoff: (...a: unknown[]) => recordHandoffMock(...a) }));
vi.mock("@/lib/ai/turn-seen", () => ({ writeSeen: (...a: unknown[]) => writeSeenMock(...a) }));
vi.mock("@/lib/ai/send", () => ({
  sendAgentText: (...a: unknown[]) => sendTextMock(...a),
  sendAgentImage: (...a: unknown[]) => sendImageMock(...a),
}));
vi.mock("./carrito-servidor", () => ({ escribirCarritoDeSeba: (...a: unknown[]) => escribirCarritoMock(...a) }));
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: (...a: unknown[]) => logWarn(...a), error: (...a: unknown[]) => logError(...a) },
  errorText: (err: unknown) => (err instanceof Error ? err.message : JSON.stringify(err)),
}));

import { crearEffectsReales, type DepsDeEffectsReales } from "./effects-real";
import { estadoInicial, type EstadoSeba, type ResumenDeTurno } from "./tipos";

// Martes 17/11/2026 11:00 en Caracas (UTC-4): la tienda está abierta.
const AHORA = new Date("2026-11-17T15:00:00.000Z");
// Sábado 21/11/2026 11:00 en Caracas: cerrada, abre el lunes.
const AHORA_CERRADO = new Date("2026-11-21T15:00:00.000Z");

/**
 * Fake de Supabase que REGISTRA tabla, operación, payload y cada filtro con su
 * operador, columna y valor (un fake que ignora el operador o el valor no detecta
 * un `.gte` cambiado por un `.gt`, ni un id equivocado).
 */
interface Filtro {
  operador: string;
  columna?: string;
  valor?: unknown;
}
interface Operacion {
  tabla: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  columnas?: string;
  filtros: Filtro[];
  terminal: "lista" | "single" | "maybeSingle";
  limite?: number;
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
        // También tras un update/insert: `.update(...).select("id")` pide las filas afectadas.
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
      eq: filtro("eq"),
      neq: filtro("neq"),
      gt: filtro("gt"),
      gte: filtro("gte"),
      lt: filtro("lt"),
      in: filtro("in"),
      is: filtro("is"),
      not(columna: string, operador: string, valor: unknown) {
        op.filtros.push({ operador: "not", columna, valor: [operador, valor] });
        return q;
      },
      or(expresion: string) {
        op.filtros.push({ operador: "or", valor: expresion });
        return q;
      },
      limit(n: number) {
        op.limite = n;
        return q;
      },
      order() {
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
        const r = responder(op);
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(resolve, reject);
      },
    };
    return q;
  }

  const client = { from: (tabla: string) => constructor(tabla) } as unknown as SupabaseClient<Database>;
  return { client, operaciones };
}

const CONV = "conv-1";
const CONTACTO = "contact-1";

const TARGET: TurnTarget = {
  conversationId: CONV,
  contactId: CONTACTO,
  phoneNumber: "+584121112233",
  phoneNumberId: "pnid-1",
  channelStatus: "connected",
};

function salida(extra: Partial<DeliveryOutcome> = {}): DeliveryOutcome {
  return {
    whatsapp_message_id: "wamid.1",
    whatsapp_status: "sent",
    whatsapp_error_code: null,
    whatsapp_error_detail: null,
    origenDelFallo: null,
    ...extra,
  };
}

function resumen(extra: Partial<ResumenDeTurno> = {}): ResumenDeTurno {
  return {
    accion: "answered",
    resumen: "Cotizó un casco.",
    rafaga: ["precio del casco"],
    triggerMessageId: "m1",
    estadoAntes: null,
    estadoDespues: null,
    herramientas: [],
    productos: [],
    guardas: [],
    contexto: { iaGlobal: true, asesorAsignado: false, asesorEscribioHaceMin: null },
    tokens: null,
    modelo: null,
    duracionMs: 10,
    ...extra,
  };
}

let contadorDeFilas = 0;

/** `sendAgentText`/`sendAgentImage` simulados: entregan un id de fila por `alGuardar` y devuelven `salida()`. */
function simularEnvios(resultado: () => DeliveryOutcome = () => salida()) {
  const impl = async (...args: unknown[]) => {
    const opciones = args[args.length - 1] as { alGuardar?: (id: string | null) => void } | undefined;
    contadorDeFilas += 1;
    opciones?.alGuardar?.(`fila-${contadorDeFilas}`);
    return resultado();
  };
  sendTextMock.mockImplementation(impl);
  sendImageMock.mockImplementation(impl);
}

function crear(extra: Partial<DepsDeEffectsReales> = {}, responder?: (op: Operacion) => Respuesta) {
  const fake = crearFake(responder);
  const deps: DepsDeEffectsReales = {
    supabase: fake.client,
    conversationId: CONV,
    contactId: CONTACTO,
    target: TARGET,
    businessHours: DEFAULT_BUSINESS_HOURS,
    ahora: () => AHORA,
    assignedAgentId: null,
    entregar: vi.fn(async (enviar: () => Promise<DeliveryOutcome>) => enviar()),
    alFallarEnvio: vi.fn(async () => undefined),
    escribiendo: vi.fn(),
    registrarTurno: vi.fn(async () => undefined),
    visto: null,
    redisDisponible: true,
    ...extra,
  };
  return { efectos: crearEffectsReales(deps), deps, ...fake };
}

beforeEach(() => {
  vi.clearAllMocks();
  recordHandoffMock.mockResolvedValue(true);
  writeSeenMock.mockResolvedValue(undefined);
  escribirCarritoMock.mockResolvedValue(undefined);
  contadorDeFilas = 0;
  simularEnvios();
  escalateMock.mockResolvedValue({
    escalated: true,
    assignedAgentName: "Ana",
    businessStatus: { open: true, closesAt: "6:00 pm", nextOpening: null },
  });
});

describe("efectos reales: envíos", () => {
  it("el modo es «real» y escribiendo() delega sin esperar ni lanzar", () => {
    const { efectos, deps } = crear();
    expect(efectos.modo).toBe("real");
    efectos.escribiendo();
    expect(deps.escribiendo).toHaveBeenCalledTimes(1);

    const { efectos: otro } = crear({
      escribiendo: () => {
        throw new Error("falló el indicador");
      },
    });
    expect(() => otro.escribiendo()).not.toThrow();
  });

  it("un envío ok pasa por la puerta de entrega y manda el texto al destinatario congelado", async () => {
    const { efectos, deps } = crear();

    const r = await efectos.enviarTexto("Hola, te cotizo el casco", "modelo");

    expect(r).toEqual({ ok: true });
    expect(deps.entregar).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenCalledTimes(1);
    const args = sendTextMock.mock.calls[0];
    expect(args[1]).toBe(TARGET);
    expect(args[2]).toBe("Hola, te cotizo el casco");
  });

  it("enviarImagen manda la foto con su pie por sendAgentImage", async () => {
    const { efectos } = crear();

    const r = await efectos.enviarImagen("https://sbk.example/casco.jpg", "Casco LS2");

    expect(r).toEqual({ ok: true });
    const args = sendImageMock.mock.calls[0];
    expect(args[1]).toBe(TARGET);
    expect(args[2]).toBe("https://sbk.example/casco.jpg");
    expect(args[3]).toBe("Casco LS2");
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it("si una guarda frena el envío (entregar devuelve null) → { ok: false } y el turno deja de hablar", async () => {
    const entregar = vi.fn(async () => null);
    const { efectos } = crear({ entregar });

    expect(await efectos.enviarTexto("uno", "modelo")).toEqual({ ok: false });
    expect(await efectos.enviarTexto("dos", "modelo")).toEqual({ ok: false });
    expect(await efectos.enviarImagen("https://x/y.jpg", null)).toEqual({ ok: false });

    // El segundo y el tercero NI siquiera preguntan a la puerta.
    expect(entregar).toHaveBeenCalledTimes(1);
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it("un envío failed llama a alFallarEnvio con el resultado y yaEscalada=false, y corta el turno", async () => {
    const fallido = salida({ whatsapp_status: "failed", whatsapp_error_code: 131047, origenDelFallo: "meta" });
    simularEnvios(() => fallido);
    const { efectos, deps } = crear();

    expect(await efectos.enviarTexto("uno", "modelo")).toEqual({ ok: false });
    expect(deps.alFallarEnvio).toHaveBeenCalledTimes(1);
    expect(deps.alFallarEnvio).toHaveBeenCalledWith(fallido, false);

    expect(await efectos.enviarTexto("dos", "modelo")).toEqual({ ok: false });
    expect(deps.entregar).toHaveBeenCalledTimes(1);
  });

  it("un envío failed DESPUÉS de un pase llama a alFallarEnvio con yaEscalada=true", async () => {
    const { efectos, deps } = crear();
    await efectos.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: "quiere el casco" });
    simularEnvios(() => salida({ whatsapp_status: "failed", origenDelFallo: "red" }));

    await efectos.enviarTexto("te paso con un asesor", "fijo");

    expect(deps.alFallarEnvio).toHaveBeenCalledWith(expect.objectContaining({ whatsapp_status: "failed" }), true);
  });

  it("un canal simulado (whatsapp_status null) cuenta como entregado", async () => {
    simularEnvios(() => salida({ whatsapp_status: null, whatsapp_message_id: null }));
    const { efectos, deps } = crear();

    expect(await efectos.enviarTexto("hola", "modelo")).toEqual({ ok: true });
    expect(deps.alFallarEnvio).not.toHaveBeenCalled();
  });
});

describe("efectos reales: is_auto_reply", () => {
  it("sin asesor ni pase, el envío NO es respuesta automática", async () => {
    const { efectos } = crear();
    await efectos.enviarTexto("hola", "modelo");
    expect(sendTextMock.mock.calls[0][3]).toMatchObject({ isAutoReply: false });
  });

  it("con asesor asignado al abrir el turno, todo envío es automático (texto e imagen)", async () => {
    const { efectos } = crear({ assignedAgentId: "agente-1" });
    await efectos.enviarTexto("hola", "modelo");
    await efectos.enviarImagen("https://x/y.jpg", null);
    expect(sendTextMock.mock.calls[0][3]).toMatchObject({ isAutoReply: true });
    expect(sendImageMock.mock.calls[0][4]).toMatchObject({ isAutoReply: true });
  });

  it("después de un pase, los envíos siguientes son automáticos", async () => {
    const { efectos } = crear();
    await efectos.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: "n" });
    await efectos.enviarTexto("ya te paso", "fijo");
    expect(sendTextMock.mock.calls[0][3]).toMatchObject({ isAutoReply: true });
  });

  it("el pase marca is_auto_reply en los mensajes ya enviados (UPDATE por sus ids)", async () => {
    const { efectos, operaciones } = crear();
    await efectos.enviarTexto("uno", "modelo");
    await efectos.enviarImagen("https://x/y.jpg", "pie");

    await efectos.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: "n" });

    const marcado = operaciones.find((o) => o.tabla === "messages" && o.op === "update")!;
    expect(marcado.payload).toEqual({ is_auto_reply: true });
    expect(marcado.filtros).toEqual([
      { operador: "eq", columna: "conversation_id", valor: CONV },
      { operador: "in", columna: "id", valor: ["fila-1", "fila-2"] },
    ]);
  });

  it("no vuelve a marcar lo ya marcado en un segundo pase, ni marca nada si no se envió nada", async () => {
    const { efectos, operaciones } = crear();
    await efectos.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: "n" });
    expect(operaciones.filter((o) => o.tabla === "messages")).toHaveLength(0);

    const { efectos: otro, operaciones: ops2 } = crear();
    await otro.enviarTexto("uno", "modelo");
    await otro.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: "n" });
    await otro.pasarAAsesor({ area: "pagos", motivo: "comprobante_pago", nota: "n" });
    expect(ops2.filter((o) => o.tabla === "messages" && o.op === "update")).toHaveLength(1);
  });

  it("con asesor asignado al abrir no hay nada que marcar después del pase", async () => {
    const { efectos, operaciones } = crear({ assignedAgentId: "agente-1" });
    await efectos.enviarTexto("uno", "modelo");
    await efectos.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: "n" });
    expect(operaciones.filter((o) => o.tabla === "messages")).toHaveLength(0);
  });

  it("un fallo al marcar no tumba el turno: queda en el log", async () => {
    const { efectos } = crear({}, (op) => (op.tabla === "messages" ? { error: { message: "no se pudo" } } : {}));
    await efectos.enviarTexto("uno", "modelo");

    await expect(
      efectos.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: "n" })
    ).resolves.toBeDefined();
    expect(logError).toHaveBeenCalledWith("seba2_pase_no_marco_auto_reply", expect.any(Object));
  });
});

describe("efectos reales: pasarAAsesor", () => {
  it("llama a escalateConversation con área, motivo, nota como resumen, horario y reloj", async () => {
    const { efectos } = crear();

    await efectos.pasarAAsesor({ area: "pagos", motivo: "comprobante_pago", nota: "mandó el comprobante" });

    expect(escalateMock).toHaveBeenCalledTimes(1);
    const [, params] = escalateMock.mock.calls[0];
    expect(params).toEqual({
      conversationId: CONV,
      contactId: CONTACTO,
      motivo: "comprobante_pago",
      resumen: "mandó el comprobante",
      area: "pagos",
      businessHours: DEFAULT_BUSINESS_HOURS,
      now: AHORA,
    });
  });

  it("traduce el resultado: asignado, abierta y yaTeniaAsesor", async () => {
    const { efectos } = crear();
    expect(await efectos.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" })).toEqual({
      asignado: true,
      abierta: true,
      cuandoAbre: null,
      yaTeniaAsesor: false,
    });
  });

  it("sin asesores (unassigned) → asignado false", async () => {
    escalateMock.mockResolvedValue({
      escalated: true,
      assignedAgentName: null,
      unassigned: true,
      businessStatus: { open: true, closesAt: "6:00 pm", nextOpening: null },
    });
    const { efectos } = crear();
    const r = await efectos.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" });
    expect(r.asignado).toBe(false);
  });

  it("un chat que ya tenía asesor → yaTeniaAsesor true y los envíos siguientes son automáticos", async () => {
    escalateMock.mockResolvedValue({
      escalated: true,
      assignedAgentName: "Ana",
      alreadyAssigned: true,
      businessStatus: { open: true, closesAt: "6:00 pm", nextOpening: null },
    });
    const { efectos } = crear();
    const r = await efectos.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" });
    expect(r).toMatchObject({ asignado: true, yaTeniaAsesor: true });
  });

  it("tienda cerrada: abierta false y cuándo abre, redactado como en v1", async () => {
    escalateMock.mockResolvedValue({
      escalated: true,
      assignedAgentName: "Ana",
      businessStatus: { open: false, closesAt: null, nextOpening: { dayLabel: "el lunes", time: "8:00 am" } },
    });
    const { efectos } = crear();
    const r = await efectos.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" });
    expect(r).toMatchObject({ abierta: false, cuandoAbre: "el lunes a partir de las 8:00 am" });
  });

  it("si escalateConversation no trae businessStatus, lo calcula con el reloj y el horario del turno", async () => {
    escalateMock.mockResolvedValue({ escalated: true, assignedAgentName: "Ana" });
    const { efectos } = crear({ ahora: () => AHORA_CERRADO });
    const r = await efectos.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" });
    expect(r.abierta).toBe(false);
    expect(r.cuandoAbre).toMatch(/^el lunes a partir de las /);
  });

  it("si escalateConversation LANZA: deja el traspaso a «unassigned», registra el error y RELANZA", async () => {
    const falla = new Error("la base se cayó");
    escalateMock.mockRejectedValue(falla);
    const { efectos } = crear();

    await expect(efectos.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" })).rejects.toBe(falla);

    expect(recordHandoffMock).toHaveBeenCalledTimes(1);
    expect(recordHandoffMock.mock.calls[0][1]).toEqual({
      conversationId: CONV,
      toKind: "unassigned",
      reason: "escalada_sin_asesor",
    });
    expect(logError).toHaveBeenCalledWith("seba2_pase_fallo", expect.objectContaining({ conversationId: CONV }));
  });

  it("si escalateConversation devuelve escalated:false se trata como fallo (traspaso + error)", async () => {
    escalateMock.mockResolvedValue({ escalated: false });
    const { efectos } = crear();

    await expect(efectos.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" })).rejects.toThrow(/no escaló/);
    expect(recordHandoffMock).toHaveBeenCalledTimes(1);
  });

  it("un pase fallido NO cuenta como pase: los envíos siguientes siguen sin ser automáticos", async () => {
    escalateMock.mockRejectedValue(new Error("x"));
    const { efectos } = crear();
    await expect(efectos.pasarAAsesor({ area: "ventas", motivo: "otro", nota: "n" })).rejects.toThrow();

    await efectos.enviarTexto("hola", "modelo");
    expect(sendTextMock.mock.calls[0][3]).toMatchObject({ isAutoReply: false });
  });
});

describe("efectos reales: carrito y estado", () => {
  it("guardarCarrito escribe con el cliente admin y la conversación", async () => {
    const { efectos, client } = crear();
    const lineas = [{ productId: "p1", cantidad: 2, priceKind: "promocion" as const }];

    await efectos.guardarCarrito(lineas);

    expect(escribirCarritoMock).toHaveBeenCalledWith(client, CONV, lineas);
  });

  it("guardarCarrito deja subir el error (el turno decide)", async () => {
    escribirCarritoMock.mockRejectedValueOnce(new Error("carrito roto"));
    const { efectos } = crear();
    await expect(efectos.guardarCarrito([])).rejects.toThrow("carrito roto");
  });

  it("leerEstado devuelve el estado vigente guardado en seba_pedido", async () => {
    const estado: EstadoSeba = { ...estadoInicial(AHORA), etapa: "cotizado" };
    const { efectos, operaciones } = crear({}, () => ({ data: { seba_pedido: estado } }));

    expect(await efectos.leerEstado()).toEqual(estado);

    const lectura = operaciones[0];
    expect(lectura.tabla).toBe("conversations");
    expect(lectura.columnas).toBe("seba_pedido");
    expect(lectura.filtros).toEqual([{ operador: "eq", columna: "id", valor: CONV }]);
    expect(lectura.terminal).toBe("maybeSingle");
  });

  it("leerEstado devuelve null con un estado de hace más de 7 días", async () => {
    const viejo: EstadoSeba = { ...estadoInicial(new Date("2026-11-09T14:59:00.000Z")), etapa: "cotizado" };
    const { efectos } = crear({}, () => ({ data: { seba_pedido: viejo } }));
    expect(await efectos.leerEstado()).toBeNull();
  });

  it("leerEstado devuelve el estado con exactamente 6 días 23 h (todavía vigente)", async () => {
    const reciente: EstadoSeba = { ...estadoInicial(new Date("2026-11-10T16:00:00.000Z")), etapa: "cotizado" };
    const { efectos } = crear({}, () => ({ data: { seba_pedido: reciente } }));
    expect(await efectos.leerEstado()).toEqual(reciente);
  });

  it("leerEstado devuelve null con JSON inválido, con null y con etapa desconocida", async () => {
    for (const basura of [null, "texto", 42, [], { etapa: "inventada" }]) {
      const { efectos } = crear({}, () => ({ data: { seba_pedido: basura } }));
      expect(await efectos.leerEstado()).toBeNull();
    }
  });

  it("leerEstado con error de base: null y aviso en el log, sin lanzar", async () => {
    const { efectos } = crear({}, () => ({ error: { message: "sin conexión" } }));
    expect(await efectos.leerEstado()).toBeNull();
    expect(logWarn).toHaveBeenCalledWith("seba2_estado_no_legible", expect.objectContaining({ conversationId: CONV }));
  });

  it("guardarEstado hace UPDATE de seba_pedido en ESTA conversación", async () => {
    const estado: EstadoSeba = { ...estadoInicial(AHORA), etapa: "eligiendo_pago" };
    const { efectos, operaciones } = crear();

    await efectos.guardarEstado(estado);

    const escritura = operaciones.find((o) => o.op === "update")!;
    expect(escritura.tabla).toBe("conversations");
    expect(escritura.payload).toEqual({ seba_pedido: estado });
    expect(escritura.filtros).toEqual([{ operador: "eq", columna: "id", valor: CONV }]);
  });

  it("guardarEstado con error de base avisa en el log y no lanza", async () => {
    const { efectos } = crear({}, () => ({ error: { message: "no escribe" } }));
    await expect(efectos.guardarEstado(estadoInicial(AHORA))).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith("seba2_estado_no_guardado", expect.objectContaining({ conversationId: CONV }));
  });
});

describe("efectos reales: bienvenida", () => {
  const HACE_24H = new Date(AHORA.getTime() - 24 * 60 * 60 * 1000).toISOString();

  it("reclama con un UPDATE condicional (sin sello o con sello de más de 24 h) y devuelve true si afectó una fila", async () => {
    const { efectos, operaciones } = crear({}, (op) =>
      op.op === "select" ? { data: { welcome_sent_at: null } } : { data: [{ id: CONV }] }
    );

    expect(await efectos.reclamarBienvenida()).toBe(true);

    const update = operaciones.find((o) => o.op === "update")!;
    expect(update.tabla).toBe("conversations");
    expect(update.payload).toEqual({ welcome_sent_at: AHORA.toISOString() });
    expect(update.filtros).toEqual([
      { operador: "eq", columna: "id", valor: CONV },
      { operador: "or", valor: `welcome_sent_at.is.null,welcome_sent_at.lt.${HACE_24H}` },
    ]);
    expect(update.columnas).toBe("id");
  });

  it("devuelve false si el UPDATE no afectó ninguna fila (otro turno la reclamó, o ya hay una vigente)", async () => {
    const { efectos } = crear({}, (op) =>
      op.op === "select" ? { data: { welcome_sent_at: AHORA.toISOString() } } : { data: [] }
    );
    expect(await efectos.reclamarBienvenida()).toBe(false);
  });

  it("devuelve false ante un error de base, sin lanzar", async () => {
    const { efectos } = crear({}, () => ({ error: { message: "x" } }));
    expect(await efectos.reclamarBienvenida()).toBe(false);
  });

  it("si el PRIMER envío tras el reclamo falla, REVIERTE el sello al valor anterior", async () => {
    const anterior = "2026-11-10T10:00:00.000Z";
    simularEnvios(() => salida({ whatsapp_status: "failed" }));
    const { efectos, operaciones } = crear({}, (op) =>
      op.op === "select" ? { data: { welcome_sent_at: anterior } } : { data: [{ id: CONV }] }
    );
    await efectos.reclamarBienvenida();

    await efectos.enviarTexto("Hola, soy Seba", "fijo");

    const updates = operaciones.filter((o) => o.op === "update");
    expect(updates).toHaveLength(2);
    expect(updates[1].payload).toEqual({ welcome_sent_at: anterior });
    // Solo revierte SU sello: si otro turno lo cambió en medio, no lo pisa.
    expect(updates[1].filtros).toEqual([
      { operador: "eq", columna: "id", valor: CONV },
      { operador: "eq", columna: "welcome_sent_at", valor: AHORA.toISOString() },
    ]);
  });

  it("revierte a null cuando no había sello antes, también si la guarda frena el envío (entregar null)", async () => {
    const { efectos, operaciones } = crear({ entregar: vi.fn(async () => null) }, (op) =>
      op.op === "select" ? { data: { welcome_sent_at: null } } : { data: [{ id: CONV }] }
    );
    await efectos.reclamarBienvenida();

    await efectos.enviarTexto("Hola, soy Seba", "fijo");

    const updates = operaciones.filter((o) => o.op === "update");
    expect(updates[1].payload).toEqual({ welcome_sent_at: null });
  });

  it("NO revierte si el primer envío salió bien, ni si falla un envío posterior", async () => {
    const { efectos, operaciones } = crear({}, (op) =>
      op.op === "select" ? { data: { welcome_sent_at: null } } : { data: [{ id: CONV }] }
    );
    await efectos.reclamarBienvenida();
    await efectos.enviarTexto("Hola, soy Seba", "fijo");
    simularEnvios(() => salida({ whatsapp_status: "failed" }));
    await efectos.enviarTexto("segundo", "modelo");

    expect(operaciones.filter((o) => o.op === "update")).toHaveLength(1);
  });

  it("sin haber reclamado la bienvenida, un envío fallido no toca welcome_sent_at", async () => {
    simularEnvios(() => salida({ whatsapp_status: "failed" }));
    const { efectos, operaciones } = crear();
    await efectos.enviarTexto("hola", "modelo");
    expect(operaciones.filter((o) => o.tabla === "conversations")).toHaveLength(0);
  });
});

describe("efectos reales: marcarVisto, productosYaCotizados y mensajes nuevos", () => {
  it("marcarVisto escribe la marca en Redis", async () => {
    const { efectos } = crear();
    await efectos.marcarVisto({ hasta: "2026-11-17T14:59:00.000Z", ids: ["m1"] });
    expect(writeSeenMock).toHaveBeenCalledWith(CONV, { hasta: "2026-11-17T14:59:00.000Z", ids: ["m1"] });
  });

  it("sin Redis, marcarVisto no hace nada; con un error de Redis, no lanza", async () => {
    const { efectos } = crear({ redisDisponible: false });
    await efectos.marcarVisto({ hasta: "x", ids: [] });
    expect(writeSeenMock).not.toHaveBeenCalled();

    writeSeenMock.mockRejectedValueOnce(new Error("redis caído"));
    const { efectos: otro } = crear();
    await expect(otro.marcarVisto({ hasta: "x", ids: [] })).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith("seba2_visto_no_escrito", expect.objectContaining({ conversationId: CONV }));
  });

  it("productosYaCotizados lee las cotizaciones de esta conversación de las últimas 72 h", async () => {
    const { efectos, operaciones } = crear({}, () => ({
      data: [{ product_id: "p1" }, { product_id: "p2" }, { product_id: "p1" }, { product_id: null }],
    }));

    const ids = await efectos.productosYaCotizados();

    expect([...ids].sort()).toEqual(["p1", "p2"]);
    const lectura = operaciones[0];
    expect(lectura.tabla).toBe("conversation_quotes");
    expect(lectura.columnas).toBe("product_id");
    expect(lectura.filtros).toEqual([
      { operador: "eq", columna: "conversation_id", valor: CONV },
      { operador: "gte", columna: "quoted_at", valor: new Date(AHORA.getTime() - 72 * 60 * 60 * 1000).toISOString() },
    ]);
  });

  it("productosYaCotizados con error de base: conjunto vacío y aviso", async () => {
    const { efectos } = crear({}, () => ({ error: { message: "x" } }));
    expect((await efectos.productosYaCotizados()).size).toBe(0);
    expect(logWarn).toHaveBeenCalledWith("seba2_cotizados_no_legibles", expect.any(Object));
  });

  it("hayMensajeNuevoDelCliente filtra por la marca y excluye los ids ya vistos", async () => {
    const visto = { hasta: "2026-11-17T14:59:30.000Z", ids: ["m1", "m2"] };
    const { efectos, operaciones } = crear({ visto }, () => ({ data: [{ id: "m3" }] }));

    expect(await efectos.hayMensajeNuevoDelCliente()).toBe(true);

    const consulta = operaciones[0];
    expect(consulta.tabla).toBe("messages");
    expect(consulta.filtros).toEqual([
      { operador: "eq", columna: "conversation_id", valor: CONV },
      { operador: "eq", columna: "direction", valor: "inbound" },
      { operador: "neq", columna: "message_type", valor: "unsupported" },
      { operador: "gte", columna: "created_at", valor: "2026-11-17T14:59:30.000Z" },
      { operador: "not", columna: "id", valor: ["in", "(m1,m2)"] },
    ]);
    expect(consulta.limite).toBe(1);
  });

  it("hayMensajeNuevoDelCliente: false si no hay filas, false sin marca (sin consultar), false con error", async () => {
    const visto = { hasta: "2026-11-17T14:59:30.000Z", ids: [] };
    const { efectos, operaciones } = crear({ visto }, () => ({ data: [] }));
    expect(await efectos.hayMensajeNuevoDelCliente()).toBe(false);
    // Sin ids vistos no se agrega el `not in ()` (sería una lista vacía inválida).
    expect(operaciones[0].filtros.some((f) => f.operador === "not")).toBe(false);

    const { efectos: sinMarca, operaciones: ops2 } = crear({ visto: null });
    expect(await sinMarca.hayMensajeNuevoDelCliente()).toBe(false);
    expect(ops2).toHaveLength(0);

    const { efectos: conError } = crear({ visto }, () => ({ error: { message: "x" } }));
    expect(await conError.hayMensajeNuevoDelCliente()).toBe(false);
  });
});

describe("efectos reales: cerrar", () => {
  it("pasa el resumen y el último pase (área y motivo) a la bitácora", async () => {
    const { efectos, deps } = crear();
    await efectos.pasarAAsesor({ area: "pagos", motivo: "comprobante_pago", nota: "n" });
    await efectos.pasarAAsesor({ area: "ventas", motivo: "listo_para_comprar", nota: "n2" });
    const r = resumen({ accion: "escalated" });

    await efectos.cerrar(r);

    expect(deps.registrarTurno).toHaveBeenCalledWith(r, { area: "ventas", motivo: "listo_para_comprar" });
  });

  it("sin pase, el segundo argumento es null", async () => {
    const { efectos, deps } = crear();
    await efectos.cerrar(resumen());
    expect(deps.registrarTurno).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("no lanza si registrarTurno lanza: deja el error en el log", async () => {
    const { efectos } = crear({
      registrarTurno: vi.fn(async () => {
        throw new Error("bitácora caída");
      }),
    });

    await expect(efectos.cerrar(resumen())).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("seba2_bitacora_no_escrita", expect.objectContaining({ conversationId: CONV }));
  });
});

describe("efectos reales: silencio decidido", () => {
  it("sin asesor asignado deja el traspaso a «unassigned» con la MISMA razón que v1", async () => {
    const { efectos } = crear();

    await efectos.registrarSilencio("sin_mensaje_nuevo");
    await efectos.registrarSilencio("cortesia_tras_escalada");

    expect(recordHandoffMock).toHaveBeenCalledTimes(2);
    expect(recordHandoffMock.mock.calls[0][1]).toEqual({
      conversationId: CONV,
      reason: "sin_mensaje_nuevo",
      toKind: "unassigned",
      toId: null,
    });
    expect(recordHandoffMock.mock.calls[1][1]).toEqual({
      conversationId: CONV,
      reason: "cortesia_tras_escalada",
      toKind: "unassigned",
      toId: null,
    });
  });

  it("con asesor asignado el traspaso va a «human» y a su id", async () => {
    const { efectos } = crear({ assignedAgentId: "agente-7" });

    await efectos.registrarSilencio("cortesia_tras_escalada");

    expect(recordHandoffMock.mock.calls[0][1]).toEqual({
      conversationId: CONV,
      reason: "cortesia_tras_escalada",
      toKind: "human",
      toId: "agente-7",
    });
  });

  it("nunca lanza: si el traspaso se rechaza o revienta, queda en el log", async () => {
    const { efectos } = crear();
    recordHandoffMock.mockRejectedValueOnce(new Error("base caída"));
    await expect(efectos.registrarSilencio("sin_mensaje_nuevo")).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("seba2_silencio_no_registrado", expect.any(Object));

    logError.mockClear();
    recordHandoffMock.mockResolvedValueOnce(false);
    await expect(efectos.registrarSilencio("sin_mensaje_nuevo")).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("seba2_silencio_no_registrado", expect.any(Object));
  });
});

describe("efectos reales: nota para el asesor", () => {
  it("inserta una nota interna de SISTEMA (nunca 'agent': apagaría la IA por trigger)", async () => {
    const { efectos, operaciones } = crear();

    await efectos.anotarParaAsesor("Mientras espera al asesor, el cliente agregó: «es para una SBR»");

    const insert = operaciones.find((o) => o.tabla === "messages" && o.op === "insert")!;
    expect(insert.payload).toEqual({
      conversation_id: CONV,
      direction: "outbound",
      sender_type: "system",
      message_type: "system_event",
      is_internal_note: true,
      content: "Mientras espera al asesor, el cliente agregó: «es para una SBR»",
    });
  });

  it("LANZA si no se pudo escribir: un pendiente del cliente no puede perderse", async () => {
    const { efectos } = crear({}, (op) => (op.tabla === "messages" ? { error: { message: "no se pudo" } } : {}));

    await expect(efectos.anotarParaAsesor("algo")).rejects.toThrow(/nota/i);
    expect(logError).toHaveBeenCalledWith("seba2_nota_no_escrita", expect.any(Object));
  });
});
