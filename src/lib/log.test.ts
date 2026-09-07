import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";
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

  /**
   * Bug medido en producción el 7/9/2026: `turno_lock_no_liberado` y
   * `webhook_error_actualizar_estado` salían con `detail: "[object Object]"`
   * porque `err instanceof Error ? err.message : String(err)` no reconocía
   * un `PostgrestError` real (ver cabecera de `log.ts`). Este es el caso que
   * probaba que `errorText` seguía roto pese a que los llamadores ya lo
   * usaban.
   */
  it("arma código y mensaje de un PostgrestError real de supabase-js", () => {
    const err = new PostgrestError({
      message: "permission denied for table conversations",
      details: "",
      hint: "",
      code: "42501",
    });

    const texto = errorText(err);

    expect(texto).toBe("42501: permission denied for table conversations");
    expect(texto).not.toContain("[object Object]");
  });

  it("usa solo el mensaje cuando el objeto no trae código", () => {
    expect(errorText({ message: "algo falló" })).toBe("algo falló");
  });

  it("convierte undefined y null a su nombre literal", () => {
    expect(errorText(undefined)).toBe("undefined");
    expect(errorText(null)).toBe("null");
  });

  it("cae a JSON acotado cuando el objeto no tiene mensaje", () => {
    const texto = errorText({ status: 500 });

    expect(texto).toContain("status");
    expect(texto).toContain("500");
  });

  it("no lanza con un objeto circular y devuelve un string no vacío", () => {
    const circular: Record<string, unknown> = { nombre: "raro" };
    circular.self = circular;

    let texto = "";
    expect(() => {
      texto = errorText(circular);
    }).not.toThrow();
    expect(texto.length).toBeGreaterThan(0);
  });

  it("acota a 301 caracteres un objeto sin mensaje gigante", () => {
    const gigante: Record<string, string> = {};
    for (let i = 0; i < 100; i++) gigante[`campo${i}`] = "x".repeat(20);

    expect(errorText(gigante).length).toBeLessThanOrEqual(301);
  });
});
