import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withConversationTurnLock } from "@/lib/ai/conversation-lock";

/**
 * Fake que simula el comportamiento atómico real de Postgres para
 * `UPDATE conversations SET ai_turn_running = true WHERE id = $1 AND
 * ai_turn_running = false`: el chequeo-y-set ocurre de forma síncrona antes
 * de cualquier `await`, igual que lo garantiza una fila de Postgres.
 */
function createFakeSupabase() {
  const runningByConversation = new Map<string, boolean>();
  const acquireCalls: string[] = [];
  const releaseCalls: string[] = [];

  const client = {
    from(table: string) {
      if (table !== "conversations") throw new Error(`tabla inesperada: ${table}`);
      return {
        update(values: { ai_turn_running: boolean }) {
          return {
            eq(_col: string, conversationId: string) {
              // Camino de liberación: solo filtra por id, sin segundo .eq().
              if (values.ai_turn_running === false) {
                releaseCalls.push(conversationId);
                runningByConversation.set(conversationId, false);
                return Promise.resolve({ data: null, error: null });
              }
              // Camino de adquisición: encadena un segundo .eq() condicional.
              return {
                eq() {
                  return {
                    select() {
                      const currentlyRunning = runningByConversation.get(conversationId) ?? false;
                      acquireCalls.push(conversationId);
                      if (currentlyRunning) {
                        return Promise.resolve({ data: [], error: null });
                      }
                      runningByConversation.set(conversationId, true);
                      return Promise.resolve({ data: [{ id: conversationId }], error: null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    runningByConversation,
    acquireCalls,
    releaseCalls,
  };
}

describe("withConversationTurnLock", () => {
  it("ejecuta fn cuando logra adquirir el lock, y lo libera al terminar", async () => {
    const { client, runningByConversation } = createFakeSupabase();
    const fn = vi.fn().mockResolvedValue(undefined);

    await withConversationTurnLock(client, "conv-1", fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(runningByConversation.get("conv-1")).toBe(false);
  });

  it("libera el lock incluso si fn lanza una excepción", async () => {
    const { client, runningByConversation } = createFakeSupabase();
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(withConversationTurnLock(client, "conv-1", fn)).rejects.toThrow("boom");
    expect(runningByConversation.get("conv-1")).toBe(false);
  });

  it("dos invocaciones casi simultáneas para la MISMA conversación: solo una ejecuta fn", async () => {
    const { client } = createFakeSupabase();
    let concurrentRuns = 0;
    let maxConcurrentRuns = 0;
    const fn = vi.fn().mockImplementation(async () => {
      concurrentRuns++;
      maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrentRuns--;
    });

    await Promise.all([
      withConversationTurnLock(client, "conv-1", fn),
      withConversationTurnLock(client, "conv-1", fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(maxConcurrentRuns).toBe(1);
  });

  it("dos invocaciones para conversaciones DISTINTAS: ambas ejecutan fn sin bloquearse entre sí", async () => {
    const { client } = createFakeSupabase();
    const fn = vi.fn().mockResolvedValue(undefined);

    await Promise.all([
      withConversationTurnLock(client, "conv-1", fn),
      withConversationTurnLock(client, "conv-2", fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
