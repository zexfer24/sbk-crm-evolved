import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// El espaciado al encolar, probado contra la interfaz de la cola y no contra
// Redis: queue.test.ts necesita un Redis de verdad y se salta entero cuando no
// lo hay, que es justo la máquina donde se escribe esto.
// ---------------------------------------------------------------------------

const encolados: { conversationId: string; debounceSeconds: number }[] = [];

vi.mock("@/lib/redis", () => ({ getRedis: () => ({}) }));
vi.mock("@/lib/ai/redis-queue", () => ({
  createAgentQueue: () => ({
    async enqueue(conversationId: string, debounceSeconds: number) {
      encolados.push({ conversationId, debounceSeconds });
    },
  }),
  createTurnSlots: () => ({ acquire: async () => null, release: async () => {} }),
}));

import { enqueueAgentTurns } from "@/lib/ai/queue";

beforeEach(() => {
  encolados.length = 0;
});

describe("enqueueAgentTurns — espaciado", () => {
  /** El camino del webhook no cambia: todos comparten la misma ventana de silencio. */
  it("sin espaciado, todas vencen a la vez", async () => {
    await enqueueAgentTurns(["a", "b", "c"], { debounceSeconds: 6 });

    expect(encolados.map((e) => e.debounceSeconds)).toEqual([6, 6, 6]);
  });

  /**
   * La cola es un conjunto ordenado por instante de vencimiento. Con
   * vencimientos idénticos Redis devuelve los empates por orden alfabético
   * del id, o sea al azar: separarlos un segundo es lo que hace que el repaso
   * del atraso atienda en el orden en que se le pasaron las conversaciones.
   */
  it("con espaciado, cada una vence un paso después de la anterior", async () => {
    await enqueueAgentTurns(["a", "b", "c"], { debounceSeconds: 0, spacingSeconds: 1 });

    expect(encolados).toEqual([
      { conversationId: "a", debounceSeconds: 0 },
      { conversationId: "b", debounceSeconds: 1 },
      { conversationId: "c", debounceSeconds: 2 },
    ]);
  });

  it("respeta el orden en que llegan las conversaciones", async () => {
    await enqueueAgentTurns(["ultima", "primera"], { debounceSeconds: 0, spacingSeconds: 10 });

    expect(encolados.map((e) => e.conversationId)).toEqual(["ultima", "primera"]);
    expect(encolados.map((e) => e.debounceSeconds)).toEqual([0, 10]);
  });

  /** Los repetidos se colapsan ANTES de contar posiciones: si no, dejarían huecos en el ritmo. */
  it("una conversación repetida no gasta un turno del espaciado", async () => {
    await enqueueAgentTurns(["a", "a", "b"], { debounceSeconds: 0, spacingSeconds: 5 });

    expect(encolados).toEqual([
      { conversationId: "a", debounceSeconds: 0 },
      { conversationId: "b", debounceSeconds: 5 },
    ]);
  });
});
