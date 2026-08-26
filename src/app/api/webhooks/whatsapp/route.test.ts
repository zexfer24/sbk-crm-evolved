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

vi.mock("@/lib/ai/queue", () => ({
  enqueueAgentTurns: vi.fn(async () => {}),
  // Sin mockear esta, el test esperaría de verdad la ventana de silencio.
  processAfterDebounce: vi.fn(async () => ({ processed: 0, failed: 0, deferred: 0 })),
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

/** Filas completas que llegaron a `messages.insert`, para poder mirar qué se guardó. */
const insertedRows: Record<string, unknown>[] = [];

/** UPDATE de reacción: por qué columna se buscó, con qué valor, y qué emoji se puso. */
const reactionUpdates: { column: string; value: string; emoji: string | null }[] = [];

/** Lo que responde el límite de tasa; un test lo pone en false para probar el freno. */
let rateLimitAllows = true;
/** El interruptor global. Se apaga en el test que comprueba que no se encola nada. */
let aiCanRun = true;

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
          insert(row: { whatsapp_message_id: string; type?: string }) {
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
                    insertedRows.push(row as unknown as Record<string, unknown>);
                    return { data: created, error: null };
                  },
                };
              },
            };
          },
          update(patch: { media_url?: string; reaction_emoji?: string | null }) {
            return {
              eq: async (column: string, id: string) => {
                if (patch.media_url) mediaUpdates.push({ id, mediaUrl: patch.media_url });
                if ("reaction_emoji" in patch) {
                  reactionUpdates.push({ column, value: id, emoji: patch.reaction_emoji ?? null });
                }
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
      // Con la IA apagada el webhook no encola: la cola dejaba de ser el
      // reflejo de lo que la IA iba a hacer y crecía con el interruptor abajo.
      if (fn === "agent_can_run") return { data: aiCanRun, error: null };
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
    const { enqueueAgentTurns } = await import("@/lib/ai/queue");

    const waMessageId = "wamid.idempotencia-test-1";

    const first = await POST(fakeRequest(webhookBody(waMessageId)));
    expect(first.status).toBe(200);
    expect(insertedMessages.size).toBe(1);
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);

    const second = await POST(fakeRequest(webhookBody(waMessageId)));
    expect(second.status).toBe(200);

    // La reentrega no debe insertar una segunda fila...
    expect(insertedMessages.size).toBe(1);
    // ...ni volver a encolar un turno para esa conversación.
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/webhooks/whatsapp — interruptor global", () => {
  /**
   * Con la IA apagada, el webhook seguía encolando en cada mensaje entrante.
   * Esos turnos se reclamaban después para salir por la puerta de atrás de
   * runAgentTurn sin dejar rastro, y mientras tanto la cola crecía con el
   * interruptor abajo — así que el dueño creía tener la IA parada y la cola
   * decía otra cosa. Peor si alguien encendía: salía todo de golpe.
   */
  it("no encola nada con la IA apagada, pero sigue guardando el mensaje", async () => {
    const { POST } = await import("@/app/api/webhooks/whatsapp/route");
    const { enqueueAgentTurns } = await import("@/lib/ai/queue");
    vi.mocked(enqueueAgentTurns).mockClear();

    aiCanRun = false;
    try {
      const response = await POST(fakeRequest(webhookBody("wamid.ia-apagada-1")));

      expect(response.status).toBe(200);
      // El mensaje del cliente se guarda igual: la bandeja lo tiene que ver.
      expect(insertedMessages.has("wamid.ia-apagada-1")).toBe(true);
      expect(enqueueAgentTurns).not.toHaveBeenCalled();
    } finally {
      aiCanRun = true;
    }
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

/**
 * Lote tal como lo manda Meta cuando el cliente envía varias fotos juntas:
 * un mensaje `unsupported` —el aviso propio de Meta de que hay algo que su
 * API no sabe representar, con su array `errors`— y detrás las fotos, que
 * llegan perfectamente.
 */
function webhookAlbumBody(prefijo: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
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
                  id: `${prefijo}-unsupported`,
                  timestamp,
                  type: "unsupported",
                  errors: [
                    {
                      code: 131051,
                      title: "Message type unknown",
                      message: "Message type is not currently supported",
                    },
                  ],
                },
                {
                  from: "584120000000",
                  id: `${prefijo}-foto-1`,
                  timestamp,
                  type: "image",
                  image: { id: "media-1", mime_type: "image/jpeg" },
                },
                {
                  from: "584120000000",
                  id: `${prefijo}-foto-2`,
                  timestamp,
                  type: "image",
                  image: { id: "media-2", mime_type: "image/jpeg" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("POST /api/webhooks/whatsapp — el aviso 'unsupported' de Meta", () => {
  it("no ensucia el chat con jerga técnica, y las fotos del lote sí se guardan", async () => {
    const { POST } = await import("@/app/api/webhooks/whatsapp/route");
    insertedRows.length = 0;

    const response = await POST(fakeRequest(webhookAlbumBody("wamid.album-1")));
    expect(response.status).toBe(200);

    // Las dos fotos llegan enteras.
    expect(insertedMessages.has("wamid.album-1-foto-1")).toBe(true);
    expect(insertedMessages.has("wamid.album-1-foto-2")).toBe(true);

    // El aviso de Meta no es un mensaje del cliente: no se guarda como tal.
    expect(insertedMessages.has("wamid.album-1-unsupported")).toBe(false);
    const textos = insertedRows.map((r) => String(r.content ?? ""));
    expect(textos.some((t) => t.includes("no soportado"))).toBe(false);
  });
});

/** Lote con una reacción, tal como la manda Meta: evento aparte con a qué mensaje y con qué emoji. */
function webhookReactionBody(waMessageId: string, emoji: string, reaccionadoId: string) {
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
                  type: "reaction",
                  reaction: { message_id: reaccionadoId, emoji },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("POST /api/webhooks/whatsapp — reacciones con emoji", () => {
  it("pega el emoji al mensaje al que reacciona, sin ensuciar el hilo con un mensaje nuevo", async () => {
    const { POST } = await import("@/app/api/webhooks/whatsapp/route");
    reactionUpdates.length = 0;
    insertedRows.length = 0;

    const response = await POST(
      fakeRequest(webhookReactionBody("wamid.reaccion-1", "👍", "wamid.mensaje-nuestro"))
    );
    expect(response.status).toBe(200);

    expect(reactionUpdates).toEqual([
      { column: "whatsapp_message_id", value: "wamid.mensaje-nuestro", emoji: "👍" },
    ]);

    // Una reacción no es un mensaje: no aparece como burbuja en la conversación.
    expect(insertedMessages.has("wamid.reaccion-1")).toBe(false);
    const textos = insertedRows.map((r) => String(r.content ?? ""));
    expect(textos.some((t) => t.includes("no soportado"))).toBe(false);
  });

  it("quitar la reacción la borra, en vez de dejar el emoji viejo pegado", async () => {
    const { POST } = await import("@/app/api/webhooks/whatsapp/route");
    reactionUpdates.length = 0;

    // Meta manda el retiro como una reacción con el emoji vacío.
    await POST(fakeRequest(webhookReactionBody("wamid.reaccion-2", "", "wamid.mensaje-nuestro")));

    expect(reactionUpdates).toEqual([
      { column: "whatsapp_message_id", value: "wamid.mensaje-nuestro", emoji: null },
    ]);
  });
});

function webhookTypedBody(waMessageId: string, extra: Record<string, unknown>) {
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
                  ...extra,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * Un cliente que manda su ubicación está diciendo dónde entregarle. Que eso
 * llegue como "[location] Tipo de mensaje no soportado todavía" es perder el
 * dato y encima dejar al asesor sin saber que hay algo que mirar.
 */
describe("POST /api/webhooks/whatsapp — ubicación y otros tipos", () => {
  it("la ubicación llega con su enlace al mapa, no como jerga", async () => {
    const { POST } = await import("@/app/api/webhooks/whatsapp/route");
    insertedRows.length = 0;

    await POST(
      fakeRequest(
        webhookTypedBody("wamid.ubicacion-1", {
          type: "location",
          location: { latitude: 10.0678, longitude: -69.3467, name: "Casa", address: "Av. Lara" },
        })
      )
    );

    const fila = insertedRows.find((r) => r.whatsapp_message_id === "wamid.ubicacion-1");
    const texto = String(fila?.content ?? "");
    expect(texto).not.toContain("no soportado");
    expect(texto).toContain("10.0678");
    expect(texto).toContain("-69.3467");
    expect(texto).toContain("Casa");
    // Con el enlace, tocarlo abre el mapa en vez de tener que copiar números.
    expect(texto).toMatch(/https:\/\/(www\.)?google\.com\/maps/);
  });

  it("una ubicación sin nombre igual llega con sus coordenadas", async () => {
    const { POST } = await import("@/app/api/webhooks/whatsapp/route");
    insertedRows.length = 0;

    await POST(
      fakeRequest(
        webhookTypedBody("wamid.ubicacion-2", {
          type: "location",
          location: { latitude: 10.5, longitude: -69.5 },
        })
      )
    );

    const texto = String(insertedRows.find((r) => r.whatsapp_message_id === "wamid.ubicacion-2")?.content ?? "");
    expect(texto).not.toContain("no soportado");
    expect(texto).toContain("10.5");
  });

  it("un tipo que no conocemos se explica en castellano, sin corchetes técnicos", async () => {
    const { POST } = await import("@/app/api/webhooks/whatsapp/route");
    insertedRows.length = 0;

    await POST(fakeRequest(webhookTypedBody("wamid.raro-1", { type: "order" })));

    const texto = String(insertedRows.find((r) => r.whatsapp_message_id === "wamid.raro-1")?.content ?? "");
    expect(texto).not.toContain("no soportado");
    expect(texto).not.toContain("[order]");
    expect(texto.toLowerCase()).toContain("cliente");
  });
});
