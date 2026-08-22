import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/ai/agent", () => ({
  runAgentTurnsFor: vi.fn(async () => {}),
}));

vi.mock("@/lib/whatsapp/meta-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp/meta-client")>();
  return {
    ...actual,
    getMetaMediaUrl: vi.fn(async () => ({ url: "https://meta.example/file", mimeType: "image/jpeg" })),
    downloadMetaMedia: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
});

interface FakeMessageRow {
  id: string;
}

/** Lo que responde el límite de tasa; un test lo pone en false para probar el freno. */
let rateLimitAllows = true;

function createFakeAdminClient() {
  const insertedMessages = new Map<string, FakeMessageRow>();
  const mediaUpdates: { id: string; mediaUrl: string }[] = [];
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
                        // Ventana abierta a propósito: evita que el test dependa
                        // de la lógica de bienvenida (fuera de alcance acá).
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
                        error: {
                          code: "23505",
                          message: "duplicate key value violates unique constraint",
                        },
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
          update(patch: { media_url?: string }) {
            return {
              eq: async (_column: string, id: string) => {
                if (patch.media_url) mediaUpdates.push({ id, mediaUrl: patch.media_url });
                return { data: null, error: null };
              },
            };
          },
        };
      }

      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
    // El límite de tasa vive en la base; acá siempre deja pasar salvo que un
    // test diga lo contrario.
    rpc: async (fn: string) => {
      if (fn === "rate_limit_allow") return { data: rateLimitAllows, error: null };
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

  return { client, insertedMessages, mediaUpdates };
}

const { client: fakeAdminClient, insertedMessages, mediaUpdates } = createFakeAdminClient();

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

