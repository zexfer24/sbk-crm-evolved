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

// media-reading-store arrastra el SDK de IA (modelo de visión + Whisper) y
// este test no ejercita la lectura de adjuntos: se corta el grafo acá. Espejo
// de route.test.ts (plan "Seba lee fotos y audios", M3, 16/11/2026).
vi.mock("@/lib/ai/media-reading-store", () => ({
  kindDeLectura: (tipo: string | null | undefined) => (tipo === "audio" || tipo === "image" ? tipo : null),
  registrarLectura: vi.fn(async () => {}),
  registrarFalloDeDescarga: vi.fn(async () => {}),
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
/** Si `agent_can_run` contesta con un error en vez de un booleano. */
let aiCanRunError: { message: string } | null = null;
/** Lo que responde `shadow_can_run`. */
let shadowCanRun = false;
/** Si `shadow_can_run` contesta con un error en vez de un booleano. */
let shadowCanRunError: { message: string } | null = null;
/** Cuántas veces el webhook consultó `shadow_can_run`. */
let shadowCalls = 0;

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
      if (fn === "agent_can_run") return { data: aiCanRunError ? null : aiCanRun, error: aiCanRunError };
      if (fn === "shadow_can_run") {
        shadowCalls++;
        return { data: shadowCanRunError ? null : shadowCanRun, error: shadowCanRunError };
      }
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
  aiCanRunError = null;
  shadowCanRun = false;
  shadowCanRunError = null;
  shadowCalls = 0;
  vi.mocked(enqueueAgentTurns).mockClear();
});

describe("POST /api/webhooks/whatsapp — la sombra de Seba v2 con la IA global apagada", () => {
  /**
   * S9a, entrega 3 del rework de Seba (17/11/2026). En producción la IA
   * global está apagada: sin esta excepción el webhook retornaba antes de
   * encolar y la sombra de v2 no corría jamás. El turno sí se encola, y es
   * EL TURNO (que con la IA apagada hace exactamente eso) quien deja el
   * traspaso `agente_no_puede_correr` -- el webhook no lo duplica.
   */
  it("IA apagada + shadow_can_run true: encola el turno y el webhook NO escribe agente_no_puede_correr", async () => {
    aiCanRun = false;
    shadowCanRun = true;
    const waMessageId = "wamid.sombra-encola-1";

    const response = await POST(fakeRequest(webhookBody(waMessageId)));

    expect(response.status).toBe(200);
    expect(insertedMessages.has(waMessageId)).toBe(true);
    expect(shadowCalls).toBe(1);
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
    expect(handoffCalls).toHaveLength(0);
  });

  it("IA apagada + shadow_can_run false: como hoy, no encola y deja el traspaso", async () => {
    aiCanRun = false;
    shadowCanRun = false;

    const response = await POST(fakeRequest(webhookBody("wamid.sombra-no-encola-1")));

    expect(response.status).toBe(200);
    expect(shadowCalls).toBe(1);
    expect(enqueueAgentTurns).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "agente_no_puede_correr",
    });
  });

  it("IA apagada + error en shadow_can_run: como hoy, no encola y deja el traspaso", async () => {
    aiCanRun = false;
    shadowCanRunError = { message: "connection refused" };

    const response = await POST(fakeRequest(webhookBody("wamid.sombra-error-1")));

    expect(response.status).toBe(200);
    expect(shadowCalls).toBe(1);
    expect(enqueueAgentTurns).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({ p_reason: "agente_no_puede_correr" });
  });

  it("IA encendida: no consulta shadow_can_run (ni un viaje de más a la base) y encola", async () => {
    aiCanRun = true;
    shadowCanRun = true;

    const response = await POST(fakeRequest(webhookBody("wamid.sombra-ia-encendida-1")));

    expect(response.status).toBe(200);
    expect(shadowCalls).toBe(0);
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
    expect(handoffCalls).toHaveLength(0);
  });

  it("error en agent_can_run: sigue de largo y encola como siempre, sin preguntar por la sombra", async () => {
    aiCanRunError = { message: "connection refused" };
    shadowCanRun = true;

    const response = await POST(fakeRequest(webhookBody("wamid.sombra-interruptor-roto-1")));

    expect(response.status).toBe(200);
    expect(shadowCalls).toBe(0);
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
    expect(handoffCalls).toHaveLength(0);
  });
});
