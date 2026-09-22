import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Portón del cron que procesa la cola de turnos de IA: cada llamada exitosa
 * dispara gasto real (turnos de IA). Estos tests fijan el comportamiento
 * actual de la guarda — sobre todo los casos en los que `processQueuedTurns`
 * NO debe llamarse, porque ahí es donde una regresión saldría cara.
 */

// `vi.hoisted` porque `vi.mock` se eleva sobre cualquier `const` normal: sin
// esto, la fábrica ve `processQueuedTurnsMock` antes de que exista (TDZ).
const { processQueuedTurnsMock, reconcileOrphanTurnsMock, redisSetMock, rpcMock } = vi.hoisted(() => ({
  processQueuedTurnsMock: vi.fn(async () => ({ processed: 2, failed: 1, deferred: 0 })),
  reconcileOrphanTurnsMock: vi.fn(async () => ({
    revisadas: 5,
    yaEnCola: 1,
    bloqueadasPorLock: 1,
    encoladas: 3,
  })),
  // T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026): el
  // purgado diario de `agent_turn_calls`. `redisSetMock` simula el `SET NX
  // EX` del lock (por default gana el lock, como el primer disparo del día);
  // `rpcMock` simula CUALQUIER RPC que el cliente admin (mockeado más abajo)
  // reciba -- hoy solo `agent_turn_calls_purge`. Firmas amplias
  // (`...args: unknown[]`, `data: number | null`) a propósito: los tests de
  // abajo inspeccionan `mock.calls[0]` con varios argumentos y sobrescriben
  // el resultado con `mockImplementationOnce`/`mockResolvedValueOnce` con
  // formas distintas (éxito, error, lock perdido).
  redisSetMock: vi.fn(async (..._args: unknown[]): Promise<string | null> => "OK"),
  rpcMock: vi.fn(async (fn: string): Promise<{ data: number | null; error: { message: string } | null }> => {
    if (fn === "agent_turn_calls_purge") return { data: 12, error: null };
    throw new Error(`Fake Supabase: rpc no soportada: ${fn}`);
  }),
}));

// Fábricas completas, sin `importOriginal`: el módulo real de la cola
// arrastra el agente de IA, sus SDKs e ioredis, y el del reconciliador
// arrastra la cola (mismo problema, un nivel más abajo) más
// @/lib/supabase/admin. Nada de eso hace falta para probar la guarda.
vi.mock("@/lib/ai/queue", () => ({
  processQueuedTurns: processQueuedTurnsMock,
}));
vi.mock("@/lib/ai/reconciler", () => ({
  reconcileOrphanTurns: reconcileOrphanTurnsMock,
}));

// Cliente de juguete: alcanza con que exista y responda a `.rpc()` -- el
// purgado (T4) es lo único de esta ruta que lo usa de verdad;
// `reconcileOrphanTurns` está mockeado entero y no lo toca.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ marker: "admin-fake", rpc: rpcMock }),
}));

// `getRedis()` real vive detrás de `REDIS_URL` (lib/redis.ts) -- acá alcanza
// con un objeto de juguete cuyo `.set` es el mock hoisted.
vi.mock("@/lib/redis", () => ({
  getRedis: () => ({ set: redisSetMock }),
}));

import { POST } from "./route";
// Sin mockear, a propósito: el describe de purgado (T4) espía sobre esto
// para probar que un fallo de Redis o de la RPC deja rastro en el log en vez
// de tragarse el error en silencio.
import { log } from "@/lib/log";

function sendRequest(headers: Record<string, string> = {}) {
  return new Request("http://crm.example/api/cron/process-queue", {
    method: "POST",
    headers,
  });
}

