import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logWarn = vi.fn();
const logInfo = vi.fn();
vi.mock("@/lib/log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/log")>()),
  log: { info: (...a: unknown[]) => logInfo(...a), warn: (...a: unknown[]) => logWarn(...a), error: vi.fn() },
}));

import { esperarLecturas } from "@/lib/ai/wait-readings";

// ---------------------------------------------------------------------------
// Fake de Supabase: registra operador + columna + valor de cada filtro, el
// argumento de `.order()` y de `.limit()`, y devuelve lo que `respuesta()`
// diga en cada vuelta (así un test cambia el estado de la lectura entre una
// consulta y la siguiente).
// ---------------------------------------------------------------------------
interface Llamada {
  tabla: string;
  select: string;
  filtros: [string, string, unknown][];
  order: [string, unknown] | null;
  limit: number | null;
}

interface FilaFake {
  id: string;
  created_at: string;
  message_type: string;
  message_readings: { status: string } | null;
}

function crearFake(respuesta: (vuelta: number) => { data: FilaFake[] | null; error: unknown }) {
  const llamadas: Llamada[] = [];
  const supabase = {
    from(tabla: string) {
      const llamada: Llamada = { tabla, select: "", filtros: [], order: null, limit: null };
      const builder = {
        select(columnas: string) {
          llamada.select = columnas;
          return builder;
        },
        eq(col: string, val: unknown) {
          llamada.filtros.push(["eq", col, val]);
          return builder;
        },
        in(col: string, val: unknown) {
          llamada.filtros.push(["in", col, val]);
          return builder;
        },
        gte(col: string, val: unknown) {
          llamada.filtros.push(["gte", col, val]);
          return builder;
        },
        order(col: string, opts: unknown) {
          llamada.order = [col, opts];
          return builder;
        },
        limit(n: number) {
          llamada.limit = n;
          llamadas.push(llamada);
          return Promise.resolve(respuesta(llamadas.length));
        },
      };
      return builder;
    },
  };
  return { supabase: supabase as never, llamadas };
}

const AHORA = Date.parse("2026-11-16T15:00:00.000Z");

/** Reloj + `dormir` inyectados: dormir avanza el reloj, nunca espera de verdad. */
function relojFalso() {
  let t = AHORA;
  const pausas: number[] = [];
  return {
    ahora: () => t,
    dormir: async (ms: number) => {
      pausas.push(ms);
      t += ms;
    },
    pausas,
    avanzar: (ms: number) => {
      t += ms;
    },
  };
}

function hace(ms: number): string {
  return new Date(AHORA - ms).toISOString();
}

function fila(parcial: Partial<FilaFake>): FilaFake {
  return { id: "m1", created_at: hace(1000), message_type: "audio", message_readings: null, ...parcial };
}

beforeEach(() => {
  logWarn.mockClear();
  logInfo.mockClear();
  delete process.env.AI_MEDIA_READING;
});

afterEach(() => {
  delete process.env.AI_MEDIA_READING;
});

