import { describe, expect, it, vi } from "vitest";

const generateObjectMock = vi.fn();

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

vi.mock("@/lib/ai/model", () => ({
  getAgentModel: (effort: string) => ({
    model: "modelo-falso",
    providerOptions: { openai: { reasoningEffort: effort } },
  }),
}));

import { INTENT_VALUES, classifyIntent } from "@/lib/ai/classify";

const HISTORY = [{ role: "user" as const, content: "hola tienen cauchos" }];

describe("classifyIntent", () => {
  /**
   * Sin esta categoría, un mensaje que no tiene nada que ver con la tienda
   * caía en "otro", que arranca el tool loop completo: alguien pidiéndole
   * una receta consumía lo mismo que un cliente real preguntando por un
   * repuesto. Es el turno más caro que existe, gastado en nada.
   */
  it("ofrece 'fuera_de_tema' como opción para lo que no es del negocio", () => {
    expect(INTENT_VALUES).toContain("fuera_de_tema");
  });

  it("le pasa al modelo exactamente las categorías declaradas", async () => {
    generateObjectMock.mockResolvedValue({
      object: "consulta_disponibilidad",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });

    await classifyIntent(HISTORY);

    const call = generateObjectMock.mock.calls[0][0] as { enum: string[]; output: string };
    expect(call.output).toBe("enum");
    expect(call.enum).toEqual([...INTENT_VALUES]);
  });

  /**
   * Clasificar devuelve UNA palabra de un enum: razonar de más no mejora la
   * respuesta, solo agrega tokens de razonamiento facturables y latencia. Se
   * pide esfuerzo bajo, pero pedirlo no basta — hay que trasladárselo al
   * proveedor en la llamada, o el modelo usa su valor por defecto.
   */
  it("le traslada al proveedor el esfuerzo de razonamiento bajo", async () => {
    generateObjectMock.mockResolvedValue({
      object: "consulta_disponibilidad",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });

    await classifyIntent(HISTORY);

    const call = generateObjectMock.mock.calls[0][0] as { providerOptions?: unknown };
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: "low" } });
  });
});
