import { beforeAll, describe, expect, it, vi } from "vitest";

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

// Esta prueba mira la carrera al crear el contacto, no la cola: se sustituye
// para no exigir un Redis levantado.
// debounceSecondsFor es una función pura sobre el texto del mensaje: no toca
// Redis, así que se deja la de verdad en vez de inventar un valor.
vi.mock("@/lib/ai/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/queue")>();
  return {
    DEBOUNCE_SECONDS: actual.DEBOUNCE_SECONDS,
    DEBOUNCE_SHORT_SECONDS: actual.DEBOUNCE_SHORT_SECONDS,
    debounceSecondsFor: actual.debounceSecondsFor,
    enqueueAgentTurns: vi.fn(async () => {}),
    pendingAgentTurns: vi.fn(async () => 0),
    processAfterDebounce: vi.fn(async () => ({ processed: 0, failed: 0, deferred: 0 })),
    processQueuedTurns: vi.fn(async () => ({ processed: 0, failed: 0, deferred: 0 })),
  };
});

vi.mock("@/lib/ai/agent", () => ({
  runAgentTurn: vi.fn(async () => {}),
}));

// Espejo de route.test.ts (ver CLAUDE.md, Trampas): el importOriginal de la
// fábrica de @/lib/ai/queue cargaba ioredis real por esta vía. El webhook no
// debe tocar Redis: si lo intenta, que lo delate.
vi.mock("@/lib/redis", () => ({
  getRedis: vi.fn(() => {
    throw new Error("El test del webhook no debe tocar Redis");
  }),
}));

/**
 * Simula la condición de carrera real: dos mensajes del MISMO contacto nuevo
 * llegan en invocaciones "concurrentes" del webhook. Ambas leen "no existe
 * conversación todavía", ambas intentan crear una -- la restricción única
 * (contact_id, whatsapp_channel_id) de Postgres rechaza la segunda con
 * 23505. Antes del fix, el código hacía `continue` y perdía ese mensaje en
 * silencio. El fix debe releer la conversación ya creada por la otra
 * invocación y seguir procesando el mensaje con ella.
 */
function createRacingFakeAdminClient() {
  // Ya existe -- simula que OTRA invocación concurrente del webhook ya ganó
  // la carrera y creó la conversación de este contacto nuevo un instante
  // antes. La primera lectura de ESTA invocación, sin embargo, todavía no
  // la ve (se disparó antes de que la otra transacción confirmara).
  let conversationRow: { id: string; last_customer_message_at: string | null } | null = {
    id: "conv-race-winner",
    last_customer_message_at: null,
  };
  let selectCallsBeforeInsertWins = 1; // la primera lectura no ve la fila todavía
  const insertedMessages = new Map<string, { id: string }>();
  let nextMsgId = 1;

  const client = {
    from(table: string) {
      if (table === "whatsapp_channels") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "chan-1", phone_number_id: "1234567890", status: "connected" },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === "contacts") {
        return {
          upsert: () => ({
            select: () => ({ single: async () => ({ data: { id: "contact-1" }, error: null }) }),
          }),
        };
      }

      if (table === "conversations") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => {
                  if (!conversationRow || selectCallsBeforeInsertWins > 0) {
                    selectCallsBeforeInsertWins--;
                    return { data: null, error: null };
                  }
                  return { data: conversationRow, error: null };
                },
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: async () => {
                if (conversationRow) {
                  // Otra invocación "concurrente" ya creó la fila para este
                  // contacto+canal -- Postgres rechazaría este insert.
                  return {
                    data: null,
                    error: { code: "23505", message: "duplicate key value violates unique constraint" },
                  };
                }
                conversationRow = { id: "conv-race-winner", last_customer_message_at: null };
                return { data: { id: "conv-race-winner" }, error: null };
              },
            }),
          }),
          update: () => ({ eq: async () => ({ data: null, error: null }) }),
        };
      }

      if (table === "messages") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          insert: (row: { whatsapp_message_id: string; conversation_id: string }) => ({
            select: () => ({
              single: async () => {
                const created = { id: `msg-${nextMsgId++}`, conversationId: row.conversation_id };
                insertedMessages.set(row.whatsapp_message_id, created);
                return { data: created, error: null };
              },
            }),
          }),
          update: () => ({ eq: async () => ({ data: null, error: null }) }),
        };
      }

      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
    // El límite de tasa no es lo que este test ejercita: siempre deja pasar.
    rpc: async () => ({ data: true, error: null }),
    storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  };

  return { client, insertedMessages, getConversationRow: () => conversationRow };
}

const { client: fakeAdminClient, insertedMessages, getConversationRow } = createRacingFakeAdminClient();

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
              contacts: [{ profile: { name: "Cliente Nuevo" }, wa_id: "584129999999" }],
              messages: [
                {
                  from: "584129999999",
                  id: waMessageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "hola" },
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
  return { text: async () => raw, json: async () => body, headers: { get: () => null } } as unknown as Request;
}

let POST: typeof import("@/app/api/webhooks/whatsapp/route").POST;

// La carga en frío del grafo del webhook caía dentro del presupuesto del
// único test y bajo carga lo tumbaba (timeout 15 s reproducido 2/2 el
// 29/8/2026); en beforeAll con presupuesto propio.
beforeAll(async () => {
  ({ POST } = await import("@/app/api/webhooks/whatsapp/route"));
}, 30_000);

describe("POST /api/webhooks/whatsapp — race al crear la conversación de un contacto nuevo", () => {
  it("no descarta el mensaje: relee la conversación creada por la invocación concurrente que ganó la carrera", async () => {
    const response = await POST(fakeRequest(webhookBody("wamid.race-test-1")));

    expect(response.status).toBe(200);
    expect(insertedMessages.has("wamid.race-test-1")).toBe(true);
    expect(getConversationRow()?.id).toBe("conv-race-winner");
  });
});
