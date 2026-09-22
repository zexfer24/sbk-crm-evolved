import { describe, expect, it } from "vitest";
import { esFalloTransitorioDeBase, esReintentoSeguro, type RespuestaDeBase } from "./errores-base";

/**
 * Clasificador puro de fallos contra la base (T1, plan "Nada se pierde en un
 * corte ni en un deploy", 21-22/9/2026). Sin red, sin mocks: es lógica pura
 * sobre objetos de error y respuestas HTTP ya leídas.
 */

// Formas de error tal como las lanza undici (el `fetch` nativo de Node) o
// como llegan directo con `.code` (errores clásicos de `net`).
function errorDeRed(code: string): Error {
  const err = new TypeError("fetch failed");
  (err as unknown as { cause: unknown }).cause = { code };
  return err;
}

function errorDeRedDirecto(code: string): Error & { code: string } {
  const err = new Error(`conexión: ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

function postgrestError(code: string, message = "algo falló"): { code: string; message: string } {
  return { code, message };
}

function respuestaEnvoy(status: number, patron: string): RespuestaDeBase {
  return { status, cuerpo: `{"message":"${patron}"}` };
}

describe("esFalloTransitorioDeBase", () => {
  describe("familias positivas", () => {
    it.each(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT"])(
      "TypeError fetch failed con cause.code = %s",
      (code) => {
        expect(esFalloTransitorioDeBase(errorDeRed(code))).toBe(true);
      }
    );

    it.each(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT"])(
      "error con .code directo = %s (forma clásica de Node, sin TypeError envolvente)",
      (code) => {
        expect(esFalloTransitorioDeBase(errorDeRedDirecto(code))).toBe(true);
      }
    );

    it("TypeError 'fetch failed' sin cause.code reconocible sigue siendo transitorio (ambiguo pero es un corte de red)", () => {
      const err = new TypeError("fetch failed");
      expect(esFalloTransitorioDeBase(err)).toBe(true);
    });

    it.each([
      "upstream connect error",
      "disconnect/reset before headers",
      "connection termination",
    ])("respuesta 503 cuyo cuerpo calza el patrón Envoy: %s", (patron) => {
      expect(esFalloTransitorioDeBase(respuestaEnvoy(503, patron))).toBe(true);
    });

    it.each([502, 503, 504])("respuesta %s sin el cuerpo de Envoy (p. ej. PostgREST con PGRST00x) igual cuenta como transitoria", (status) => {
      expect(
        esFalloTransitorioDeBase({ status, cuerpo: '{"code":"PGRST003","message":"sin conexión a la base"}' })
      ).toBe(true);
    });

    it.each(["08006", "08001", "08P01"])("PostgrestError con code de clase 08 (connection exception): %s", (code) => {
      expect(esFalloTransitorioDeBase(postgrestError(code))).toBe(true);
    });

    it.each(["53300", "53400"])("PostgrestError con code de clase 53 (recursos): %s", (code) => {
      expect(esFalloTransitorioDeBase(postgrestError(code))).toBe(true);
    });

    it.each(["57P01", "57P02", "57P03"])("PostgrestError con code de clase 57P (shutdown): %s", (code) => {
      expect(esFalloTransitorioDeBase(postgrestError(code))).toBe(true);
    });

    it.each(["PGRST002", "PGRST003"])("PostgrestError con code PGRST00x (PostgREST sin base): %s", (code) => {
      expect(esFalloTransitorioDeBase(postgrestError(code))).toBe(true);
    });
  });

  describe("negativos: nada de esto se reintenta nunca", () => {
    it("23505 (violación de unicidad) no es transitorio", () => {
      expect(esFalloTransitorioDeBase(postgrestError("23505", "duplicate key value"))).toBe(false);
    });

    it("42501 (RLS) no es transitorio", () => {
      expect(esFalloTransitorioDeBase(postgrestError("42501", "permission denied"))).toBe(false);
    });

    it("PGRST301 (JWT expirado) no es transitorio: no empieza con PGRST00", () => {
      expect(esFalloTransitorioDeBase(postgrestError("PGRST301", "JWT expired"))).toBe(false);
    });

    it("una respuesta 400 no es transitoria", () => {
      expect(esFalloTransitorioDeBase({ status: 400, cuerpo: "bad request" })).toBe(false);
    });

    it("una respuesta 500 (no está en la lista 502/503/504) no es transitoria", () => {
      expect(esFalloTransitorioDeBase({ status: 500, cuerpo: "internal error" })).toBe(false);
    });

    it("una respuesta 200 no es transitoria", () => {
      expect(esFalloTransitorioDeBase({ status: 200, cuerpo: "" })).toBe(false);
    });

    it("un error sin code ni forma de TypeError('fetch failed') no es transitorio", () => {
      expect(esFalloTransitorioDeBase(new Error("algo inesperado"))).toBe(false);
    });

    it("undefined, null y un string suelto no son transitorios", () => {
      expect(esFalloTransitorioDeBase(undefined)).toBe(false);
      expect(esFalloTransitorioDeBase(null)).toBe(false);
      expect(esFalloTransitorioDeBase("algo")).toBe(false);
    });
  });
});

// Corrección hallada en la verificación a mano del orquestador (22/9/2026):
// con PostgREST parado en local, el webhook dejó `webhook_canal_no_consultable`
// con `detail: "name resolution failed"` pero respondió 200, no 503 —
// `esFalloTransitorioDeBase` daba `false`. Causa: cuando el proxy (Envoy en
// producción, Kong en local) devuelve un 502/503/504 cuyo cuerpo NO es el JSON
// de un `PostgrestError` real, `PostgrestBuilder.processResponse` (node_modules/
// @supabase/postgrest-js/src/PostgrestBuilder.ts:544-567) arma el objeto de
// error con el texto del cuerpo como `message` y SIN `code` (si el cuerpo no
// parsea como JSON, `catch` deja `error = { message: body }`, sin ninguna
// clave `code`; si el cuerpo SÍ es JSON pero solo trae `{"message": "..."}`,
// como el de Kong, `error = JSON.parse(body)` tampoco trae `code`). Del lado
// del llamador (el webhook, que solo ve `error`) los cortes de verdad llegan
// con `code` vacío o ausente y el texto del proxy en `message`; clasificar
// solo por `code` los deja afuera.
describe("esFalloTransitorioDeBase por message (sin code útil, forma real de postgrest-js)", () => {
  describe("Envoy (producción)", () => {
    it.each([
      "upstream connect error or disconnect/reset before headers. reset reason: connection termination",
      "connection termination",
    ])("con code vacío: %s", (message) => {
      expect(esFalloTransitorioDeBase({ code: "", message })).toBe(true);
    });

    it("sin ninguna clave code", () => {
      expect(
        esFalloTransitorioDeBase({
          message:
            "upstream connect error or disconnect/reset before headers. reset reason: connection termination",
        })
      ).toBe(true);
    });
  });

  describe("Kong (local)", () => {
    it.each([
      "name resolution failed",
      "An invalid response was received from the upstream server",
      "failure to get a peer from the ring-balancer",
    ])("con code vacío: %s", (message) => {
      expect(esFalloTransitorioDeBase({ code: "", message })).toBe(true);
    });

    it("sin ninguna clave code (forma real medida el 22/9/2026, webhook local con PostgREST parado)", () => {
      expect(esFalloTransitorioDeBase({ message: "name resolution failed" })).toBe(true);
    });
  });

  describe("negativos: un message que no calza ningún patrón no es transitorio por sí solo", () => {
    it("PGRST116-like sin code no es transitorio", () => {
      expect(
        esFalloTransitorioDeBase({
          code: "",
          message: "JSON object requested, multiple (or no) rows returned",
        })
      ).toBe(false);
    });

    it("23505 con message de duplicado no es transitorio", () => {
      expect(esFalloTransitorioDeBase({ message: "duplicate key value", code: "23505" })).toBe(false);
    });
  });
});

describe("pruebaQueNuncaLlegoAlUpstream por message, vía esReintentoSeguro", () => {
  it.each(["upstream connect error", "disconnect/reset before headers", "connection termination"])(
    "Envoy '%s' → SÍ prueba que nunca llegó (mismo criterio que RespuestaDeBase)",
    (message) => {
      expect(esReintentoSeguro("POST", { code: "", message })).toBe(true);
    }
  );

  it("Kong 'name resolution failed' → SÍ prueba que nunca llegó (no pudo ni resolver el nombre)", () => {
    expect(esReintentoSeguro("POST", { code: "", message: "name resolution failed" })).toBe(true);
  });

  it("Kong 'failure to get a peer from the ring-balancer' → SÍ prueba que nunca llegó (no eligió a quién mandarlo)", () => {
    expect(
      esReintentoSeguro("POST", { code: "", message: "failure to get a peer from the ring-balancer" })
    ).toBe(true);
  });

  it("Kong 'invalid response was received from the upstream' → transitorio, pero NO prueba nada (el upstream sí respondió)", () => {
    const fallo = { code: "", message: "An invalid response was received from the upstream server" };
    expect(esFalloTransitorioDeBase(fallo)).toBe(true);
    expect(esReintentoSeguro("POST", fallo)).toBe(false);
  });
});

describe("esReintentoSeguro", () => {
  it("POST + ECONNRESET → NO (ambiguo: pudo haber ejecutado el insert)", () => {
    expect(esReintentoSeguro("POST", errorDeRed("ECONNRESET"))).toBe(false);
  });

  it("POST + ETIMEDOUT → NO (mismo motivo, ambiguo)", () => {
    expect(esReintentoSeguro("POST", errorDeRed("ETIMEDOUT"))).toBe(false);
  });

  it("POST + fetch failed sin cause.code → NO (ambiguo)", () => {
    expect(esReintentoSeguro("POST", new TypeError("fetch failed"))).toBe(false);
  });

  it("POST + Envoy 'disconnect/reset before headers' → SÍ (prueba que nunca llegó)", () => {
    expect(esReintentoSeguro("POST", respuestaEnvoy(503, "disconnect/reset before headers"))).toBe(true);
  });

  it("POST + Envoy 'upstream connect error' → SÍ", () => {
    expect(esReintentoSeguro("POST", respuestaEnvoy(502, "upstream connect error"))).toBe(true);
  });

  it("POST + Envoy 'connection termination' → SÍ", () => {
    expect(esReintentoSeguro("POST", respuestaEnvoy(504, "connection termination"))).toBe(true);
  });

  it("POST + ECONNREFUSED → SÍ (no hubo conexión, no pudo ejecutar nada)", () => {
    expect(esReintentoSeguro("POST", errorDeRed("ECONNREFUSED"))).toBe(true);
  });

  it("POST + EAI_AGAIN → SÍ", () => {
    expect(esReintentoSeguro("POST", errorDeRed("EAI_AGAIN"))).toBe(true);
  });

  it("POST + un 503 SIN el cuerpo de Envoy (PGRST00x) → NO (transitorio, pero no prueba que nunca llegó)", () => {
    expect(
      esReintentoSeguro("POST", { status: 503, cuerpo: '{"code":"PGRST003"}' })
    ).toBe(false);
  });

  it("GET + ECONNRESET → SÍ (idempotente, repetirlo no duplica nada)", () => {
    expect(esReintentoSeguro("GET", errorDeRed("ECONNRESET"))).toBe(true);
  });

  it("GET + Envoy → SÍ", () => {
    expect(esReintentoSeguro("GET", respuestaEnvoy(503, "upstream connect error"))).toBe(true);
  });

  it("HEAD + ECONNRESET → SÍ (también idempotente)", () => {
    expect(esReintentoSeguro("head", errorDeRed("ECONNRESET"))).toBe(true);
  });

  it("PATCH y DELETE se tratan como no idempotentes, igual que POST", () => {
    expect(esReintentoSeguro("PATCH", errorDeRed("ECONNRESET"))).toBe(false);
    expect(esReintentoSeguro("DELETE", errorDeRed("ECONNRESET"))).toBe(false);
    expect(esReintentoSeguro("PATCH", respuestaEnvoy(503, "upstream connect error"))).toBe(true);
  });

  it.each(["23505", "42501"])("PostgrestError %s nunca se reintenta, sea GET o POST", (code) => {
    expect(esReintentoSeguro("GET", postgrestError(code))).toBe(false);
    expect(esReintentoSeguro("POST", postgrestError(code))).toBe(false);
  });

  it("una respuesta 400 nunca se reintenta, sea GET o POST", () => {
    expect(esReintentoSeguro("GET", { status: 400, cuerpo: "bad request" })).toBe(false);
    expect(esReintentoSeguro("POST", { status: 400, cuerpo: "bad request" })).toBe(false);
  });
});