function webhookImageBody(waMessageId: string) {
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
                  type: "image",
                  image: { id: "meta-media-id-1", mime_type: "image/jpeg" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function fakeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  const raw = JSON.stringify(body);
  return {
    text: async () => raw,
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Request;
}

describe("POST /api/webhooks/whatsapp — idempotencia", () => {
  it("no duplica el mensaje ni vuelve a disparar el turno de la IA si Meta reentrega el mismo webhook", async () => {
    const { POST } = await import("@/app/api/webhooks/whatsapp/route");
    const { runAgentTurnsFor } = await import("@/lib/ai/agent");

    const waMessageId = "wamid.idempotencia-test-1";

    const first = await POST(fakeRequest(webhookBody(waMessageId)));
    expect(first.status).toBe(200);
    expect(insertedMessages.size).toBe(1);
    expect(runAgentTurnsFor).toHaveBeenCalledTimes(1);

    const second = await POST(fakeRequest(webhookBody(waMessageId)));
    expect(second.status).toBe(200);

    // La reentrega no debe insertar una segunda fila...
    expect(insertedMessages.size).toBe(1);
    // ...ni disparar un segundo turno de la IA para esa conversación.
    expect(runAgentTurnsFor).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/webhooks/whatsapp — límite de tasa", () => {
  /**
   * Se responde 200 y no 429 a propósito: un error hace que Meta reintente
   * el mismo lote, que es exactamente lo que se está tratando de frenar.
   */
  it("pasado el límite descarta el lote sin guardar nada y sin pedirle a Meta que reintente", async () => {
    rateLimitAllows = false;
    try {
      const { POST } = await import("@/app/api/webhooks/whatsapp/route");
      const waMessageId = "wamid.pasado-el-limite";
      const response = await POST(fakeRequest(webhookBody(waMessageId)));

      expect(response.status).toBe(200);
      expect(insertedMessages.has(waMessageId)).toBe(false);
    } finally {
      rateLimitAllows = true;
    }
  });
});

describe("POST /api/webhooks/whatsapp — firma de Meta", () => {
  const APP_SECRET = "test-app-secret";

  function sign(rawBody: string, secret: string): string {
    return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  }

  it("sin WHATSAPP_APP_SECRET, fuera de producción procesa el request sin exigir firma", async () => {
    const previousSecret = process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_APP_SECRET;

    try {
      const { POST } = await import("@/app/api/webhooks/whatsapp/route");
      const waMessageId = "wamid.firma-sin-secreto";
      const response = await POST(fakeRequest(webhookBody(waMessageId)));
      expect(response.status).toBe(200);
      expect(insertedMessages.has(waMessageId)).toBe(true);
    } finally {
      if (previousSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
      else process.env.WHATSAPP_APP_SECRET = previousSecret;
    }
  });

  /**
   * En producción el endpoint no puede quedar abierto por una variable que
   * alguien olvidó definir: sin secreto no hay forma de saber si el evento
   * viene de Meta, así que se rechaza en vez de procesar.
   */
  it("sin WHATSAPP_APP_SECRET, en producción rechaza con 503 y no guarda nada", async () => {
    const previousSecret = process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_APP_SECRET;
    vi.stubEnv("NODE_ENV", "production");

    try {
      const { POST } = await import("@/app/api/webhooks/whatsapp/route");
      const waMessageId = "wamid.sin-secreto-en-produccion";
      const response = await POST(fakeRequest(webhookBody(waMessageId)));
      expect(response.status).toBe(503);
      expect(insertedMessages.has(waMessageId)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      if (previousSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
      else process.env.WHATSAPP_APP_SECRET = previousSecret;
    }
  });

  it("con WHATSAPP_APP_SECRET configurado y firma válida, procesa el request", async () => {
    const previousSecret = process.env.WHATSAPP_APP_SECRET;
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;

    try {
      const { POST } = await import("@/app/api/webhooks/whatsapp/route");
      const waMessageId = "wamid.firma-valida";
      const body = webhookBody(waMessageId);
      const signature = sign(JSON.stringify(body), APP_SECRET);

      const response = await POST(fakeRequest(body, { "x-hub-signature-256": signature }));
      expect(response.status).toBe(200);
      expect(insertedMessages.has(waMessageId)).toBe(true);
    } finally {
      if (previousSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
      else process.env.WHATSAPP_APP_SECRET = previousSecret;
    }
  });

  it("con WHATSAPP_APP_SECRET configurado y sin header de firma, rechaza con 401 y no guarda nada", async () => {
    const previousSecret = process.env.WHATSAPP_APP_SECRET;
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;

    try {
      const { POST } = await import("@/app/api/webhooks/whatsapp/route");
      const waMessageId = "wamid.firma-ausente";
      const response = await POST(fakeRequest(webhookBody(waMessageId)));
      expect(response.status).toBe(401);
      expect(insertedMessages.has(waMessageId)).toBe(false);
    } finally {
      if (previousSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
      else process.env.WHATSAPP_APP_SECRET = previousSecret;
    }
  });

  it("con WHATSAPP_APP_SECRET configurado y firma inválida, rechaza con 401 y no guarda nada", async () => {
    const previousSecret = process.env.WHATSAPP_APP_SECRET;
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;

    try {
      const { POST } = await import("@/app/api/webhooks/whatsapp/route");
      const waMessageId = "wamid.firma-invalida";
      const body = webhookBody(waMessageId);

      const response = await POST(
        fakeRequest(body, { "x-hub-signature-256": "sha256=" + "0".repeat(64) })
      );
      expect(response.status).toBe(401);
      expect(insertedMessages.has(waMessageId)).toBe(false);
    } finally {
      if (previousSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
      else process.env.WHATSAPP_APP_SECRET = previousSecret;
    }
  });
});

describe("POST /api/webhooks/whatsapp — media asíncrona", () => {
  it("guarda el mensaje con media_url nulo y lo actualiza después de responder al webhook", async () => {
    const previousToken = process.env.WHATSAPP_ACCESS_TOKEN;
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";

    try {
      const { POST } = await import("@/app/api/webhooks/whatsapp/route");
      const waMessageId = "wamid.media-async-test-1";

      const response = await POST(fakeRequest(webhookImageBody(waMessageId)));
      expect(response.status).toBe(200);

      const insertedRow = insertedMessages.get(waMessageId);
      expect(insertedRow).toBeDefined();

      // La descarga corre en el after() mockeado (inline, no bloqueante) —
      // para cuando POST resuelve, el after() síncrono ya debería haber
      // encolado la tarea; esperamos un microtask para que termine.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Se guarda la ruta propia del CRM y no una URL del bucket: el bucket
      // es privado y una URL firmada guardada en la base vencería.
      expect(mediaUpdates).toContainEqual({
        id: insertedRow!.id,
        mediaUrl: `/api/media/conv-1/${waMessageId}.jpg`,
      });
    } finally {
      process.env.WHATSAPP_ACCESS_TOKEN = previousToken;
    }
  });
});
