import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * El freno de emergencia. Estos tests fijan el comportamiento actual de la
 * ruta: quién puede pulsarlo, el orden interruptor-antes-que-purga (el
 * invariante documentado en route.ts:52-55), y qué le llega al asesor cuando
 * el UPDATE falla o la purga de Redis se cae.
 *
 * Es caracterización: los defectos que aparezcan se reportan, no se arreglan
 * acá.
 */

/** Marca qué operación corrió primero, para la aserción de orden (caso 5). */
let secuencia: string[];

/** Rol del agente autenticado; null simula sesión ausente. */
let agentRole: "agent" | "supervisor" | "admin" | null;

/** Qué devuelve el UPDATE de agent_settings: éxito o error a voluntad. */
let updateError: { message: string } | null;

/** Últimos argumentos que recibieron .update() y .eq(), para el caso 3. */
let lastUpdatePatch: Record<string, unknown> | null;
let lastEqArgs: [string, unknown] | null;

vi.mock("@/lib/data", () => ({
  fetchCurrentAgent: vi.fn(async () => {
    if (agentRole === null) return null;
    return {
      id: "agent-1",
      displayName: "Agente",
      fullName: "Agente de Prueba",
      avatarUrl: null,
      role: agentRole,
      isActive: true,
    };
  }),
}));

vi.mock("@/lib/ai/queue", () => ({
  stopAgentQueue: vi.fn(async () => {
    secuencia.push("purga");
    return { discarded: 0 };
  }),
}));

function createFakeClient() {
  return {
    from(table: string) {
      if (table !== "agent_settings") {
        throw new Error(`Tabla inesperada en el test: ${table}`);
      }
      return {
        update(patch: Record<string, unknown>) {
          lastUpdatePatch = patch;
          return {
            eq: async (col: string, value: unknown) => {
              lastEqArgs = [col, value];
              secuencia.push("interruptor");
              return { error: updateError };
            },
          };
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => createFakeClient()),
}));

import { POST } from "./route";
import { stopAgentQueue } from "@/lib/ai/queue";

const stopAgentQueueMock = vi.mocked(stopAgentQueue);

beforeEach(() => {
  secuencia = [];
  agentRole = "supervisor";
  updateError = null;
  lastUpdatePatch = null;
  lastEqArgs = null;
  stopAgentQueueMock.mockReset();
  stopAgentQueueMock.mockImplementation(async () => {
    secuencia.push("purga");
    return { discarded: 0 };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/agent/stop — quién puede pulsar el freno", () => {
  it("sin sesión: 401, y ni el interruptor ni la purga se tocan", async () => {
    agentRole = null;

    const res = await POST();

    expect(res.status).toBe(401);
    expect(secuencia).toEqual([]);
    expect(stopAgentQueueMock).not.toHaveBeenCalled();
  });

  it("rol 'agent': 403, y ni el interruptor ni la purga se tocan", async () => {
    agentRole = "agent";

    const res = await POST();

    expect(res.status).toBe(403);
    expect(secuencia).toEqual([]);
    expect(stopAgentQueueMock).not.toHaveBeenCalled();
  });

  it("rol 'supervisor': 200, y el UPDATE lleva el patch y el filtro correctos", async () => {
    agentRole = "supervisor";

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(lastUpdatePatch).toMatchObject({
      ai_globally_enabled: false,
      updated_by: "agent-1",
    });
    expect(typeof lastUpdatePatch?.updated_at).toBe("string");
    expect(lastEqArgs).toEqual(["id", true]);
  });

  it("rol 'admin': también 200 (el otro rol del contrato RLS)", async () => {
    agentRole = "admin";

    const res = await POST();

    expect(res.status).toBe(200);
  });
});

describe("POST /api/agent/stop — el orden interruptor-antes-que-purga", () => {
  it("el interruptor se pulsa antes de purgar la cola", async () => {
    await POST();

    expect(secuencia).toEqual(["interruptor", "purga"]);
  });
});

describe("POST /api/agent/stop — el UPDATE falla", () => {
  it("error del UPDATE: 500 y stopAgentQueue no se llama", async () => {
    updateError = { message: "conexión perdida" };

    const res = await POST();

    expect(res.status).toBe(500);
    expect(stopAgentQueueMock).not.toHaveBeenCalled();
    expect(secuencia).toEqual(["interruptor"]);
  });
});

describe("POST /api/agent/stop — Redis caído durante la purga", () => {
  it("stopAgentQueue lanza: 200 igual, discarded null, con warning", async () => {
    stopAgentQueueMock.mockImplementation(async () => {
      secuencia.push("purga");
      throw new Error("ECONNREFUSED");
    });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.discarded).toBeNull();
    expect(typeof body.warning).toBe("string");
    expect(body.warning.length).toBeGreaterThan(0);
  });
});

describe("POST /api/agent/stop — idempotencia", () => {
  it("dos POST seguidos: 200 ambos, dos UPDATE, dos purgas", async () => {
    let purgas = 0;
    stopAgentQueueMock.mockImplementation(async () => {
      purgas += 1;
      secuencia.push("purga");
      return { discarded: purgas === 1 ? 3 : 0 };
    });

    const res1 = await POST();
    const body1 = await res1.json();
    const res2 = await POST();
    const body2 = await res2.json();

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(body1.discarded).toBe(3);
    expect(body2.discarded).toBe(0);
    expect(stopAgentQueueMock).toHaveBeenCalledTimes(2);
    expect(secuencia.filter((s) => s === "interruptor")).toHaveLength(2);
    expect(secuencia.filter((s) => s === "purga")).toHaveLength(2);
  });
});

describe("POST /api/agent/stop — auditoría", () => {
  it("el camino feliz emite 'ia_apagada' con agentId y descartados", async () => {
    stopAgentQueueMock.mockImplementation(async () => {
      secuencia.push("purga");
      return { discarded: 7 };
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await POST();

    const linea = spy.mock.calls.map((call) => call[0] as string).find((line) => {
      try {
        return JSON.parse(line).event === "ia_apagada";
      } catch {
        return false;
      }
    });
    expect(linea).toBeDefined();
    const entry = JSON.parse(linea as string);

    expect(entry.event).toBe("ia_apagada");
    expect(entry.agentId).toBe("agent-1");
    expect(entry.descartados).toBe(7);

    spy.mockRestore();
  });
});
