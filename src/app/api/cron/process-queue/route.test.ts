import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Portón del cron que procesa la cola de turnos de IA: cada llamada exitosa
 * dispara gasto real (turnos de IA). Estos tests fijan el comportamiento
 * actual de la guarda — sobre todo los casos en los que `processQueuedTurns`
 * NO debe llamarse, porque ahí es donde una regresión saldría cara.
 */

// `vi.hoisted` porque `vi.mock` se eleva sobre cualquier `const` normal: sin
// esto, la fábrica ve `processQueuedTurnsMock` antes de que exista (TDZ).
const { processQueuedTurnsMock, reconcileOrphanTurnsMock } = vi.hoisted(() => ({
  processQueuedTurnsMock: vi.fn(async () => ({ processed: 2, failed: 1, deferred: 0 })),
  reconcileOrphanTurnsMock: vi.fn(async () => ({
    revisadas: 5,
    yaEnCola: 1,
    bloqueadasPorLock: 1,
    encoladas: 3,
  })),
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

// Cliente de juguete: alcanza con que exista, porque a quien se le pasa
// -reconcileOrphanTurns- está mockeado entero y no lo va a usar de verdad.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ marker: "admin-fake" }),
}));

import { POST } from "./route";

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
