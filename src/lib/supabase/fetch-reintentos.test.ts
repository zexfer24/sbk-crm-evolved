import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `fetchConReintentos`: el `fetch` que envuelve `createAdminClient()` (T1,
 * plan "Nada se pierde en un corte ni en un deploy", 21-22/9/2026). No
 * decide QUÉ es transitorio (eso es `errores-base.ts`, ya probado aparte) —
 * decide cuándo reintentar de verdad: leer el cuerpo sin consumirlo,
 * esperar, reintentar, respetar el `signal`, y loguear.
 */

const logCalls: Array<{ level: "warn" | "error"; event: string; context?: Record<string, unknown> }> = [];

vi.mock("@/lib/log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log")>();
  return {
    ...actual,
    log: {
      info: vi.fn(),
      warn: (event: string, context?: Record<string, unknown>) => {
        logCalls.push({ level: "warn", event, context });
      },
      error: (event: string, context?: Record<string, unknown>) => {
        logCalls.push({ level: "error", event, context });
      },
    },
  };
});

import { fetchConReintentos } from "./fetch-reintentos";

beforeEach(() => {
  logCalls.length = 0;
});

/** Espera falsa: no tarda nada, solo registra cuánto le pidieron dormir. */
function dormirFalso() {
  const esperas: number[] = [];
  return {
    esperas,
    dormir: async (ms: number) => {
      esperas.push(ms);
    },
  };
}

function respuestaEnvoy(status: number, patron = "disconnect/reset before headers"): Response {
  return new Response(JSON.stringify({ message: patron }), { status });
}

