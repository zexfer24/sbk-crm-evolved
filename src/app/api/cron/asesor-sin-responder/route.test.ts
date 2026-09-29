import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Portón del cron de demora del asesor (T10b-4, 29/9/2026): cada llamada
 * autorizada puede disparar una respuesta de Seba (gasto de IA) o mover una
 * conversación de asesor, así que lo que más importa fijar es cuándo NO se
 * llama a `procesarDemoras`. Fábricas completas, sin `importOriginal`: el
 * módulo real arrastra el agente de IA, sus SDKs y Redis, y nada de eso hace
 * falta para probar el portón (ni `@/lib/ai/agent` ni `@/lib/redis` se cargan).
 */

const { procesarDemorasMock } = vi.hoisted(() => ({
  procesarDemorasMock: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(async () => ({
    activa: true,
    candidatas: 4,
    intentos: 2,
    responder: 1,
    reasignar: 1,
    avisar_supervisor: 0,
    sinCandidato: 0,
    yaReclamadas: 0,
    errores: 0,
  })),
}));

vi.mock("@/lib/ai/demora-cron", () => ({
  procesarDemoras: procesarDemorasMock,
  MAX_ACCIONES_POR_PASADA: 5,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ marker: "admin-fake" }),
}));

let POST: (request: Request) => Promise<Response>;

beforeAll(async () => {
  ({ POST } = await import("./route"));
});

function pedido(headers: Record<string, string> = {}) {
  return new Request("http://crm.example/api/cron/asesor-sin-responder", { method: "POST", headers });
}

describe("POST /api/cron/asesor-sin-responder", () => {
  const secretoPrevio = process.env.CRON_SECRET;

  beforeEach(() => {
    procesarDemorasMock.mockClear();
    process.env.CRON_SECRET = "secreto-cron";
  });

  afterEach(() => {
    if (secretoPrevio === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = secretoPrevio;
    vi.restoreAllMocks();
  });

  it("sin CRON_SECRET configurado responde 503 y no procesa nada (falla cerrado)", async () => {
    delete process.env.CRON_SECRET;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(pedido({ authorization: "Bearer lo-que-sea" }));

    expect(response.status).toBe(503);
    expect(procesarDemorasMock).not.toHaveBeenCalled();
  });

  it("con CRON_SECRET vacío responde 503", async () => {
    process.env.CRON_SECRET = "";
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(pedido({ authorization: "Bearer " }));

    expect(response.status).toBe(503);
    expect(procesarDemorasMock).not.toHaveBeenCalled();
  });

  it("sin cabecera Authorization responde 401", async () => {
    const response = await POST(pedido());

    expect(response.status).toBe(401);
    expect(procesarDemorasMock).not.toHaveBeenCalled();
  });

  it("secreto incorrecto de la MISMA longitud responde 401 (ejercita timingSafeEqual)", async () => {
    const response = await POST(pedido({ authorization: "Bearer secreto-cRon" }));

    expect(response.status).toBe(401);
    expect(procesarDemorasMock).not.toHaveBeenCalled();
  });

  it("secreto incorrecto de longitud distinta responde 401", async () => {
    const response = await POST(pedido({ authorization: "Bearer corto" }));

    expect(response.status).toBe(401);
    expect(procesarDemorasMock).not.toHaveBeenCalled();
  });

  it("el secreto correcto sin 'Bearer ' responde 401", async () => {
    const response = await POST(pedido({ authorization: "secreto-cron" }));

    expect(response.status).toBe(401);
    expect(procesarDemorasMock).not.toHaveBeenCalled();
  });

  it("con el secreto correcto procesa con máximo 5 conversaciones y devuelve el resumen", async () => {
    const response = await POST(pedido({ authorization: "Bearer secreto-cron" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(procesarDemorasMock).toHaveBeenCalledTimes(1);
    const [cliente, opciones] = procesarDemorasMock.mock.calls[0] as [unknown, { max: number; now: Date }];
    expect(cliente).toEqual({ marker: "admin-fake" });
    expect(opciones.max).toBe(5);
    expect(opciones.now).toBeInstanceOf(Date);
    expect(body).toEqual({
      ok: true,
      activa: true,
      candidatas: 4,
      intentos: 2,
      responder: 1,
      reasignar: 1,
      avisar_supervisor: 0,
      sinCandidato: 0,
      yaReclamadas: 0,
      errores: 0,
    });
  });

  it("si la pasada lanza, responde 500 con un mensaje genérico y no filtra el error", async () => {
    procesarDemorasMock.mockRejectedValueOnce(new Error("secreto: postgres://usuario:clave@host"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(pedido({ authorization: "Bearer secreto-cron" }));
    const texto = await response.text();

    expect(response.status).toBe(500);
    expect(texto).not.toContain("postgres://");
  });
});
