import { describe, expect, it, vi } from "vitest";
import type { Playbook } from "@/lib/types";

const generateObjectMock = vi.fn();

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

vi.mock("@/lib/ai/model", () => ({
  getAgentModel: () => ({ model: "modelo-falso" }),
}));

import { matchPlaybook } from "@/lib/ai/playbooks";

const USAGE = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };

function playbook(name: string, overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: `id-${name}`,
    name,
    triggerDescription: `cuando aplica ${name}`,
    responseText: `texto de ${name}`,
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    isActive: true,
    ...overrides,
  };
}

const HISTORY = [{ role: "user" as const, content: "hola quiero accesorios" }];

describe("matchPlaybook", () => {
  it("no llama al modelo cuando no hay escenarios activos", async () => {
    generateObjectMock.mockClear();

    const result = await matchPlaybook(HISTORY, []);

    expect(generateObjectMock).not.toHaveBeenCalled();
    expect(result.playbook).toBeNull();
    expect(result.usage.totalTokens).toBe(0);
  });

  it("devuelve el escenario cuyo nombre eligió el modelo", async () => {
    const catalogo = playbook("Catálogo general");
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Catálogo general", usage: USAGE });

    const result = await matchPlaybook(HISTORY, [playbook("Postventa Cashea"), catalogo]);

    expect(result.playbook).toEqual(catalogo);
    expect(result.usage).toEqual(USAGE);
  });

  it("devuelve null cuando el modelo responde que no coincide ninguno", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });

    const result = await matchPlaybook(HISTORY, [playbook("Catálogo general")]);

    expect(result.playbook).toBeNull();
    // Los tokens se gastaron igual: el turno tiene que contabilizarlos.
    expect(result.usage).toEqual(USAGE);
  });

  it("trata un nombre desconocido como si no hubiera coincidido, sin romper el turno", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "Escenario inventado", usage: USAGE });

    const result = await matchPlaybook(HISTORY, [playbook("Catálogo general")]);

    expect(result.playbook).toBeNull();
  });

  it("ofrece al modelo los nombres de los escenarios más la opción de no elegir ninguno", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockResolvedValue({ object: "ninguno", usage: USAGE });

    await matchPlaybook(HISTORY, [playbook("Postventa Cashea"), playbook("Catálogo general")]);

    const call = generateObjectMock.mock.calls[0][0] as { enum: string[]; system: string };
    expect(call.enum).toEqual(["Postventa Cashea", "Catálogo general", "ninguno"]);
    // El prompt tiene que llevar el "cuándo aplica" de cada escenario: es lo
    // único con lo que el modelo puede decidir.
    expect(call.system).toContain("cuando aplica Postventa Cashea");
    expect(call.system).toContain("cuando aplica Catálogo general");
  });

  it("si el modelo falla, no coincide ningún escenario en vez de tumbar el turno", async () => {
    generateObjectMock.mockClear();
    generateObjectMock.mockRejectedValue(new Error("503 del proveedor"));

    const result = await matchPlaybook(HISTORY, [playbook("Catálogo general")]);

    expect(result.playbook).toBeNull();
    expect(result.usage.totalTokens).toBe(0);
  });
});
