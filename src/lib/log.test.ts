import { afterEach, describe, expect, it, vi } from "vitest";
import { errorText, log } from "@/lib/log";

function captureStderr(fn: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  fn();
  const line = spy.mock.calls[0][0] as string;
  spy.mockRestore();
  return JSON.parse(line);
}

afterEach(() => vi.restoreAllMocks());

describe("log", () => {
  it("emite una línea JSON con nivel, evento y marca de tiempo", () => {
    const entry = captureStderr(() => log.error("turno_fallido", { conversationId: "conv-1" }));

    expect(entry.level).toBe("error");
    expect(entry.event).toBe("turno_fallido");
    expect(entry.conversationId).toBe("conv-1");
    expect(typeof entry.ts).toBe("string");
  });

  /**
   * Los registros salen del sistema y suelen guardarse más tiempo que los
   * datos que describen: un token filtrado ahí sigue sirviendo meses después.
   */
  it("oculta el valor de las claves sensibles", () => {
    const entry = captureStderr(() =>
      log.error("prueba", {
        accessToken: "EAAG-secreto",
        WHATSAPP_APP_SECRET: "no-mirar",
        apiKey: "sk-123",
        conversationId: "conv-1",
      })
    );

    expect(entry.accessToken).toBe("[oculto]");
    expect(entry.WHATSAPP_APP_SECRET).toBe("[oculto]");
    expect(entry.apiKey).toBe("[oculto]");
    // Lo que no es sensible sigue siendo legible, que es el punto de registrar.
    expect(entry.conversationId).toBe("conv-1");
  });

  it("oculta también datos personales del cliente", () => {
    const entry = captureStderr(() => log.error("prueba", { cedulaNumber: "12345678", phoneNumber: "+58412" }));

    expect(entry.cedulaNumber).toBe("[oculto]");
    expect(entry.phoneNumber).toBe("[oculto]");
  });

  it("manda info a stdout y los fallos a stderr, para separarlos sin leer el nivel", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    log.info("arranque");
    expect(out).toHaveBeenCalledTimes(1);
    expect(err).not.toHaveBeenCalled();

    log.warn("algo raro");
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe("errorText", () => {
  it("saca el mensaje de un Error", () => {
    expect(errorText(new Error("se cayó"))).toBe("se cayó");
  });

  it("convierte lo que no es un Error", () => {
    expect(errorText("texto suelto")).toBe("texto suelto");
    expect(errorText(404)).toBe("404");
  });
});
