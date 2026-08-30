import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La salud del CRM se mide contra sus dependencias reales; acá se sustituyen
// para poder simular que alguna está caída.
const pingMock = vi.fn(async () => "PONG");
// CONFIG GET appendonly: RESP2 devuelve pares [clave, valor]. "yes" imita el
// local, que ya se verificó que responde así (ver T1.7 en el plan).
const configMock = vi.fn(async (): Promise<string[]> => ["appendonly", "yes"]);
vi.mock("@/lib/redis", () => ({ getRedis: () => ({ ping: pingMock, config: configMock }) }));

// Mismo patrón que pingMock: mock mutable para poder simular que la base
// también se cae, no solo la cola.
const adminSingleMock = vi.fn(async (): Promise<{
  data: { id: boolean } | null;
  error: { message: string } | null;
}> => ({ data: { id: true }, error: null }));

// El conteo de unassigned_waiting usa una forma de consulta distinta a la del
// chequeo de base (select con { count, head } en vez de single()), así que el
// El conteo de leads sin dueño lo resuelve la RPC `unassigned_waiting_count`
// y no una consulta armada en el route: la pregunta correcta —"cuya ÚLTIMA
// fila de bitácora los dejó sin dueño"— PostgREST no la sabe expresar, y la
// aproximación que sí sabe ("tiene al menos una fila unassigned") cuenta
// como perdidas las conversaciones que el reconciliador ya rescató.
const conversationsCountMock = vi.fn(async (): Promise<{
  data: number | null;
  error: { message: string } | null;
}> => ({ data: 0, error: null }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (fn: string) => {
      if (fn === "unassigned_waiting_count") return conversationsCountMock();
      throw new Error(`Fake Supabase: rpc no soportada: ${fn}`);
    },
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
  configMock.mockReset();
  configMock.mockResolvedValue(["appendonly", "yes"]);
  adminSingleMock.mockReset();
  adminSingleMock.mockResolvedValue({ data: { id: true }, error: null });
  conversationsCountMock.mockReset();
  conversationsCountMock.mockResolvedValue({ data: 0, error: null });
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
   * T1.7: los dos datos nuevos son informativos, no chequeos de salud, pero
   * el caso sano tiene que exponerlos igual — es la prueba de que llegaron al
   * cuerpo de la respuesta.
   */
  it("expone unassigned_waiting y redis_persistence cuando todo responde", async () => {
    conversationsCountMock.mockResolvedValue({ data: 3, error: null });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.unassigned_waiting).toBe(3);
    expect(body.redis_persistence).toBe("yes");
  });

  /**
   * Un lead esperando sin dueño es exactamente lo que este número existe para
   * avisar; que la CONSULTA falle es otra cosa —un problema de la base, no de
   * negocio— y no puede tumbar un endpoint que hasta ahora respondía bien.
   */
  it("si falla el conteo de unassigned_waiting, el endpoint sigue en 200 y el campo lo dice", async () => {
    conversationsCountMock.mockResolvedValue({
      data: null,
      error: { message: "consulta rechazada" },
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.unassigned_waiting).toBe("string");
    expect(body.unassigned_waiting).toContain("fallo");
  });

  /**
   * Igual que el conteo: que Redis no sepa responder CONFIG GET no es una
   * caída de la cola (ping ya contestó), así que no puede degradar el código
   * HTTP.
   */
  it("si CONFIG GET falla, el endpoint sigue en 200 y redis_persistence lo dice", async () => {
    configMock.mockRejectedValue(new Error("sin conexión"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.redis_persistence).toBe("string");
    expect(body.redis_persistence).toContain("fallo");
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
