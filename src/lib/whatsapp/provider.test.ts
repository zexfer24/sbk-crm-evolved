import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  D360_DEFAULT_BASE_URL,
  whatsappCredentialProblem,
  whatsappCredentials,
  whatsappProvider,
} from "@/lib/whatsapp/provider";

/**
 * Plan "SBK CRM pasa a 360dialog" (8/10/2026), T1: `provider.ts` es la única
 * fuente de credenciales de WhatsApp. Las variables se leen en cada llamada
 * (no al cargar el módulo) para poder cambiarlas con `vi.stubEnv`.
 */

beforeEach(() => {
  // Partimos de un entorno limpio: ninguna variable del proveedor definida.
  vi.stubEnv("WHATSAPP_PROVIDER", "");
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "");
  vi.stubEnv("WHATSAPP_GRAPH_API_VERSION", "");
  vi.stubEnv("D360_API_KEY", "");
  vi.stubEnv("D360_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("whatsappProvider", () => {
  it("sin definir (o vacío) es meta (D1)", () => {
    expect(whatsappProvider()).toBe("meta");
  });

  it("acepta 360dialog sin importar mayúsculas ni espacios", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "360DIALOG ");
    expect(whatsappProvider()).toBe("360dialog");
  });

  it("acepta meta explícito", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", " Meta");
    expect(whatsappProvider()).toBe("meta");
  });

  it("un valor desconocido es configuración rota: null", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "twilio");
    expect(whatsappProvider()).toBeNull();
  });
});

describe("whatsappCredentials", () => {
  it("meta con token: usa la versión por defecto de la Graph API", () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok-meta");
    expect(whatsappCredentials()).toEqual({ provider: "meta", accessToken: "tok-meta", graphVersion: "v21.0" });
  });

  it("meta respeta WHATSAPP_GRAPH_API_VERSION", () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok-meta");
    vi.stubEnv("WHATSAPP_GRAPH_API_VERSION", "v23.0");
    expect(whatsappCredentials()).toEqual({ provider: "meta", accessToken: "tok-meta", graphVersion: "v23.0" });
  });

  it("meta sin token: null", () => {
    expect(whatsappCredentials()).toBeNull();
  });

  it("360dialog con llave: base URL por defecto", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "360dialog");
    vi.stubEnv("D360_API_KEY", "key-360");
    expect(D360_DEFAULT_BASE_URL).toBe("https://waba-v2.360dialog.io");
    expect(whatsappCredentials()).toEqual({
      provider: "360dialog",
      apiKey: "key-360",
      baseUrl: "https://waba-v2.360dialog.io",
    });
  });

  it("360dialog recorta las barras finales de D360_BASE_URL", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "360dialog");
    vi.stubEnv("D360_API_KEY", "key-360");
    vi.stubEnv("D360_BASE_URL", "https://sandbox.example.io//");
    expect(whatsappCredentials()).toEqual({
      provider: "360dialog",
      apiKey: "key-360",
      baseUrl: "https://sandbox.example.io",
    });
  });

  it("360dialog sin llave: null", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "360dialog");
    expect(whatsappCredentials()).toBeNull();
  });

  it("360dialog no usa el token de Meta aunque esté definido", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "360dialog");
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok-meta");
    expect(whatsappCredentials()).toBeNull();
  });

  it("proveedor inválido: null aunque haya token", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "twilio");
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok-meta");
    expect(whatsappCredentials()).toBeNull();
  });
});

describe("whatsappCredentialProblem", () => {
  it("proveedor inválido: WHATSAPP_PROVIDER", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "twilio");
    expect(whatsappCredentialProblem()).toBe("WHATSAPP_PROVIDER");
  });

  it("360dialog sin llave: D360_API_KEY", () => {
    vi.stubEnv("WHATSAPP_PROVIDER", "360dialog");
    expect(whatsappCredentialProblem()).toBe("D360_API_KEY");
  });

  it("meta sin token: WHATSAPP_ACCESS_TOKEN", () => {
    expect(whatsappCredentialProblem()).toBe("WHATSAPP_ACCESS_TOKEN");
  });

  it("todo completo: null", () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok-meta");
    expect(whatsappCredentialProblem()).toBeNull();
    vi.stubEnv("WHATSAPP_PROVIDER", "360dialog");
    vi.stubEnv("D360_API_KEY", "key-360");
    expect(whatsappCredentialProblem()).toBeNull();
  });
});