function respuestaOk(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

describe("fetchConReintentos", () => {
  it("con éxito al primer intento no reintenta ni loguea nada", async () => {
    const { dormir } = dormirFalso();
    const base = vi.fn(async () => respuestaOk());
    const envuelto = fetchConReintentos(base, { intentos: 2, esperasMs: [300, 1000], dormir });

    const respuesta = await envuelto("https://x/rest/v1/algo", { method: "GET" });

    expect(respuesta.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(1);
    expect(logCalls).toHaveLength(0);
  });

  it("GET con ECONNRESET reintenta y en el segundo intento tiene éxito", async () => {
    const { dormir, esperas } = dormirFalso();
    let llamada = 0;
    const base = vi.fn(async () => {
      llamada++;
      if (llamada === 1) {
        const err = new TypeError("fetch failed");
        (err as unknown as { cause: unknown }).cause = { code: "ECONNRESET" };
        throw err;
      }
      return respuestaOk();
    });
    const envuelto = fetchConReintentos(base, { intentos: 2, esperasMs: [300, 1000], dormir });

    const respuesta = await envuelto("https://x/rest/v1/algo", { method: "GET" });

    expect(respuesta.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    expect(esperas).toEqual([300]);
    expect(logCalls).toContainEqual(
      expect.objectContaining({ level: "warn", event: "base_reintento" })
    );
  });

  it("POST con ECONNRESET NO reintenta: relanza el error en el primer intento", async () => {
    const { dormir } = dormirFalso();
    const err = new TypeError("fetch failed");
    (err as unknown as { cause: unknown }).cause = { code: "ECONNRESET" };
    const base = vi.fn(async () => {
      throw err;
    });
    const envuelto = fetchConReintentos(base, { intentos: 2, esperasMs: [300, 1000], dormir });

    await expect(envuelto("https://x/rest/v1/algo", { method: "POST" })).rejects.toBe(err);

    expect(base).toHaveBeenCalledTimes(1);
    expect(logCalls).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "base_agotada",
        context: expect.objectContaining({ metodo: "POST", reintentado: false }),
      })
    );
  });

  it("POST con el cuerpo Envoy 'before headers' SÍ reintenta y tiene éxito", async () => {
    const { dormir, esperas } = dormirFalso();
    let llamada = 0;
    const base = vi.fn(async () => {
      llamada++;
      if (llamada === 1) return respuestaEnvoy(503, "disconnect/reset before headers");
      return respuestaOk();
    });
    const envuelto = fetchConReintentos(base, { intentos: 2, esperasMs: [300, 1000], dormir });

    const respuesta = await envuelto("https://x/rest/v1/algo", { method: "POST" });

    expect(respuesta.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
    expect(esperas).toEqual([300]);
  });

  it("agota los reintentos configurados y devuelve la última respuesta, logueando base_agotada con reintentado=true", async () => {
    const { dormir, esperas } = dormirFalso();
    const base = vi.fn(async () => respuestaEnvoy(503, "upstream connect error"));
    const envuelto = fetchConReintentos(base, { intentos: 2, esperasMs: [300, 1000], dormir });

    const respuesta = await envuelto("https://x/rest/v1/algo", { method: "GET" });

    expect(respuesta.status).toBe(503);
    // 1 intento inicial + 2 reintentos configurados = 3 llamadas en total.
    expect(base).toHaveBeenCalledTimes(3);
    expect(esperas).toEqual([300, 1000]);
    expect(logCalls).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "base_agotada",
        context: expect.objectContaining({ metodo: "GET", reintentado: true }),
      })
    );
  });

  it("una respuesta 500 normal (no transitoria) se devuelve tal cual, sin reintentar ni loguear", async () => {
    const { dormir } = dormirFalso();
    const base = vi.fn(async () => new Response("boom", { status: 500 }));
    const envuelto = fetchConReintentos(base, { intentos: 2, esperasMs: [300, 1000], dormir });

    const respuesta = await envuelto("https://x/rest/v1/algo", { method: "POST" });

    expect(respuesta.status).toBe(500);
    expect(base).toHaveBeenCalledTimes(1);
    expect(logCalls).toHaveLength(0);
  });

  it("un error no transitorio se relanza tal cual, sin loguear", async () => {
    const { dormir } = dormirFalso();
    const err = new Error("algo raro");
    const base = vi.fn(async () => {
      throw err;
    });
    const envuelto = fetchConReintentos(base, { intentos: 2, esperasMs: [300, 1000], dormir });

    await expect(envuelto("https://x/rest/v1/algo", { method: "GET" })).rejects.toBe(err);
    expect(base).toHaveBeenCalledTimes(1);
    expect(logCalls).toHaveLength(0);
  });

  it("respeta el signal: si ya está abortado, no reintenta un fallo transitorio", async () => {
    const { dormir } = dormirFalso();
    const controlador = new AbortController();
    controlador.abort();
    const err = new TypeError("fetch failed");
    (err as unknown as { cause: unknown }).cause = { code: "ECONNRESET" };
    const base = vi.fn(async () => {
      throw err;
    });
    const envuelto = fetchConReintentos(base, { intentos: 2, esperasMs: [300, 1000], dormir });

    await expect(
      envuelto("https://x/rest/v1/algo", { method: "GET", signal: controlador.signal })
    ).rejects.toBe(err);

    expect(base).toHaveBeenCalledTimes(1);
  });

  it("no consume el cuerpo de la respuesta: el llamador todavía puede leerlo tras el reintento", async () => {
    const { dormir } = dormirFalso();
    let llamada = 0;
    const base = vi.fn(async () => {
      llamada++;
      if (llamada === 1) return respuestaEnvoy(503, "upstream connect error");
      return new Response(JSON.stringify({ dato: "importante" }), { status: 200 });
    });
    const envuelto = fetchConReintentos(base, { intentos: 2, esperasMs: [300, 1000], dormir });

    const respuesta = await envuelto("https://x/rest/v1/algo", { method: "GET" });
    const cuerpo = await respuesta.json();

    expect(cuerpo).toEqual({ dato: "importante" });
  });

  it("el método viaja desde un Request cuando input es un Request en vez de init.method", async () => {
    const { dormir } = dormirFalso();
    const err = new TypeError("fetch failed");
    (err as unknown as { cause: unknown }).cause = { code: "ECONNRESET" };
    const base = vi.fn(async () => {
      throw err;
    });
    const envuelto = fetchConReintentos(base, { intentos: 2, esperasMs: [300, 1000], dormir });

    // Un Request POST con ECONNRESET no debería reintentarse (ambiguo),
    // igual que si el método viniera por init.method.
    const req = new Request("https://x/rest/v1/algo", { method: "POST" });
    await expect(envuelto(req)).rejects.toBe(err);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("sin método explícito asume GET (default de fetch)", async () => {
    const { dormir, esperas } = dormirFalso();
    let llamada = 0;
    const base = vi.fn(async () => {
      llamada++;
      if (llamada === 1) {
        const err = new TypeError("fetch failed");
        (err as unknown as { cause: unknown }).cause = { code: "ECONNRESET" };
        throw err;
      }
      return respuestaOk();
    });
    const envuelto = fetchConReintentos(base, { intentos: 2, esperasMs: [300, 1000], dormir });

    const respuesta = await envuelto("https://x/rest/v1/algo");

    expect(respuesta.status).toBe(200);
    expect(esperas).toEqual([300]);
  });

  it("usa las esperas por defecto cuando no se pasan opciones", async () => {
    let llamada = 0;
    const base = vi.fn(async () => {
      llamada++;
      if (llamada === 1) {
        const err = new TypeError("fetch failed");
        (err as unknown as { cause: unknown }).cause = { code: "ECONNRESET" };
        throw err;
      }
      return respuestaOk();
    });
    // Sin `dormir` inyectado usa el real — usamos fake timers para no
    // esperar de verdad los 300ms por defecto.
    vi.useFakeTimers();
    try {
      const envuelto = fetchConReintentos(base);
      const promesa = envuelto("https://x/rest/v1/algo", { method: "GET" });
      await vi.runAllTimersAsync();
      const respuesta = await promesa;
      expect(respuesta.status).toBe(200);
      expect(base).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
