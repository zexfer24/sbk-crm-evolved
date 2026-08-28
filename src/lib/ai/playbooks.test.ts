import { describe, expect, it, vi } from "vitest";
import type { Playbook } from "@/lib/types";

const generateObjectMock = vi.fn();

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}));

vi.mock("@/lib/ai/model", () => ({
  // getClassifierModel fija el esfuerzo bajo por dentro: el llamador ya no
  // lo elige, solo dice qué fase pide la llamada.
  getClassifierModel: (fase: string) => ({
    model: `modelo-falso:${fase}`,
    providerOptions: { openai: { reasoningEffort: "low" } },
  }),
}));

import { matchPlaybook, playbookSentRecently } from "@/lib/ai/playbooks";

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
    tags: [],
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

describe("matchPlaybook · costo del turno", () => {
  /**
   * El reconocimiento de escenario corre en TODOS los turnos y devuelve un
   * nombre de una lista cerrada. Razonar de más ahí se paga en cada mensaje
   * que entra, sin mejorar la elección.
   */
  it("le traslada al proveedor el esfuerzo de razonamiento bajo", async () => {
    generateObjectMock.mockResolvedValue({ object: "saludo", usage: USAGE });

    await matchPlaybook(HISTORY, [playbook("saludo")]);

    const call = generateObjectMock.mock.calls[0][0] as { providerOptions?: unknown };
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: "low" } });
  });
});

// ---------------------------------------------------------------------------
// La ventana de repetición
// ---------------------------------------------------------------------------

interface Filtro {
  op: string;
  columna: string;
  valor: unknown;
}

/** Fake de la cadena `.from().select().eq().eq().gt().limit()`. */
function fakeSupabase(filas: { id: string }[], error: { message: string } | null = null) {
  const filtros: Filtro[] = [];
  const tablas: string[] = [];

  const cadena = {
    eq: (columna: string, valor: unknown) => {
      filtros.push({ op: "eq", columna, valor });
      return cadena;
    },
    gt: (columna: string, valor: unknown) => {
      filtros.push({ op: "gt", columna, valor });
      return cadena;
    },
    limit: async () => ({ data: error ? null : filas, error }),
  };

  const client = {
    from: (tabla: string) => {
      tablas.push(tabla);
      return { select: () => cadena };
    },
  };

  return { client: client as never, filtros, tablas };
}

const AHORA = Date.parse("2026-08-27T16:30:00.000Z");

describe("playbookSentRecently — un escenario no se repite en el mismo chat", () => {
  it("dice que sí cuando la bitácora tiene un envío dentro de la ventana", async () => {
    const { client } = fakeSupabase([{ id: "turno-1" }]);

    expect(await playbookSentRecently(client, "conv-1", "pb-1", AHORA)).toBe(true);
  });

  it("dice que no cuando no hay ninguno", async () => {
    const { client } = fakeSupabase([]);

    expect(await playbookSentRecently(client, "conv-1", "pb-1", AHORA)).toBe(false);
  });

  /**
   * Los tres cortes son el contrato: ESTE escenario, en ESTA conversación,
   * dentro de la ventana. Quitar cualquiera lo convierte en otra pregunta —
   * sin `playbook_id` frenaría escenarios distintos, sin `conversation_id`
   * frenaría el chat de otro cliente.
   */
  it("pregunta por este escenario, en esta conversación y dentro de las seis horas", async () => {
    const { client, filtros, tablas } = fakeSupabase([]);

    await playbookSentRecently(client, "conv-1", "pb-1", AHORA);

    expect(tablas).toEqual(["agent_turns"]);
    expect(filtros).toContainEqual({ op: "eq", columna: "conversation_id", valor: "conv-1" });
    expect(filtros).toContainEqual({ op: "eq", columna: "playbook_id", valor: "pb-1" });
    expect(filtros).toContainEqual({
      op: "gt",
      columna: "created_at",
      valor: "2026-08-27T10:30:00.000Z",
    });
  });

  /**
   * Falla cerrado. Cuesta barato equivocarse hacia acá —el turno sigue por el
   * flujo genérico y el cliente igual recibe respuesta— y equivocarse hacia el
   * otro lado es el incidente del 27 de agosto.
   */
  it("si la consulta falla, da el escenario por repetido", async () => {
    const { client } = fakeSupabase([], { message: "connection reset" });

    expect(await playbookSentRecently(client, "conv-1", "pb-1", AHORA)).toBe(true);
  });
});
