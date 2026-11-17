import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from "@/lib/business-hours";
import type { TurnLessons } from "@/lib/ai/lessons";

const fetchTurnLessonsMock = vi.fn();
const escalationOpenMock = vi.fn();
const logWarn = vi.fn();

vi.mock("@/lib/ai/lessons", () => ({
  fetchTurnLessons: (...a: unknown[]) => fetchTurnLessonsMock(...a),
}));
vi.mock("@/lib/ai/handoffs", () => ({
  escalationOpen: (...a: unknown[]) => escalationOpenMock(...a),
}));
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: (...a: unknown[]) => logWarn(...a), error: vi.fn() },
  errorText: (err: unknown) => (err instanceof Error ? err.message : JSON.stringify(err)),
}));

import {
  cargarDatosDeTurno,
  derivarRafaga,
  recortarHastaElCliente,
  type HistorialDeTurno,
} from "./contexto";

// Martes 17/11/2026 11:00 en Caracas (UTC-4): la tienda está abierta (L-V 8:00-18:00).
const AHORA = new Date("2026-11-17T15:00:00.000Z");
// Sábado 21/11/2026 11:00 en Caracas: cerrada, abre el lunes.
const AHORA_CERRADO = new Date("2026-11-21T15:00:00.000Z");

// ---------------------------------------------------------------------------
// Fake de Supabase que REGISTRA tabla, columnas del select y cada filtro con su
// operador, columna y valor: un fake que ignora el operador o el valor no
// detecta un `.eq` cambiado por otro ni un filtro que se perdió.
// ---------------------------------------------------------------------------
interface Filtro {
  operador: string;
  columna?: string;
  valor?: unknown;
}
interface Operacion {
  tabla: string;
  columnas?: string;
  filtros: Filtro[];
  terminal: "lista" | "single" | "maybeSingle";
  limite?: number;
}
interface Respuesta {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

function crearFake(responder: (op: Operacion) => Respuesta) {
  const operaciones: Operacion[] = [];

  function constructor(tabla: string) {
    const op: Operacion = { tabla, filtros: [], terminal: "lista" };
    const filtro = (operador: string) => (columna: string, valor: unknown) => {
      op.filtros.push({ operador, columna, valor });
      return q;
    };
    const q = {
      select(columnas?: string) {
        op.columnas = columnas;
        return q;
      },
      eq: filtro("eq"),
      neq: filtro("neq"),
      in: filtro("in"),
      order() {
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
        const r = responder(op);
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(resolve, reject);
      },
    };
    return q;
  }

  const client = { from: (tabla: string) => constructor(tabla) } as unknown as SupabaseClient<Database>;
  return { client, operaciones };
}

function filtroDe(op: Operacion, operador: string, columna: string) {
  return op.filtros.find((f) => f.operador === operador && f.columna === columna);
}

const CONV = "conv-1";

const FILA_CONVERSACION = {
  id: CONV,
  contact_id: "contact-1",
  assigned_agent_id: null,
  ai_enabled: true,
  status: "open",
  welcome_sent_at: null,
  last_customer_message_at: "2026-11-17T14:59:00.000Z",
  escalation_area: null,
  contact: { display_name: "José Pérez", profile_name: null },
};

const FILA_CONFIG = {
  welcome_text: "Hola, buen día, mi nombre es Seba.",
  welcome_followups: ["¿En qué te ayudo?", "Cuéntame qué buscas"],
  cashea_datos_text: "Pásame cédula y teléfono",
  cashea_minimo_usd: "20.00",
  cashea_seis_cuotas_desde_usd: 120,
  business_hours: {
    mon: [["08:00", "18:00"]],
    tue: [["08:00", "18:00"]],
    wed: [["08:00", "18:00"]],
    thu: [["08:00", "18:00"]],
    fri: [["08:00", "18:00"]],
    sat: [],
    sun: [],
  },
};

const FILAS_METODOS = [
  {
    key: "pago_movil",
    label: "Pago móvil",
    currency: "VES",
    instructions: "Banco 0102",
    seba_entrega: true,
    is_active: true,
    sort_order: 1,
    updated_at: "2026-11-16T12:00:00.000Z",
  },
  {
    key: "zelle",
    label: "Zelle",
    currency: "USD",
    instructions: "pagos@sbk.com",
    seba_entrega: true,
    is_active: true,
    sort_order: 2,
    updated_at: "2026-11-16T12:00:00.000Z",
  },
];

const LECCIONES: TurnLessons = { global: ["Saluda breve"], chat: [] };

interface Escenario {
  conversacion?: Respuesta;
  config?: Respuesta;
  metodos?: Respuesta;
  agentes?: Respuesta;
  ultimoAsesor?: Respuesta;
  escalada?: Respuesta;
}

function fakeDeEscenario(e: Escenario = {}) {
  return crearFake((op) => {
    switch (op.tabla) {
      case "conversations":
        return e.conversacion ?? { data: FILA_CONVERSACION };
      case "agent_settings":
        return e.config ?? { data: FILA_CONFIG };
      case "payment_methods":
        return e.metodos ?? { data: FILAS_METODOS };
      case "agents":
        return e.agentes ?? { data: [] };
      case "messages":
        return e.ultimoAsesor ?? { data: null };
      case "conversation_handoffs":
        return e.escalada ?? { data: null };
      default:
        throw new Error(`tabla no simulada: ${op.tabla}`);
    }
  });
}

beforeEach(() => {
  fetchTurnLessonsMock.mockReset().mockResolvedValue(LECCIONES);
  escalationOpenMock.mockReset().mockResolvedValue(false);
  logWarn.mockReset();
});

describe("cargarDatosDeTurno", () => {
  it("caso feliz: arma todo lo que el turno necesita", async () => {
    const { client } = fakeDeEscenario({
      agentes: { data: [{ display_name: "Ana Gómez" }, { display_name: "Luis" }] },
    });

    const datos = await cargarDatosDeTurno(client, CONV, AHORA);

    expect(datos.conversacion).toEqual({
      id: CONV,
      contactId: "contact-1",
      assignedAgentId: null,
      aiEnabled: true,
      status: "open",
      welcomeSentAt: null,
      lastCustomerMessageAt: "2026-11-17T14:59:00.000Z",
      escalationArea: null,
    });
    expect(datos.customerName).toBe("José");
    expect(datos.config).toEqual({
      welcomeText: "Hola, buen día, mi nombre es Seba.",
      welcomeFollowups: ["¿En qué te ayudo?", "Cuéntame qué buscas"],
      casheaDatosText: "Pásame cédula y teléfono",
      casheaMinimoUsd: 20,
      casheaSeisCuotasDesdeUsd: 120,
    });
    expect(datos.metodos.map((m) => m.key)).toEqual(["pago_movil", "zelle"]);
    expect(datos.metodos[0]).toMatchObject({ label: "Pago móvil", currency: "VES", sebaEntrega: true });
    expect(datos.businessHours.mon).toEqual([["08:00", "18:00"]]);
    expect(datos.tiendaAbierta).toBe(true);
    expect(datos.cuandoAbre).toBeNull();
    expect(datos.lessons).toEqual(LECCIONES);
    expect(datos.nombresDeAsesores).toEqual(["Ana", "Luis"]);
    expect(datos.escaladaAbierta).toBe(false);
    expect(datos.esperaDeAsesor).toBeNull();
    expect(datos.asesorEscribioHaceMin).toBeNull();
    expect(fetchTurnLessonsMock).toHaveBeenCalledWith(client, CONV);
    expect(escalationOpenMock).toHaveBeenCalledWith(client, CONV);
  });

  it("pide solo las formas de pago ACTIVAS, en su orden", async () => {
    const { client, operaciones } = fakeDeEscenario();

    await cargarDatosDeTurno(client, CONV, AHORA);

    const op = operaciones.find((o) => o.tabla === "payment_methods")!;
    expect(filtroDe(op, "eq", "is_active")?.valor).toBe(true);
    expect(op.columnas).toContain("instructions");
  });

  it("la conversación se lee por su id con los datos del contacto", async () => {
    const { client, operaciones } = fakeDeEscenario();

    await cargarDatosDeTurno(client, CONV, AHORA);

    const op = operaciones.find((o) => o.tabla === "conversations")!;
    expect(filtroDe(op, "eq", "id")?.valor).toBe(CONV);
    expect(op.columnas).toContain("escalation_area");
    expect(op.columnas).toContain("display_name");
  });

  it("sin configuración de Seba v2 (migración faltante) lanza con un mensaje claro", async () => {
    const { client } = fakeDeEscenario({
      config: { data: null, error: { message: "column does not exist", code: "42703" } },
    });

    await expect(cargarDatosDeTurno(client, CONV, AHORA)).rejects.toThrow(/configuración de Seba v2/);
  });

  it("una configuración vacía (null sin error) también lanza", async () => {
    const { client } = fakeDeEscenario({ config: { data: null } });

    await expect(cargarDatosDeTurno(client, CONV, AHORA)).rejects.toThrow(/configuración de Seba v2/);
  });

  it("un error leyendo la conversación lanza", async () => {
    const { client } = fakeDeEscenario({ conversacion: { error: { message: "boom" } } });

    await expect(cargarDatosDeTurno(client, CONV, AHORA)).rejects.toThrow(/conversación/);
  });

  it("una conversación que no existe lanza", async () => {
    const { client } = fakeDeEscenario({ conversacion: { data: null } });

    await expect(cargarDatosDeTurno(client, CONV, AHORA)).rejects.toThrow(/conversación/);
  });

  it("un error leyendo las formas de pago lanza", async () => {
    const { client } = fakeDeEscenario({ metodos: { error: { message: "boom" } } });

    await expect(cargarDatosDeTurno(client, CONV, AHORA)).rejects.toThrow(/formas de pago/);
  });

  it("un error en agents da [] y avisa, sin lanzar", async () => {
    const { client } = fakeDeEscenario({ agentes: { error: { message: "boom" } } });

    const datos = await cargarDatosDeTurno(client, CONV, AHORA);

    expect(datos.nombresDeAsesores).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith(
      "seba2_contexto_parcial",
      expect.objectContaining({ conversationId: CONV, que: "asesores" })
    );
  });

  it("un error leyendo el último mensaje de asesor da null y avisa", async () => {
    const { client } = fakeDeEscenario({ ultimoAsesor: { error: { message: "boom" } } });

    const datos = await cargarDatosDeTurno(client, CONV, AHORA);

    expect(datos.asesorEscribioHaceMin).toBeNull();
    expect(logWarn).toHaveBeenCalledWith(
      "seba2_contexto_parcial",
      expect.objectContaining({ conversationId: CONV, que: "ultimo_mensaje_de_asesor" })
    );
  });

  it("lo precargado no se vuelve a leer: ni el horario ni las lecciones", async () => {
    const { client, operaciones } = fakeDeEscenario();
    const horario: BusinessHours = { ...DEFAULT_BUSINESS_HOURS, sat: [["09:00", "13:00"]] };
    const lecciones: TurnLessons = { global: ["x"], chat: ["y"] };

    const datos = await cargarDatosDeTurno(client, CONV, AHORA, { lessons: lecciones, businessHours: horario });

    expect(fetchTurnLessonsMock).not.toHaveBeenCalled();
    expect(datos.lessons).toBe(lecciones);
    expect(datos.businessHours).toBe(horario);
    const op = operaciones.find((o) => o.tabla === "agent_settings")!;
    expect(op.columnas).not.toContain("business_hours");
    expect(op.columnas).toContain("welcome_text");
  });

  it("sin precargado lee el horario de la misma consulta de configuración", async () => {
    const { client, operaciones } = fakeDeEscenario();

    await cargarDatosDeTurno(client, CONV, AHORA);

    const consultas = operaciones.filter((o) => o.tabla === "agent_settings");
    expect(consultas).toHaveLength(1);
    expect(consultas[0].columnas).toContain("business_hours");
    expect(filtroDe(consultas[0], "eq", "id")?.valor).toBe(true);
  });

  it("un horario roto en la base cae al horario por defecto", async () => {
    const { client } = fakeDeEscenario({ config: { data: { ...FILA_CONFIG, business_hours: { mon: "mal" } } } });

    const datos = await cargarDatosDeTurno(client, CONV, AHORA);

    expect(datos.businessHours).toEqual(DEFAULT_BUSINESS_HOURS);
  });

  describe("nombresDeAsesores", () => {
    it("excluye al que se llama como el cliente (sin tildes ni mayúsculas) y a los de menos de 3 letras", async () => {
      const { client, operaciones } = fakeDeEscenario({
        agentes: {
          data: [
            { display_name: "jose Martínez" },
            { display_name: "JOSÉ" },
            { display_name: "Ana López" },
            { display_name: "Al" },
            { display_name: "Ana Belén" },
            { display_name: "  Pedro  " },
          ],
        },
      });

      const datos = await cargarDatosDeTurno(client, CONV, AHORA);

      // El cliente es "José": ni "jose" ni "JOSÉ"; "Al" tiene 2 letras; "Ana" va una sola vez.
      expect(datos.nombresDeAsesores).toEqual(["Ana", "Pedro"]);
      const op = operaciones.find((o) => o.tabla === "agents")!;
      expect(filtroDe(op, "eq", "is_active")?.valor).toBe(true);
      expect(filtroDe(op, "neq", "role")?.valor).toBe("caja");
    });

    it("sin nombre de cliente válido no excluye a nadie por ese motivo", async () => {
      const { client } = fakeDeEscenario({
        conversacion: { data: { ...FILA_CONVERSACION, contact: { display_name: "+584121112233", profile_name: null } } },
        agentes: { data: [{ display_name: "José Rojas" }] },
      });

      const datos = await cargarDatosDeTurno(client, CONV, AHORA);

      expect(datos.customerName).toBeNull();
      expect(datos.nombresDeAsesores).toEqual(["José"]);
    });
  });

  describe("esperaDeAsesor", () => {
    it("es null sin escalada abierta, aunque haya un traspaso viejo", async () => {
      const { client } = fakeDeEscenario({ escalada: { data: { created_at: "2026-11-17T14:00:00.000Z" } } });

      const datos = await cargarDatosDeTurno(client, CONV, AHORA);

      expect(datos.escaladaAbierta).toBe(false);
      expect(datos.esperaDeAsesor).toBeNull();
    });

    it("con escalada abierta y sin área en la conversación usa «ventas»; los minutos salen del traspaso", async () => {
      escalationOpenMock.mockResolvedValue(true);
      const { client, operaciones } = fakeDeEscenario({
        escalada: { data: { created_at: "2026-11-17T14:35:30.000Z" } },
      });

      const datos = await cargarDatosDeTurno(client, CONV, AHORA);

      expect(datos.escaladaAbierta).toBe(true);
      expect(datos.esperaDeAsesor).toEqual({ area: "ventas", minutos: 24 });
      const op = operaciones.find((o) => o.tabla === "conversation_handoffs")!;
      expect(filtroDe(op, "eq", "conversation_id")?.valor).toBe(CONV);
      expect(filtroDe(op, "in", "reason")?.valor).toEqual(["escalada", "escalada_sin_asesor"]);
    });

    it("usa el área de la conversación cuando existe", async () => {
      escalationOpenMock.mockResolvedValue(true);
      const { client } = fakeDeEscenario({
        conversacion: { data: { ...FILA_CONVERSACION, escalation_area: "pagos" } },
        escalada: { data: { created_at: "2026-11-17T14:50:00.000Z" } },
      });

      const datos = await cargarDatosDeTurno(client, CONV, AHORA);

      expect(datos.conversacion.escalationArea).toBe("pagos");
      expect(datos.esperaDeAsesor).toEqual({ area: "pagos", minutos: 10 });
    });

    it("si no encuentra el traspaso, 0 minutos", async () => {
      escalationOpenMock.mockResolvedValue(true);
      const { client } = fakeDeEscenario({ escalada: { data: null } });

      const datos = await cargarDatosDeTurno(client, CONV, AHORA);

      expect(datos.esperaDeAsesor).toEqual({ area: "ventas", minutos: 0 });
    });

    it("un área desconocida en la base cae a «ventas» y no se propaga", async () => {
      escalationOpenMock.mockResolvedValue(true);
      const { client } = fakeDeEscenario({
        conversacion: { data: { ...FILA_CONVERSACION, escalation_area: "marcianos" } },
      });

      const datos = await cargarDatosDeTurno(client, CONV, AHORA);

      expect(datos.conversacion.escalationArea).toBeNull();
      expect(datos.esperaDeAsesor?.area).toBe("ventas");
    });
  });

  describe("asesorEscribioHaceMin", () => {
    it("filtra por mensajes de asesor, salientes y sin notas internas", async () => {
      const { client, operaciones } = fakeDeEscenario({
        ultimoAsesor: { data: { created_at: "2026-11-17T14:40:00.000Z" } },
      });

      const datos = await cargarDatosDeTurno(client, CONV, AHORA);

      expect(datos.asesorEscribioHaceMin).toBe(20);
      const op = operaciones.find((o) => o.tabla === "messages")!;
      expect(filtroDe(op, "eq", "conversation_id")?.valor).toBe(CONV);
      expect(filtroDe(op, "eq", "sender_type")?.valor).toBe("agent");
      expect(filtroDe(op, "eq", "direction")?.valor).toBe("outbound");
      expect(filtroDe(op, "eq", "is_internal_note")?.valor).toBe(false);
      expect(op.limite).toBe(1);
    });
  });

  describe("horario", () => {
    it("fuera de horario: tienda cerrada y cuándo abre", async () => {
      const { client } = fakeDeEscenario();

      const datos = await cargarDatosDeTurno(client, CONV, AHORA_CERRADO);

      expect(datos.tiendaAbierta).toBe(false);
      expect(datos.cuandoAbre).toBe("el lunes a las 8:00 am");
    });

    it("con el horario cerrado los siete días no sabe cuándo abre (null)", async () => {
      const cerrado = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
      const { client } = fakeDeEscenario({ config: { data: { ...FILA_CONFIG, business_hours: cerrado } } });

      const datos = await cargarDatosDeTurno(client, CONV, AHORA);

      expect(datos.tiendaAbierta).toBe(false);
      expect(datos.cuandoAbre).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

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

const user = (id: string, texto: string, hace: number, lectura?: Linea["lectura"]): Linea => ({
  rol: "user",
  texto,
  hace,
  id,
  lectura,
});
const bot = (id: string, texto: string, hace: number): Linea => ({ rol: "assistant", texto, hace, id });

describe("derivarRafaga", () => {
  it("una ráfaga de dos líneas tras una respuesta", () => {
    const h = historial([
      user("m1", "Hola", 300),
      bot("m2", "Buenas, ¿qué buscas?", 299),
      user("m3", "Precio del casco LS2", 2),
      user("m4", "talla M", 1),
    ]);

    const r = derivarRafaga(h, null, AHORA);

    expect(r.lineas).toEqual(["Precio del casco LS2", "talla M"]);
    expect(r.triggerMessageId).toBe("m4");
    expect(r.marcador).toEqual({ hasta: h.createdAt[3], ids: ["m4"] });
  });

  it("con un marcador «visto» que ya cubre la primera, solo queda lo nuevo", () => {
    const h = historial([
      user("m1", "Precio del casco LS2", 20),
      bot("m2", "Cuesta 100", 19),
      user("m3", "y el negro?", 2),
    ]);
    const visto = { hasta: h.createdAt[0]!, ids: ["m1"] };

    const r = derivarRafaga(h, visto, AHORA);

    expect(r.lineas).toEqual(["y el negro?"]);
    expect(r.triggerMessageId).toBe("m3");
    expect(r.marcador).toEqual({ hasta: h.createdAt[2], ids: ["m3"] });
  });

  it("sin pendientes: líneas vacías y marcador null", () => {
    const h = historial([user("m1", "Hola", 20), bot("m2", "Buenas", 19)]);
    const visto = { hasta: h.createdAt[0]!, ids: ["m1"] };

    const r = derivarRafaga(h, visto, AHORA);

    expect(r.lineas).toEqual([]);
    expect(r.lecturas).toEqual([]);
    expect(r.triggerMessageId).toBeNull();
    expect(r.marcador).toBeNull();
    expect(r.ventanaNueva).toBe(false);
    expect(r.cortePrevio).toBeNull();
  });

  it("un historial vacío no rompe", () => {
    const r = derivarRafaga({ messages: [], createdAt: [], ids: [], lecturas: [] }, null, AHORA);

    expect(r.lineas).toEqual([]);
    expect(r.marcador).toBeNull();
  });

  describe("ventanaNueva", () => {
    it("true cuando no hay mensajes previos del cliente", () => {
      const h = historial([user("m1", "Hola", 1)]);

      expect(derivarRafaga(h, null, AHORA).ventanaNueva).toBe(true);
    });

    it("true cuando el anterior del cliente tiene 25 h", () => {
      const h = historial([
        user("m1", "Precio del casco", 25 * 60 + 5),
        bot("m2", "100 dólares", 25 * 60),
        user("m3", "Hola otra vez", 1),
      ]);

      expect(derivarRafaga(h, null, AHORA).ventanaNueva).toBe(true);
    });

    it("false cuando el anterior del cliente fue hace 2 h", () => {
      const h = historial([
        user("m1", "Precio del casco", 125),
        bot("m2", "100 dólares", 124),
        user("m3", "Gracias, y el negro?", 1),
      ]);

      expect(derivarRafaga(h, null, AHORA).ventanaNueva).toBe(false);
    });

    it("el límite es de 24 h: entre m1 y m3 24 h 0 min ya es ventana nueva, 23 h 58 min no", () => {
      // m3 es la ráfaga (hace 1 min); m1 queda 24 h 0 min o 23 h 58 min antes.
      const justo = historial([user("m1", "a", 24 * 60 + 1), bot("m2", "b", 24 * 60), user("m3", "c", 1)]);
      const menos = historial([user("m1", "a", 24 * 60 - 1), bot("m2", "b", 23 * 60), user("m3", "c", 1)]);

      expect(derivarRafaga(justo, null, AHORA).ventanaNueva).toBe(true);
      expect(derivarRafaga(menos, null, AHORA).ventanaNueva).toBe(false);
    });

    it("un mensaje previo visto (con el marcador) también cuenta como «anterior»", () => {
      const h = historial([user("m1", "Hola", 60), user("m2", "Precio del casco", 1)]);
      const visto = { hasta: h.createdAt[0]!, ids: ["m1"] };

      expect(derivarRafaga(h, visto, AHORA).ventanaNueva).toBe(false);
    });
  });

  it("la lectura de un comprobante en la ráfaga aparece en `lecturas`", () => {
    const campos = {
      tipo: "comprobante_pago",
      es_comprobante_pago: true,
      texto_visible: "Pago móvil",
      comprobante: { monto: 1500, referencia: "123456", banco: "Banesco", fecha: "2026-11-17" },
    };
    const h = historial([
      bot("m1", "Total: 30 $", 30),
      user("m2", "[El cliente envió una foto]", 2, { status: "ok", text: "Comprobante", fields: campos }),
      user("m3", "ya pagué", 1),
    ]);

    const r = derivarRafaga(h, null, AHORA);

    expect(r.lineas).toHaveLength(2);
    expect(r.lecturas).toHaveLength(1);
    expect(r.lecturas[0].es_comprobante_pago).toBe(true);
    expect(r.lecturas[0].texto_visible).toBe("Pago móvil");
  });

  it("ignora lecturas que no están `ok` o cuyos campos no se entienden", () => {
    const h = historial([
      user("m1", "[foto]", 3, { status: "pendiente", text: null, fields: null }),
      user("m2", "[foto]", 2, { status: "ok", text: "x", fields: { tipo: "inventado" } }),
      user("m3", "hola", 1),
    ]);

    expect(derivarRafaga(h, null, AHORA).lecturas).toEqual([]);
  });

  it("un sticker de cierre no cuenta como línea, pero el marcador sí lo da por visto (igual que v1)", () => {
    const h = historial([
      bot("m1", "Cuesta 100", 30),
      user("m2", "gracias", 3),
      user("m3", "[El cliente envió un sticker]", 1),
    ]);

    const r = derivarRafaga(h, null, AHORA);

    expect(r.lineas).toEqual(["gracias"]);
    expect(r.triggerMessageId).toBe("m2");
    expect(r.marcador).toEqual({ hasta: h.createdAt[2], ids: ["m3"] });
  });

  it("dos líneas separadas por más de 10 minutos no son la misma ráfaga", () => {
    const h = historial([user("m1", "pregunta vieja", 60), user("m2", "pregunta nueva", 1)]);

    expect(derivarRafaga(h, null, AHORA).lineas).toEqual(["pregunta nueva"]);
  });

  it("cortePrevio: marca dónde empieza la conversación actual tras un hueco de más de 12 h", () => {
    const h = historial([
      user("m1", "¿Tienen retrovisores?", 20 * 24 * 60),
      bot("m2", "Se agotaron", 20 * 24 * 60 - 5),
      user("m3", "Buenas tardes", 2),
      user("m4", "Llegaron las tapas?", 1),
    ]);

    const r = derivarRafaga(h, null, AHORA);

    expect(r.cortePrevio).toBe(h.createdAt[2]);
  });

  it("cortePrevio es null sin huecos grandes", () => {
    const h = historial([user("m1", "hola", 10), bot("m2", "buenas", 9), user("m3", "precio", 1)]);

    expect(derivarRafaga(h, null, AHORA).cortePrevio).toBeNull();
  });
});

describe("recortarHastaElCliente", () => {
  it("quita lo que no es del cliente al final, en los cuatro arreglos a la vez", () => {
    const h = historial([
      user("m1", "Hola", 30),
      bot("m2", "Buenas", 29),
      user("m3", "Precio?", 5),
      bot("m4", "Cuesta 100", 4),
      bot("m5", "¿Algo más?", 3),
    ]);

    const r = recortarHastaElCliente(h);

    expect(r.messages.map((m) => m.content)).toEqual(["Hola", "Buenas", "Precio?"]);
    expect(r.createdAt).toEqual(h.createdAt.slice(0, 3));
    expect(r.ids).toEqual(["m1", "m2", "m3"]);
    expect(r.lecturas).toHaveLength(3);
  });

  it("deja igual un historial que ya termina en el cliente", () => {
    const h = historial([bot("m1", "Buenas", 30), user("m2", "Precio?", 5)]);

    expect(recortarHastaElCliente(h)).toEqual(h);
  });

  it("no muta la entrada", () => {
    const h = historial([user("m1", "Hola", 30), bot("m2", "Buenas", 29)]);
    const copia = structuredClone(h);

    const r = recortarHastaElCliente(h);

    expect(h).toEqual(copia);
    expect(r).not.toBe(h);
    expect(r.messages).not.toBe(h.messages);
    expect(r.ids).toHaveLength(1);
  });

  it("sin ninguna línea del cliente queda vacío", () => {
    const h = historial([bot("m1", "Buenas", 30)]);

    const r = recortarHastaElCliente(h);

    expect(r).toEqual({ messages: [], createdAt: [], ids: [], lecturas: [] });
  });
});