describe("POST /api/cron/process-queue — el portón que dispara gasto", () => {
  beforeEach(() => {
    // Sin esto, la aserción "no se llamó" de un test cae en falso positivo
    // (o falso negativo) por las llamadas acumuladas de tests anteriores.
    processQueuedTurnsMock.mockClear();
    reconcileOrphanTurnsMock.mockClear();
    redisSetMock.mockClear();
    redisSetMock.mockResolvedValue("OK");
    rpcMock.mockClear();
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "agent_turn_calls_purge") return { data: 12, error: null };
      throw new Error(`Fake Supabase: rpc no soportada: ${fn}`);
    });
  });

  it("sin CRON_SECRET configurado, responde 503 y no toca la cola", async () => {
    const previousSecret = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await POST(sendRequest());

      expect(response.status).toBe(503);
      expect(processQueuedTurnsMock).not.toHaveBeenCalled();
      expect(reconcileOrphanTurnsMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });

  it("con CRON_SECRET vacío (''), responde 503 y no toca la cola", async () => {
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await POST(sendRequest());

      expect(response.status).toBe(503);
      expect(processQueuedTurnsMock).not.toHaveBeenCalled();
      expect(reconcileOrphanTurnsMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });

  it("con secreto configurado pero sin cabecera Authorization, responde 401 y no toca la cola", async () => {
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "secreto-cron";

    try {
      const response = await POST(sendRequest());

      expect(response.status).toBe(401);
      expect(processQueuedTurnsMock).not.toHaveBeenCalled();
      expect(reconcileOrphanTurnsMock).not.toHaveBeenCalled();
    } finally {
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });

  it("token incorrecto de la misma longitud que el secreto responde 401 (ejercita timingSafeEqual)", async () => {
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "secreto-cron"; // 12 caracteres

    try {
      // Misma longitud (12), difiere sólo en una mayúscula: no dispara el
      // atajo por longitud, obliga a comparar carácter a carácter.
      const response = await POST(sendRequest({ authorization: "Bearer secreto-cRon" }));

      expect(response.status).toBe(401);
      expect(processQueuedTurnsMock).not.toHaveBeenCalled();
      expect(reconcileOrphanTurnsMock).not.toHaveBeenCalled();
    } finally {
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });

  it("token incorrecto de longitud distinta responde 401 (el atajo por longitud)", async () => {
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "secreto-cron";

    try {
      const response = await POST(sendRequest({ authorization: "Bearer corto" }));

      expect(response.status).toBe(401);
      expect(processQueuedTurnsMock).not.toHaveBeenCalled();
      expect(reconcileOrphanTurnsMock).not.toHaveBeenCalled();
    } finally {
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });

  it("secreto correcto sin el prefijo 'Bearer ' responde 401", async () => {
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "secreto-cron";

    try {
      const response = await POST(sendRequest({ authorization: "secreto-cron" }));

      expect(response.status).toBe(401);
      expect(processQueuedTurnsMock).not.toHaveBeenCalled();
      expect(reconcileOrphanTurnsMock).not.toHaveBeenCalled();
    } finally {
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });

  it("Authorization: Bearer <secreto> correcto reconcilia, procesa la cola y devuelve los dos resúmenes", async () => {
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "secreto-cron";

    try {
      const response = await POST(sendRequest({ authorization: "Bearer secreto-cron" }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(reconcileOrphanTurnsMock).toHaveBeenCalledTimes(1);
      expect(processQueuedTurnsMock).toHaveBeenCalledTimes(1);
      expect(body).toEqual({
        ok: true,
        reconciled: { revisadas: 5, yaEnCola: 1, bloqueadasPorLock: 1, encoladas: 3 },
        processed: 2,
        failed: 1,
        deferred: 0,
      });
    } finally {
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });

  /**
   * El orden no es casual: reconciliar ANTES de drenar deja que lo que el
   * reconciliador reencola en esta pasada se atienda en esta MISMA llamada
   * (encola con debounce cero). Al revés, lo reconciliado esperaría los
   * cinco minutos hasta el próximo disparo del cron — el retraso que el
   * reconciliador vino a evitar.
   */
  it("reconcilia ANTES de drenar la cola, no al revés", async () => {
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "secreto-cron";
    const orden: string[] = [];
    reconcileOrphanTurnsMock.mockImplementationOnce(async () => {
      orden.push("reconciliar");
      return { revisadas: 0, yaEnCola: 0, bloqueadasPorLock: 0, encoladas: 0 };
    });
    processQueuedTurnsMock.mockImplementationOnce(async () => {
      orden.push("drenar");
      return { processed: 0, failed: 0, deferred: 0 };
    });

    try {
      await POST(sendRequest({ authorization: "Bearer secreto-cron" }));

      expect(orden).toEqual(["reconciliar", "drenar"]);
    } finally {
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });

  /**
   * `startsWith("Bearer ")` es sensible a mayúsculas: un cron mal escrito
   * que mande "bearer ..." (minúscula) no entra, y no queda registro de por
   * qué — el 401 es idéntico al de un token cualquiera. Se documenta acá
   * porque es la clase de trampa que sólo se nota cuando el cron ya lleva
   * días sin procesar nada.
   */
  it("'bearer' en minúsculas (prefijo no reconocido) responde 401", async () => {
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "secreto-cron";

    try {
      const response = await POST(sendRequest({ authorization: "bearer secreto-cron" }));

      expect(response.status).toBe(401);
      expect(processQueuedTurnsMock).not.toHaveBeenCalled();
      expect(reconcileOrphanTurnsMock).not.toHaveBeenCalled();
    } finally {
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });
});

/**
 * T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026): el
 * purgado diario de `agent_turn_calls`. Corre DESPUÉS de reconciliar y
 * drenar, y nunca puede frenar ninguna de las dos cosas -- eso es lo que
 * fijan estos tests, no que el purgado "funcione" (eso lo prueba la RPC en
 * `supabase/tests/telemetria_del_turno.sql`).
 */
describe("POST /api/cron/process-queue — purgado diario de agent_turn_calls (T4)", () => {
  // `beforeEach` NO se hereda entre describes hermanos -- el de arriba solo
  // corre para los `it` del primer describe. Sin este, las llamadas de un
  // test se acumulaban en el siguiente (el bug real que reveló la primera
  // corrida de esta suite: 2 llamadas a la RPC en un test que esperaba 0).
  beforeEach(() => {
    processQueuedTurnsMock.mockClear();
    reconcileOrphanTurnsMock.mockClear();
    redisSetMock.mockClear();
    redisSetMock.mockReset();
    redisSetMock.mockResolvedValue("OK");
    rpcMock.mockClear();
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === "agent_turn_calls_purge") return { data: 12, error: null };
      throw new Error(`Fake Supabase: rpc no soportada: ${fn}`);
    });
  });

  async function withSecret(fn: () => Promise<void>) {
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "secreto-cron";
    try {
      await fn();
    } finally {
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  }

  it("gana el lock del día y llama a la RPC con retain_days: 90", async () => {
    await withSecret(async () => {
      await POST(sendRequest({ authorization: "Bearer secreto-cron" }));

      expect(redisSetMock).toHaveBeenCalledTimes(1);
      const [key, valor, ...resto] = redisSetMock.mock.calls[0];
      expect(key).toMatch(/^telemetria:purga:\d{4}-\d{2}-\d{2}$/);
      expect(valor).toBe("1");
      expect(resto).toEqual(["EX", 86_400, "NX"]);

      expect(rpcMock).toHaveBeenCalledWith("agent_turn_calls_purge", { retain_days: 90 });
    });
  });

  it("corre DESPUÉS de reconciliar y de drenar, no antes ni en paralelo", async () => {
    await withSecret(async () => {
      const orden: string[] = [];
      reconcileOrphanTurnsMock.mockImplementationOnce(async () => {
        orden.push("reconciliar");
        return { revisadas: 0, yaEnCola: 0, bloqueadasPorLock: 0, encoladas: 0 };
      });
      processQueuedTurnsMock.mockImplementationOnce(async () => {
        orden.push("drenar");
        return { processed: 0, failed: 0, deferred: 0 };
      });
      redisSetMock.mockImplementationOnce(async () => {
        orden.push("purgar");
        return "OK";
      });

      await POST(sendRequest({ authorization: "Bearer secreto-cron" }));

      expect(orden).toEqual(["reconciliar", "drenar", "purgar"]);
    });
  });

  it("sin ganar el lock (otra instancia ya purgó hoy), no llama a la RPC — y el resto de la respuesta sigue igual", async () => {
    await withSecret(async () => {
      redisSetMock.mockResolvedValueOnce(null);

      const response = await POST(sendRequest({ authorization: "Bearer secreto-cron" }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(rpcMock).not.toHaveBeenCalled();
      expect(body).toEqual({
        ok: true,
        reconciled: { revisadas: 5, yaEnCola: 1, bloqueadasPorLock: 1, encoladas: 3 },
        processed: 2,
        failed: 1,
        deferred: 0,
      });
    });
  });

  it("si Redis falla (getRedis().set lanza), no frena el cron: responde 200 igual y no llama a la RPC", async () => {
    await withSecret(async () => {
      const warn = vi.spyOn(log, "warn");
      redisSetMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const response = await POST(sendRequest({ authorization: "Bearer secreto-cron" }));

      expect(response.status).toBe(200);
      expect(rpcMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("telemetria_purga_lock_no_disponible", { detail: "ECONNREFUSED" });
    });
  });

  it("si la RPC de purgado falla, no frena el cron: responde 200 igual con log.warn telemetria_purga_fallida", async () => {
    await withSecret(async () => {
      const warn = vi.spyOn(log, "warn");
      rpcMock.mockImplementationOnce(async () => ({ data: null, error: { message: "permiso denegado" } }));

      const response = await POST(sendRequest({ authorization: "Bearer secreto-cron" }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(warn).toHaveBeenCalledWith("telemetria_purga_fallida", { detail: "permiso denegado" });
    });
  });

  it("purga de verdad: deja telemetria_purgada con las filas que devolvió la RPC", async () => {
    await withSecret(async () => {
      const info = vi.spyOn(log, "info");
      rpcMock.mockImplementationOnce(async () => ({ data: 37, error: null }));

      await POST(sendRequest({ authorization: "Bearer secreto-cron" }));

      expect(info).toHaveBeenCalledWith("telemetria_purgada", { filas: 37 });
    });
  });
});
