import { beforeEach, describe, expect, it, vi } from "vitest";

// La salud del CRM se mide contra sus dependencias reales; acá se sustituyen
// para poder simular que alguna está caída.
const pingMock = vi.fn(async () => "PONG");
vi.mock("@/lib/redis", () => ({ getRedis: () => ({ ping: pingMock }) }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { id: true }, error: null }) }),
      }),
    }),
  }),
}));

import { GET } from "@/app/api/health/route";

const ENV_REQUERIDO = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:8000",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  REDIS_URL: "redis://127.0.0.1:6379",
};

beforeEach(() => {
  pingMock.mockReset();
  pingMock.mockResolvedValue("PONG");
  for (const [clave, valor] of Object.entries(ENV_REQUERIDO)) {
    vi.stubEnv(clave, valor);
  }
});

describe("GET /api/health", () => {
  it("responde ok cuando la base y la cola contestan", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe("ok");
    expect(body.checks.queue).toBe("ok");
  });

  /**
   * Sin Redis el agente no atiende a nadie, aunque el proceso levante y las
   * pantallas carguen. Declararse sano en ese estado hace que el orquestador
   * mande tráfico a un CRM que no puede responder.
   */
  it("se declara degradado si la cola no responde", async () => {
    pingMock.mockRejectedValue(new Error("sin conexión"));

    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe("degraded");
    expect(body.checks.queue).not.toBe("ok");
  });

  it("avisa por nombre cuándo falta la variable de la cola", async () => {
    vi.stubEnv("REDIS_URL", "");

    const response = await GET();
    const body = await response.json();

    expect(body.status).toBe("degraded");
    expect(JSON.stringify(body)).toContain("REDIS_URL");
  });
});