describe("esperarLecturas", () => {
  it("una lectura pendiente que pasa a ok a los 2 s: espera ~2000 ms y no queda ninguna pendiente", async () => {
    const reloj = relojFalso();
    // Pasadas 5 vueltas (5 × 400 = 2000 ms) la lectura ya está.
    const { supabase, llamadas } = crearFake((vuelta) => ({
      data: [fila({ message_readings: { status: vuelta > 5 ? "ok" : "pendiente" } })],
      error: null,
    }));

    const resultado = await esperarLecturas(supabase, "c1", { ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado).toEqual({ esperadoMs: 2000, pendientes: 0 });
    expect(llamadas).toHaveLength(6);
    expect(reloj.pausas).toEqual([400, 400, 400, 400, 400]);
    expect(logInfo).toHaveBeenCalledWith("turno_espero_lecturas", { conversationId: "c1", esperadoMs: 2000, pendientes: 0 });
  });

  it("una lectura que nunca se resuelve: corta en 8.000 ms con 1 pendiente", async () => {
    const reloj = relojFalso();
    const { supabase } = crearFake(() => ({
      data: [fila({ message_readings: { status: "pendiente" } })],
      error: null,
    }));

    const resultado = await esperarLecturas(supabase, "c1", { ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado).toEqual({ esperadoMs: 8000, pendientes: 1 });
    expect(reloj.pausas).toHaveLength(20);
    expect(logInfo).toHaveBeenCalledWith("turno_espero_lecturas", { conversationId: "c1", esperadoMs: 8000, pendientes: 1 });
  });

  it("maxMs y pasoMs se pueden pasar", async () => {
    const reloj = relojFalso();
    const { supabase } = crearFake(() => ({
      data: [fila({ message_readings: { status: "pendiente" } })],
      error: null,
    }));

    const resultado = await esperarLecturas(supabase, "c1", {
      maxMs: 1000,
      pasoMs: 250,
      ahora: reloj.ahora,
      dormir: reloj.dormir,
    });

    expect(resultado).toEqual({ esperadoMs: 1000, pendientes: 1 });
    expect(reloj.pausas).toEqual([250, 250, 250, 250]);
  });

  it("un adjunto SIN fila de lectura con más de 20 s no se espera", async () => {
    const reloj = relojFalso();
    const { supabase, llamadas } = crearFake(() => ({
      data: [fila({ created_at: hace(21_000), message_readings: null })],
      error: null,
    }));

    const resultado = await esperarLecturas(supabase, "c1", { ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado).toEqual({ esperadoMs: 0, pendientes: 0 });
    expect(llamadas).toHaveLength(1);
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("un adjunto SIN fila de lectura con menos de 20 s SÍ se espera (la descarga puede estar en curso)", async () => {
    const reloj = relojFalso();
    const { supabase } = crearFake((vuelta) => ({
      data: [fila({ created_at: hace(5_000), message_readings: vuelta > 2 ? { status: "ok" } : null })],
      error: null,
    }));

    const resultado = await esperarLecturas(supabase, "c1", { ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado).toEqual({ esperadoMs: 800, pendientes: 0 });
  });

  it("una fila 'pendiente' de más de 120 s quedó huérfana de un deploy: no se espera", async () => {
    const reloj = relojFalso();
    const { supabase, llamadas } = crearFake(() => ({
      data: [fila({ created_at: hace(121_000), message_readings: { status: "pendiente" } })],
      error: null,
    }));

    const resultado = await esperarLecturas(supabase, "c1", { ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado).toEqual({ esperadoMs: 0, pendientes: 0 });
    expect(llamadas).toHaveLength(1);
  });

  it("una fila 'pendiente' de 119 s todavía se espera", async () => {
    const reloj = relojFalso();
    const { supabase } = crearFake(() => ({
      data: [fila({ created_at: hace(119_000), message_readings: { status: "pendiente" } })],
      error: null,
    }));

    const resultado = await esperarLecturas(supabase, "c1", { maxMs: 400, ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado.pendientes).toBe(1);
  });

  it("las lecturas resueltas (ok, vacio, alucinacion, fallo) no se esperan", async () => {
    const reloj = relojFalso();
    const { supabase, llamadas } = crearFake(() => ({
      data: ["ok", "vacio", "alucinacion", "fallo"].map((status, i) =>
        fila({ id: `m${i}`, message_readings: { status } })
      ),
      error: null,
    }));

    const resultado = await esperarLecturas(supabase, "c1", { ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado).toEqual({ esperadoMs: 0, pendientes: 0 });
    expect(llamadas).toHaveLength(1);
    expect(reloj.pausas).toEqual([]);
  });

  it("sin adjuntos recientes: UNA consulta y no espera", async () => {
    const reloj = relojFalso();
    const { supabase, llamadas } = crearFake(() => ({ data: [], error: null }));

    const resultado = await esperarLecturas(supabase, "c1", { ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado).toEqual({ esperadoMs: 0, pendientes: 0 });
    expect(llamadas).toHaveLength(1);
    expect(reloj.pausas).toEqual([]);
  });

  it("la consulta pide exactamente lo que dice el contrato: operador, columna y valor", async () => {
    const reloj = relojFalso();
    const { supabase, llamadas } = crearFake(() => ({ data: [], error: null }));

    await esperarLecturas(supabase, "conv-9", { ahora: reloj.ahora, dormir: reloj.dormir });

    expect(llamadas[0]).toEqual({
      tabla: "messages",
      select: "id, created_at, message_type, message_readings(status)",
      filtros: [
        ["eq", "conversation_id", "conv-9"],
        ["eq", "direction", "inbound"],
        ["in", "message_type", ["audio", "image"]],
        ["gte", "created_at", new Date(AHORA - 10 * 60 * 1000).toISOString()],
      ],
      order: ["created_at", { ascending: false }],
      limit: 10,
    });
  });

  it("el embed uno a uno puede llegar como arreglo: se toma el primero", async () => {
    const reloj = relojFalso();
    const { supabase } = crearFake(() => ({
      data: [{ ...fila({}), message_readings: [{ status: "pendiente" }] as unknown as { status: string } }],
      error: null,
    }));

    const resultado = await esperarLecturas(supabase, "c1", { maxMs: 400, ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado.pendientes).toBe(1);
  });

  it("AI_MEDIA_READING=off: no consulta ni espera", async () => {
    process.env.AI_MEDIA_READING = "off";
    const reloj = relojFalso();
    const { supabase, llamadas } = crearFake(() => ({
      data: [fila({ message_readings: { status: "pendiente" } })],
      error: null,
    }));

    const resultado = await esperarLecturas(supabase, "c1", { ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado).toEqual({ esperadoMs: 0, pendientes: 0 });
    expect(llamadas).toHaveLength(0);
  });

  it("un error de la consulta no lanza: avisa y sigue con pendientes 0", async () => {
    const reloj = relojFalso();
    const { supabase } = crearFake(() => ({ data: null, error: { message: "boom", code: "XX000" } }));

    const resultado = await esperarLecturas(supabase, "c1", { ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado).toEqual({ esperadoMs: 0, pendientes: 0 });
    expect(logWarn).toHaveBeenCalledWith("espera_lecturas_fallo", expect.objectContaining({ conversationId: "c1" }));
  });

  it("un error a mitad de la espera devuelve lo esperado hasta ahí", async () => {
    const reloj = relojFalso();
    const { supabase } = crearFake((vuelta) =>
      vuelta < 3
        ? { data: [fila({ message_readings: { status: "pendiente" } })], error: null }
        : { data: null, error: { message: "se cayó" } }
    );

    const resultado = await esperarLecturas(supabase, "c1", { ahora: reloj.ahora, dormir: reloj.dormir });

    expect(resultado).toEqual({ esperadoMs: 800, pendientes: 0 });
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("una excepción (no solo un error de PostgREST) tampoco lanza", async () => {
    const supabase = {
      from() {
        throw new Error("se cayó el cliente");
      },
    } as never;

    const resultado = await esperarLecturas(supabase, "c1");

    expect(resultado).toEqual({ esperadoMs: 0, pendientes: 0 });
    expect(logWarn).toHaveBeenCalledWith(
      "espera_lecturas_fallo",
      expect.objectContaining({ conversationId: "c1", detail: expect.stringContaining("se cayó el cliente") })
    );
  });
});
