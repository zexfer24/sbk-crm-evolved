import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * El repaso del atraso al encender la IA (ver el comentario largo al tope de
 * route.ts). Estos tests fijan el orden de las guardas tal como está hoy:
 * sesión -> rol -> agent_can_run -> lock del barrido -> consulta del atraso ->
 * encolar. El lock se pide DESPUÉS de agent_can_run y ANTES de la consulta a
 * propósito -- eso es lo que permite relanzar sin gastar el lock cuando la IA
 * está apagada, y lo que evita consultar el atraso cuando ya hay una tanda en
 * curso.
 */

const fetchCurrentAgentMock = vi.fn();
const fetchBacklogConversationIdsMock = vi.fn();

vi.mock("@/lib/data", () => ({
  fetchCurrentAgent: (...args: unknown[]) => fetchCurrentAgentMock(...args),
  fetchBacklogConversationIds: (...args: unknown[]) => fetchBacklogConversationIdsMock(...args),
}));

const rpcMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    rpc: (...args: unknown[]) => rpcMock(...args),
  })),
}));

const enqueueAgentTurnsMock = vi.fn();
const pendingAgentTurnsMock = vi.fn(async () => 7);

vi.mock("@/lib/ai/queue", () => ({
  enqueueAgentTurns: (...args: unknown[]) => enqueueAgentTurnsMock(...args),
  pendingAgentTurns: () => pendingAgentTurnsMock(),
}));

const acquireSweepLockMock = vi.fn();
const releaseSweepLockMock = vi.fn();

vi.mock("@/lib/ai/redis-queue", () => ({
  acquireSweepLock: (...args: unknown[]) => acquireSweepLockMock(...args),
  releaseSweepLock: (...args: unknown[]) => releaseSweepLockMock(...args),
}));

vi.mock("@/lib/redis", () => ({
  // Objeto de juguete: sin esto el módulo real exige REDIS_URL o abre un
  // socket ioredis de verdad al importarse.
  getRedis: vi.fn(() => ({})),
}));

import { POST } from "./route";

/** Rol con permiso: supervisor o admin, indistinto para estos tests. */
function supervisorAgent() {
  return { id: "agent-1", role: "supervisor" };
}

beforeEach(() => {
  fetchCurrentAgentMock.mockReset();
  fetchCurrentAgentMock.mockImplementation(async () => supervisorAgent());

  fetchBacklogConversationIdsMock.mockReset();
  fetchBacklogConversationIdsMock.mockImplementation(async () => ["conv-2", "conv-1"]);

  rpcMock.mockReset();
  rpcMock.mockImplementation(async () => ({ data: true, error: null }));

  enqueueAgentTurnsMock.mockReset();
  enqueueAgentTurnsMock.mockImplementation(async () => undefined);

  pendingAgentTurnsMock.mockReset();
  pendingAgentTurnsMock.mockImplementation(async () => 7);

  acquireSweepLockMock.mockReset();
  acquireSweepLockMock.mockImplementation(async () => true);

  releaseSweepLockMock.mockReset();
});

describe("POST /api/agent/backlog", () => {
  it("sin sesión: 401, y el lock ni se toca", async () => {
    fetchCurrentAgentMock.mockImplementation(async () => null);

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: "No autenticado." });
    expect(acquireSweepLockMock).not.toHaveBeenCalled();
    expect(enqueueAgentTurnsMock).not.toHaveBeenCalled();
  });

  it("rol agent (sin permiso): 403, y el lock no se quema por un intento no autorizado", async () => {
    fetchCurrentAgentMock.mockImplementation(async () => ({ id: "agent-2", role: "agent" }));

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({ error: "No autorizado." });
    expect(acquireSweepLockMock).not.toHaveBeenCalled();
    expect(enqueueAgentTurnsMock).not.toHaveBeenCalled();
  });

  it("agent_can_run en false: 200 con enqueued:0 y motivo, sin tocar el lock ni encolar", async () => {
    rpcMock.mockImplementation(async () => ({ data: false, error: null }));

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, enqueued: 0, reason: "La IA no está habilitada." });
    // Que esto NO consuma el lock es lo que permite relanzar en cuanto se
    // encienda la IA, sin esperar los 30 minutos del TTL.
    expect(acquireSweepLockMock).not.toHaveBeenCalled();
    expect(enqueueAgentTurnsMock).not.toHaveBeenCalled();
  });

  it("agent_can_run con la RPC rota (data:null, error): mismo camino que 'false' -- falla cerrado", async () => {
    rpcMock.mockImplementation(async () => ({ data: null, error: { message: "conexión perdida" } }));

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, enqueued: 0, reason: "La IA no está habilitada." });
    expect(acquireSweepLockMock).not.toHaveBeenCalled();
    expect(enqueueAgentTurnsMock).not.toHaveBeenCalled();
  });

  it("lock ocupado: 409 con los pendientes, y ni siquiera se consulta el atraso", async () => {
    acquireSweepLockMock.mockImplementation(async () => false);

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.pending).toBe(7);
    expect(body.error).toContain("7");
    // La protección del lock va ANTES de leer el atraso: si ya hay una tanda
    // en curso, no hace falta ni preguntar qué habría que encolar.
    expect(fetchBacklogConversationIdsMock).not.toHaveBeenCalled();
    expect(enqueueAgentTurnsMock).not.toHaveBeenCalled();
  });

  it("camino feliz: encola los ids en el mismo orden, con TTL y opciones exactas", async () => {
    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, enqueued: 2 });
    expect(acquireSweepLockMock).toHaveBeenCalledWith(expect.anything(), 1800);
    expect(enqueueAgentTurnsMock).toHaveBeenCalledWith(["conv-2", "conv-1"], {
      debounceSeconds: 0,
      spacingSeconds: 1,
    });
  });

  it("atraso vacío: 200 con enqueued:0, pero igual se encola un array vacío", async () => {
    fetchBacklogConversationIdsMock.mockImplementation(async () => []);

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, enqueued: 0 });
    expect(enqueueAgentTurnsMock).toHaveBeenCalledWith([], { debounceSeconds: 0, spacingSeconds: 1 });
    // DEFECTO CONOCIDO (D1): el lock queda tomado 30 min aunque no hubiera nada que encolar.
    expect(releaseSweepLockMock).not.toHaveBeenCalled();
  });

  it("la consulta del atraso falla: 500, nada encolado, y el lock queda tomado", async () => {
    fetchBacklogConversationIdsMock.mockImplementation(async () => {
      throw new Error("timeout de postgres");
    });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "No se pudo leer el atraso." });
    expect(enqueueAgentTurnsMock).not.toHaveBeenCalled();
    // DEFECTO CONOCIDO (D1): el lock queda tomado 30 minutos aunque la
    // consulta haya fallado -- nadie puede relanzar el barrido hasta que
    // venza el TTL o alguien libere el lock a mano.
    expect(releaseSweepLockMock).not.toHaveBeenCalled();
  });
});
