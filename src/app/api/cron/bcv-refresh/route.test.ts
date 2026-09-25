import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Portón del cron que fuerza la relectura de la tasa BCV cada minuto. La
 * ruta decide si de verdad toca leer (shouldRefetchBcv, horarios 00/06/12/18
 * VE) — el shell del compose solo dispara el POST, nunca calcula horas
 * (alpine sin tzdata). Mismo patrón de guarda que process-queue/route.test.ts:
 * fábricas completas, sin `importOriginal`, porque `@/lib/ai/bcv` real
 * arrastra `bcv-fetch.ts` (la cadena TLS intermedia del BCV) y
 * `@/lib/supabase/admin` arrastra el cliente real de supabase-js.
 */

const { getBcvRateMock, createAdminClientMock } = vi.hoisted(() => ({
  getBcvRateMock: vi.fn(async () => ({
    rate: 855.6625,
    rateDate: "2026-09-25",
    isStale: false,
    refreshed: true,
  })),
  createAdminClientMock: vi.fn(() => ({ marker: "admin-fake" })),
}));

vi.mock("@/lib/ai/bcv", () => ({
  getBcvRate: getBcvRateMock,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: createAdminClientMock,
}));

import { POST } from "./route";

function sendRequest(headers: Record<string, string> = {}) {
  return new Request("http://crm.example/api/cron/bcv-refresh", {
    method: "POST",
    headers,
  });
}

describe("POST /api/cron/bcv-refresh — el portón que fuerza la relectura del BCV", () => {
  beforeEach(() => {
    getBcvRateMock.mockClear();
    createAdminClientMock.mockClear();
    getBcvRateMock.mockResolvedValue({
      rate: 855.6625,
      rateDate: "2026-09-25",
      isStale: false,
      refreshed: true,
    });
  });

  it("sin CRON_SECRET configurado, responde 503 y no llama a getBcvRate", async () => {
    const previousSecret = process.env.CRON_SECRET;
    vi.stubEnv("CRON_SECRET", "");
    delete process.env.CRON_SECRET;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await POST(sendRequest());

      expect(response.status).toBe(503);
      expect(getBcvRateMock).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      vi.unstubAllEnvs();
      if (previousSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousSecret;
    }
  });

  it("sin cabecera Authorization, responde 401 y no llama a getBcvRate", async () => {
    vi.stubEnv("CRON_SECRET", "secreto-cron");

    try {
      const response = await POST(sendRequest());

      expect(response.status).toBe(401);
      expect(getBcvRateMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("token incorrecto responde 401 y no llama a getBcvRate", async () => {
    vi.stubEnv("CRON_SECRET", "secreto-cron");

    try {
      const response = await POST(sendRequest({ authorization: "Bearer otro-secreto" }));

      expect(response.status).toBe(401);
      expect(getBcvRateMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("Authorization: Bearer <secreto> correcto responde 200 con rate/rateDate/isStale/refreshed", async () => {
    vi.stubEnv("CRON_SECRET", "secreto-cron");

    try {
      const response = await POST(sendRequest({ authorization: "Bearer secreto-cron" }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        rate: 855.6625,
        rateDate: "2026-09-25",
        isStale: false,
        refreshed: true,
      });
      expect(createAdminClientMock).toHaveBeenCalledTimes(1);
      expect(getBcvRateMock).toHaveBeenCalledTimes(1);
      expect(getBcvRateMock).toHaveBeenCalledWith(
        { marker: "admin-fake" },
        { ignoreFailureBackoff: true }
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("si getBcvRate lanza (sin ninguna tasa guardada), responde 503", async () => {
    vi.stubEnv("CRON_SECRET", "secreto-cron");
    getBcvRateMock.mockRejectedValueOnce(new Error("No hay ninguna tasa BCV guardada."));

    try {
      const response = await POST(sendRequest({ authorization: "Bearer secreto-cron" }));

      expect(response.status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
