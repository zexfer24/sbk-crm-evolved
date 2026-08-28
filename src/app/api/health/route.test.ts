import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La salud del CRM se mide contra sus dependencias reales; acá se sustituyen
// para poder simular que alguna está caída.
const pingMock = vi.fn(async () => "PONG");
vi.mock("@/lib/redis", () => ({ getRedis: () => ({ ping: pingMock }) }));

// Mismo patrón que pingMock: mock mutable para poder simular que la base
// también se cae, no solo la cola.
const adminSingleMock = vi.fn(async (): Promise<{
  data: { id: boolean } | null;
  error: { message: string } | null;
}> => ({ data: { id: true }, error: null }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ single: adminSingleMock }),
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
  adminSingleMock.mockReset();
  adminSingleMock.mockResolvedValue({ data: { id: true }, error: null });
  for (const [clave, valor] of Object.entries(ENV_REQUERIDO)) {
    vi.stubEnv(clave, valor);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("responde ok cuando la base y la cola contestan", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
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

    expect(response.status).toBe(503);
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

  /**
   * El monitor externo y el HEALTHCHECK del contenedor deciden por el código
   * HTTP, no por el cuerpo. Si la base no responde, el endpoint tiene que
   * devolver 503 aunque el resto de las dependencias esté sana.
   */
  it("se declara degradado con 503 si la base no responde", async () => {
    adminSingleMock.mockResolvedValue({ data: null, error: { message: "consulta rechazada" } });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.database).not.toBe("ok");
  });

  it("se declara degradado en producción si falta el secreto de WhatsApp", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(JSON.stringify(body)).toContain("WHATSAPP_APP_SECRET");
  });
});
