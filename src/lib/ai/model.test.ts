import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Lo que se prueba acá no es que el modelo funcione: es que las dos promesas
// de model.ts se cumplan.
//
//   1. Todo modelo que sale de acá va con el control de ritmo puesto. Es la
//      única forma de que "un solo punto de control" signifique algo.
//   2. Mover SOLO la clasificación a otro modelo es una línea de .env.
// ---------------------------------------------------------------------------

const openaiMock = vi.fn((modelId: string) => ({ proveedor: "openai", modelId }));
const googleMock = vi.fn((modelId: string) => ({ proveedor: "google", modelId }));
vi.mock("@ai-sdk/openai", () => ({ openai: (id: string) => openaiMock(id) }));
vi.mock("@ai-sdk/google", () => ({ google: (id: string) => googleMock(id) }));

/** Registra qué modelo se envolvió y con qué opciones de ritmo. */
const envueltos: { modelo: unknown; fase: string; reintentos?: number }[] = [];
const middlewarePorId = new Map<object, { fase: string; reintentos?: number }>();

vi.mock("@/lib/ai/rate-limit", () => ({
  rateLimitMiddleware: (options: { fase: string; reintentos?: number }) => {
    const middleware = { wrapGenerate: () => undefined };
    middlewarePorId.set(middleware, options);
    return middleware;
  },
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  wrapLanguageModel: ({ model, middleware }: { model: unknown; middleware: object }) => {
    const options = middlewarePorId.get(middleware);
    if (!options) throw new Error("se envolvió un modelo con un middleware que no es el del ritmo");
    envueltos.push({ modelo: model, ...options });
    return { envuelto: model };
  },
}));

import { currentAgentModelLabel, getAgentModel, getClassifierModel } from "@/lib/ai/model";

const VARIABLES = ["AI_AGENT_MODEL", "AI_AGENT_PROVIDER", "AI_CLASSIFIER_MODEL"] as const;
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const clave of VARIABLES) {
    original[clave] = process.env[clave];
    delete process.env[clave];
  }
  envueltos.length = 0;
  openaiMock.mockClear();
  googleMock.mockClear();
});

afterEach(() => {
  for (const clave of VARIABLES) {
    if (original[clave] === undefined) delete process.env[clave];
    else process.env[clave] = original[clave];
  }
});

describe("control de ritmo", () => {
  /**
   * Si un modelo saliera de acá sin envolver, tendríamos un camino hacia el
   * proveedor sin freno — y sería invisible hasta el próximo 429 en cadena.
   */
  it("envuelve el modelo del agente", () => {
    getAgentModel("medium");

    expect(envueltos).toHaveLength(1);
    expect(envueltos[0].fase).toBe("redactar");
  });

  it("envuelve el modelo de clasificación", () => {
    getClassifierModel("clasificar");

    expect(envueltos).toHaveLength(1);
    expect(envueltos[0].fase).toBe("clasificar");
  });

  /**
   * El agente no reintenta y el clasificador sí. Es la regla que separa lo
   * que puede duplicarle un mensaje al cliente de lo que no.
   */
  it("solo le da reintentos a la clasificación", () => {
    getAgentModel("medium");
    getClassifierModel("escenario");

    const [agente, clasificador] = envueltos;
    expect(agente.reintentos).toBeUndefined();
    expect(clasificador.reintentos).toBe(2);
  });
});

describe("costura para mover la clasificación de modelo", () => {
  it("sin AI_CLASSIFIER_MODEL, clasificar usa el mismo modelo del agente", () => {
    process.env.AI_AGENT_MODEL = "gpt-5.6-luna";

    getClassifierModel("clasificar");

    expect(openaiMock).toHaveBeenCalledWith("gpt-5.6-luna");
    expect(googleMock).not.toHaveBeenCalled();
  });

  /**
   * El cambio previsto, tal como se hará: una línea de .env, con el resto de
   * la configuración de producción intacta —AI_AGENT_PROVIDER=openai incluido.
   *
   * Ese override es del AGENTE. Si se aplicara también al clasificador,
   * pediríamos un modelo Gemini al proveedor OpenAI y el cambio de una línea
   * serían dos, con la segunda descubriéndose en producción.
   */
  it("con AI_CLASSIFIER_MODEL, solo la clasificación se muda, y al proveedor correcto", () => {
    process.env.AI_AGENT_MODEL = "gpt-5.6-luna";
    process.env.AI_AGENT_PROVIDER = "openai";
    process.env.AI_CLASSIFIER_MODEL = "gemini-3.1-flash-lite";

    getClassifierModel("clasificar");
    expect(googleMock).toHaveBeenCalledWith("gemini-3.1-flash-lite");
    expect(openaiMock).not.toHaveBeenCalled();

    // El agente no se movió: sigue redactando con el mismo modelo de siempre.
    getAgentModel("medium");
    expect(openaiMock).toHaveBeenCalledWith("gpt-5.6-luna");
  });

  /** La bitácora sigue registrando el modelo del agente, no el del clasificador. */
  it("la etiqueta del panel sigue siendo la del agente", () => {
    process.env.AI_AGENT_MODEL = "gpt-5.6-luna";
    process.env.AI_AGENT_PROVIDER = "openai";
    process.env.AI_CLASSIFIER_MODEL = "gemini-3.1-flash-lite";

    expect(currentAgentModelLabel()).toBe("openai/gpt-5.6-luna");
  });
});
