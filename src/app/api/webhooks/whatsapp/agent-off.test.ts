import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `after()` de Next.js exige contexto de request real; en el test lo
// ejecutamos inline para poder esperar sus efectos.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (cb: () => unknown) => {
      void cb();
    },
  };
});

// Espejo de route.test.ts, new-contact-race.test.ts y welcome-race.test.ts
// (ver CLAUDE.md, Trampas): el importOriginal de la fábrica de
// @/lib/ai/queue carga los dos SDK de IA e ioredis con tal de leer un par de
// constantes puras. Se corta acá para que el primer `await import(...)` no
// arrastre ese grafo entero.
vi.mock("@/lib/ai/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/queue")>();
  return {
    DEBOUNCE_SECONDS: actual.DEBOUNCE_SECONDS,
    DEBOUNCE_SHORT_SECONDS: actual.DEBOUNCE_SHORT_SECONDS,
    debounceSecondsFor: actual.debounceSecondsFor,
    enqueueAgentTurns: vi.fn(async () => {}),
    processAfterDebounce: vi.fn(async () => ({ processed: 0, failed: 0, deferred: 0 })),
  };
});

vi.mock("@/lib/ai/agent", () => ({
  runAgentTurn: vi.fn(),
}));

// Mismo motivo: queue.ts importa getRedis de acá sólo para encolar/drenar,
// que este test tiene mockeado en @/lib/ai/queue. El webhook no debe tocar
// Redis: si lo intenta, que lo delate.
vi.mock("@/lib/redis", () => ({
  getRedis: vi.fn(() => {
    throw new Error("El test del webhook no debe tocar Redis");
  }),
}));

/** Lo que responde `agent_can_run`; cada prueba lo fija antes de llamar al webhook. */
let aiCanRun = true;

/** Cada llamada a `record_handoff`, con los parámetros que le llegaron. */
const handoffCalls: Record<string, unknown>[] = [];

function createFakeAdminClient() {
  const insertedMessages = new Map<string, { id: string }>();
  let nextId = 1;

  const client = {
    from(table: string) {
      if (table === "whatsapp_channels") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: { id: "chan-1", phone_number_id: "1234567890", status: "connected" },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }

      if (table === "contacts") {
        return {
          upsert() {
            return {
              select() {
                return { single: async () => ({ data: { id: "contact-1" }, error: null }) };
              },
            };
          },
        };
      }

      if (table === "conversations") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({
                        // Ventana abierta a propósito: evita que la bienvenida
                        // se meta en un test que no la mira.
                        data: { id: "conv-1", last_customer_message_at: new Date().toISOString() },
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
          update() {
            return { eq: async () => ({ data: null, error: null }) };
          },
        };
      }

      if (table === "messages") {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: null, error: null }) };
              },
            };
          },
          insert(row: { whatsapp_message_id: string }) {
            return {
              select() {
                return {
                  single: async () => {
                    if (insertedMessages.has(row.whatsapp_message_id)) {
                      return {
                        data: null,
                        error: { code: "23505", message: "duplicate key value violates unique constraint" },
                      };
                    }
                    const created = { id: `msg-${nextId++}` };
                    insertedMessages.set(row.whatsapp_message_id, created);
                    return { data: created, error: null };
                  },
                };
              },
            };
          },
          update() {
            return {
              eq: () => Object.assign(Promise.resolve({ data: null, error: null }), { select: async () => ({ data: [], error: null }) }),
            };
          },
        };
      }

      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
    rpc: async (fn: string, params?: Record<string, unknown>) => {
      if (fn === "rate_limit_allow") return { data: true, error: null };
      if (fn === "agent_can_run") return { data: aiCanRun, error: null };
      if (fn === "record_handoff") {
        handoffCalls.push(params ?? {});
        return { data: "handoff-1", error: null };
      }
      throw new Error(`Fake Supabase: rpc no soportada en este test: ${fn}`);
    },
    storage: {
      from() {
        return {
          upload: async () => ({ error: null }),
          getPublicUrl: () => ({ data: { publicUrl: "https://example.com/media" } }),
        };
      },
    },
  };

  return { client, insertedMessages };
}

const { client: fakeAdminClient, insertedMessages } = createFakeAdminClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdminClient,
}));

function webhookBody(waMessageId: string) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "1234567890" },
              contacts: [{ profile: { name: "Cliente Demo" }, wa_id: "584120000000" }],
              messages: [
                {
                  from: "584120000000",
                  id: waMessageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "hola, ¿tienen bujías?" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function fakeRequest(body: unknown): Request {
  const raw = JSON.stringify(body);
  return {
    text: async () => raw,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Request;
}

let POST: typeof import("@/app/api/webhooks/whatsapp/route").POST;
let enqueueAgentTurns: typeof import("@/lib/ai/queue").enqueueAgentTurns;

// La carga en frío del grafo del webhook (varias fábricas con
// importOriginal) cae dentro del presupuesto de la primera prueba y bajo
// carga lo tumba: mismo presupuesto propio que los otros tres archivos de
// este directorio (29/8/2026).
beforeAll(async () => {
  ({ POST } = await import("@/app/api/webhooks/whatsapp/route"));
  ({ enqueueAgentTurns } = await import("@/lib/ai/queue"));
}, 30_000);

beforeEach(() => {
  handoffCalls.length = 0;
  aiCanRun = true;
  vi.mocked(enqueueAgentTurns).mockClear();
});

describe("POST /api/webhooks/whatsapp — traspaso cuando la IA no puede correr", () => {
  /**
   * `agent_can_run()` fusiona a propósito "IA apagada globalmente" y "tope
   * de gasto del día alcanzado" en un solo booleano (ver
   * 20260822010000_ai_daily_spend_cap.sql): separarlas costaría otra
   * consulta en el camino caliente del webhook, así que hay una sola razón.
   */
  it("con la IA sin poder correr: guarda el mensaje, no encola turno, y deja una fila de traspaso", async () => {
    aiCanRun = false;
    const waMessageId = "wamid.agente-no-puede-correr-1";

    const response = await POST(fakeRequest(webhookBody(waMessageId)));

    expect(response.status).toBe(200);
    const parsedBody: unknown = await response.json();
    expect(parsedBody).toEqual({ ok: true });

    // El mensaje del cliente se guarda igual: la bandeja lo tiene que ver.
    expect(insertedMessages.has(waMessageId)).toBe(true);

    // Sin turno: nadie queda atendiendo por la vía normal.
    expect(enqueueAgentTurns).not.toHaveBeenCalled();

    // Y en su lugar, exactamente una fila de traspaso para esa conversación.
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "agente_no_puede_correr",
    });
  });

  it("con la IA pudiendo correr: encola el turno y no escribe ninguna fila de traspaso", async () => {
    aiCanRun = true;
    const waMessageId = "wamid.agente-si-puede-correr-1";

    const response = await POST(fakeRequest(webhookBody(waMessageId)));

    expect(response.status).toBe(200);
    const parsedBody: unknown = await response.json();
    expect(parsedBody).toEqual({ ok: true });

    expect(insertedMessages.has(waMessageId)).toBe(true);
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
    expect(handoffCalls).toHaveLength(0);
  });
});
