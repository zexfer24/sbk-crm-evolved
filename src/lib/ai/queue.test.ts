import { describe, expect, it, vi } from "vitest";

const runAgentTurnMock = vi.fn(async () => {});
vi.mock("@/lib/ai/agent", () => ({ runAgentTurn: () => runAgentTurnMock() }));

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let turnosPorEntregar: string[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "claim_agent_turn") return { data: turnosPorEntregar.shift() ?? null, error: null };
      return { data: null, error: null };
    },
  }),
}));

import { DEBOUNCE_SECONDS, enqueueAgentTurns, processQueuedTurns } from "@/lib/ai/queue";

function fakeSupabase() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: null, error: null };
    },
  };
}

describe("enqueueAgentTurns", () => {
  it("encola una sola vez por conversación aunque el lote traiga varios mensajes", async () => {
    rpcCalls.length = 0;

    // @ts-expect-error -- fake mínimo suficiente para este test
    await enqueueAgentTurns(fakeSupabase(), ["conv-1", "conv-1", "conv-2", "conv-1"]);

    const encolados = rpcCalls.filter((c) => c.fn === "enqueue_agent_turn");
    expect(encolados).toHaveLength(2);
    expect(encolados.map((c) => c.args.p_conversation_id)).toEqual(["conv-1", "conv-2"]);
  });

  /**
   * Sin ventana, un cliente que escribe en ráfaga recibe una respuesta por
   * frase, cada una sin el contexto de las siguientes.
   */
  it("pasa la ventana de silencio a la base", async () => {
    rpcCalls.length = 0;

    // @ts-expect-error -- fake mínimo
    await enqueueAgentTurns(fakeSupabase(), ["conv-1"]);

    expect(rpcCalls[0].args.p_debounce_seconds).toBe(DEBOUNCE_SECONDS);
    expect(DEBOUNCE_SECONDS).toBe(6);
  });
});

describe("processQueuedTurns", () => {
  it("procesa hasta vaciar la cola y devuelve la cuenta", async () => {
    rpcCalls.length = 0;
    runAgentTurnMock.mockClear();
    turnosPorEntregar = ["conv-1", "conv-2"];

    const result = await processQueuedTurns();

    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(runAgentTurnMock).toHaveBeenCalledTimes(2);
  });

  /**
   * Al cerrar bien hay que mandar la ventana: si el cliente escribió mientras
   * corría el turno, la fila no se borra y vuelve a la cola con ese margen.
   */
  it("al cerrar un turno bien manda también la ventana", async () => {
    rpcCalls.length = 0;
    turnosPorEntregar = ["conv-1"];

    await processQueuedTurns();

    const cierre = rpcCalls.find((c) => c.fn === "finish_agent_turn");
    expect(cierre?.args.p_debounce_seconds).toBe(DEBOUNCE_SECONDS);
    expect(cierre?.args.p_error).toBeUndefined();
  });

  it("un turno que falla no frena a los demás y queda registrado con su error", async () => {
    rpcCalls.length = 0;
    turnosPorEntregar = ["conv-rota", "conv-buena"];
    runAgentTurnMock.mockRejectedValueOnce(new Error("el modelo no respondió"));

    const result = await processQueuedTurns();

    expect(result).toEqual({ processed: 1, failed: 1 });
    const conError = rpcCalls.find((c) => c.fn === "finish_agent_turn" && c.args.p_error);
    expect(conError?.args.p_error).toBe("el modelo no respondió");
  });

  it("con la cola vacía no llama al agente", async () => {
    rpcCalls.length = 0;
    runAgentTurnMock.mockClear();
    turnosPorEntregar = [];

    const result = await processQueuedTurns();

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });
});
