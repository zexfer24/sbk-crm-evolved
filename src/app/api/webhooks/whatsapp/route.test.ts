import { createHmac } from "node:crypto";
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

// debounceSecondsFor es una función pura sobre el texto del mensaje: no toca
// Redis, así que se deja la de verdad — es justo lo que estas pruebas miran.
vi.mock("@/lib/ai/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/queue")>();
  return {
    DEBOUNCE_SECONDS: actual.DEBOUNCE_SECONDS,
    DEBOUNCE_SHORT_SECONDS: actual.DEBOUNCE_SHORT_SECONDS,
    debounceSecondsFor: actual.debounceSecondsFor,
    enqueueAgentTurns: vi.fn(async () => {}),
    // Sin mockear esta, el test esperaría de verdad la ventana de silencio.
    processAfterDebounce: vi.fn(async () => ({ processed: 0, failed: 0, deferred: 0 })),
  };
});

// La fábrica de arriba llama a importOriginal(), que carga el queue.ts real.
// Ese módulo importa @/lib/ai/agent (los SDK de IA + ~20 módulos) sólo para
// runAgentTurn, que este test nunca ejercita: se corta acá para que el
// primer `await import(...)` no cargue en frío ese grafo entero.
vi.mock("@/lib/ai/agent", () => ({
  runAgentTurn: vi.fn(),
}));

// Mismo motivo: queue.ts importa getRedis de acá sólo para encolar/drenar,
// que este test tiene mockeado en @/lib/ai/queue. Se saca ioredis del grafo
// y de paso delata cualquier uso inesperado: el webhook no debe tocar Redis.
vi.mock("@/lib/redis", () => ({
  getRedis: vi.fn(() => {
    throw new Error("El test del webhook no debe tocar Redis");
  }),
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
/** Los UPDATE de estado de entrega, con lo que se guardó del fallo. */
const statusUpdates: { wamid: string; patch: Record<string, unknown> }[] = [];

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
          update(patch: {
            media_url?: string;
            reaction_emoji?: string | null;
            whatsapp_status?: string;
          }) {
            return {
              eq: (column: string, id: string) => {
                if (patch.media_url) mediaUpdates.push({ id, mediaUrl: patch.media_url });
                if ("reaction_emoji" in patch) {
                  reactionUpdates.push({ column, value: id, emoji: patch.reaction_emoji ?? null });
                }
                if ("whatsapp_status" in patch) {
                  statusUpdates.push({ wamid: id, patch: patch as Record<string, unknown> });
                }

                // PostgREST devuelve un builder: se puede esperar tal cual o
                // pedirle `.select()` para recuperar las filas tocadas. El
                // webhook usa las dos formas, así que el doble también.
                return Object.assign(Promise.resolve({ data: null, error: null }), {
                  select: async () => ({
                    data: [{ id: "msg-1", conversation_id: "conv-1" }],
                    error: null,
                  }),
                });
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

// ---------------------------------------------------------------------------
// Módulos importados una sola vez para todo el archivo.
//
// El route lee WHATSAPP_APP_SECRET, NODE_ENV y WHATSAPP_ACCESS_TOKEN DENTRO
// de las funciones (route.ts ~línea 253, ~261 y ~289), no en ámbito de
// módulo — por eso las pruebas de abajo que manipulan esas variables de
// entorno (process.env, vi.stubEnv) siguen valiendo con el módulo importado
// UNA sola vez acá, en vez de con un `await import(...)` por prueba. La
// única lectura en ámbito de módulo es WHATSAPP_WEBHOOK_RATE_LIMIT (~línea
// 117), que ninguna prueba de este archivo toca.
//
// Antes había 33 `await import(...)` repartidos por las pruebas: cada uno
// reevaluaba la fábrica de vi.mock("@/lib/ai/queue", importOriginal), que
// carga el queue.ts real para quedarse sólo con tres exports puros. Ese
// costo repetido caía dentro de los timeouts de las primeras pruebas, y un
// timeout a mitad de resolver la fábrica hacía que la siguiente importación
// concurrente del mismo mock recibiera el módulo real en vez del mockeado.
let POST: typeof import("@/app/api/webhooks/whatsapp/route").POST;
let enqueueAgentTurns: typeof import("@/lib/ai/queue").enqueueAgentTurns;
let processAfterDebounce: typeof import("@/lib/ai/queue").processAfterDebounce;
let DEBOUNCE_SECONDS: typeof import("@/lib/ai/queue").DEBOUNCE_SECONDS;
let DEBOUNCE_SHORT_SECONDS: typeof import("@/lib/ai/queue").DEBOUNCE_SHORT_SECONDS;

beforeAll(async () => {
  ({ POST } = await import("@/app/api/webhooks/whatsapp/route"));
  ({ enqueueAgentTurns, processAfterDebounce, DEBOUNCE_SECONDS, DEBOUNCE_SHORT_SECONDS } = await import(
    "@/lib/ai/queue"
  ));
});

/** Limpieza uniforme del estado compartido a nivel de módulo, antes de cada prueba. */
beforeEach(() => {
  insertedRows.length = 0;
  reactionUpdates.length = 0;
  statusUpdates.length = 0;
  vi.mocked(enqueueAgentTurns).mockClear();
  vi.mocked(processAfterDebounce).mockClear();
});

describe("POST /api/webhooks/whatsapp — idempotencia", () => {
  it("no duplica el mensaje ni vuelve a disparar el turno de la IA si Meta reentrega el mismo webhook", async () => {
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

/**
 * El debounce era de seis segundos para todo el mundo, y son seis segundos
 * FIJOS delante de cada respuesta: con el objetivo de cuatro que pide el dueño
 * se comían el presupuesto entero antes de que el modelo leyera nada.
 *
 * Acá se comprueba la parte que le toca al webhook: elegir la ventana según
 * cómo venga el mensaje, y encolar y drenar cada ventana por su lado. El
 * criterio en sí vive en debounceSecondsFor y se prueba en debounce.test.ts.
 */
describe("POST /api/webhooks/whatsapp — ventana de silencio adaptativa", () => {
  /** Un lote con los textos dados, todos del mismo contacto. */
  function loteDeTextos(textos: { id: string; body: string }[]) {
    return {
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "1234567890" },
                contacts: [{ profile: { name: "Cliente Demo" }, wa_id: "584120000000" }],
                messages: textos.map(({ id, body }) => ({
                  from: "584120000000",
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body },
                })),
              },
            },
          ],
        },
      ],
    };
  }

  it("le da la ventana larga al arranque de una ráfaga", async () => {
    await POST(fakeRequest(loteDeTextos([{ id: "wamid.ventana-larga-1", body: "buenas" }])));

    expect(enqueueAgentTurns).toHaveBeenCalledWith(expect.anything(), {
      debounceSeconds: DEBOUNCE_SECONDS,
    });
    // La pasada tiene que esperar la MISMA ventana con la que se encoló, o
    // despierta antes de que el turno venza y se va con las manos vacías.
    expect(processAfterDebounce).toHaveBeenCalledWith(1, DEBOUNCE_SECONDS);
  });

  it("le da la ventana corta a una pregunta terminada", async () => {
    await POST(
      fakeRequest(
        loteDeTextos([{ id: "wamid.ventana-corta-1", body: "¿Tienen bujía para una Empire Owen?" }])
      )
    );

    expect(enqueueAgentTurns).toHaveBeenCalledWith(expect.anything(), {
      debounceSeconds: DEBOUNCE_SHORT_SECONDS,
    });
    expect(processAfterDebounce).toHaveBeenCalledWith(1, DEBOUNCE_SHORT_SECONDS);
  });

  /**
   * Meta agrupa varios mensajes en un mismo POST. Lo que decide la ventana es
   * cómo TERMINÓ la ráfaga, no cómo empezó: si el cliente arrancó con "buenas"
   * y cerró con la pregunta completa, ya no hay nada que esperar.
   */
  it("en un lote del mismo chat manda el último mensaje", async () => {
    await POST(
      fakeRequest(
        loteDeTextos([
          { id: "wamid.rafaga-1", body: "buenas" },
          { id: "wamid.rafaga-2", body: "necesito una cadena para" },
          { id: "wamid.rafaga-3", body: "una Bera BR 200, ¿cuánto cuesta?" },
        ])
      )
    );

    // Una sola conversación tocada, con la ventana del último mensaje.
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
    expect(enqueueAgentTurns).toHaveBeenCalledWith(expect.anything(), {
      debounceSeconds: DEBOUNCE_SHORT_SECONDS,
    });
  });

  /**
   * Una foto sin pie casi siempre viene seguida del "¿cuánto cuesta?".
   * Responderle a la foto sola es responder sin la pregunta.
   */
  it("espera la ventana larga con una foto sin pie", async () => {
    await POST(fakeRequest(webhookImageBody("wamid.foto-sin-pie-1")));

    expect(enqueueAgentTurns).toHaveBeenCalledWith(expect.anything(), {
      debounceSeconds: DEBOUNCE_SECONDS,
    });
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
    await POST(fakeRequest(webhookTypedBody("wamid.raro-1", { type: "order" })));

    const texto = String(insertedRows.find((r) => r.whatsapp_message_id === "wamid.raro-1")?.content ?? "");
    expect(texto).not.toContain("no soportado");
    expect(texto).not.toContain("[order]");
    expect(texto.toLowerCase()).toContain("cliente");
  });
});

// ---------------------------------------------------------------------------
// El motivo del fallo de entrega
//
// Meta manda el código y el motivo en el webhook de estado. Se estaban
// tirando: sólo se guardaba la palabra 'failed', que en la burbuja es un
// triángulo rojo sin explicación. El asesor hace lo único que un triángulo
// rojo sugiere —reintentar— cinco veces seguidas contra un número que no
// existe.
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/whatsapp — por qué no se entregó", () => {
  function estadoBody(status: string, errors?: unknown[]) {
    return {
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "1234567890" },
                statuses: [{ id: "wamid.saliente-1", status, ...(errors ? { errors } : {}) }],
              },
            },
          ],
        },
      ],
    };
  }

  it("guarda el código y el motivo cuando Meta rechaza el mensaje", async () => {
    await POST(
      fakeRequest(
        estadoBody("failed", [
          {
            code: 131026,
            title: "Message undeliverable",
            error_data: { details: "Message Undeliverable." },
          },
        ])
      )
    );

    expect(statusUpdates).toHaveLength(1);
    expect(statusUpdates[0]).toMatchObject({
      wamid: "wamid.saliente-1",
      patch: {
        whatsapp_status: "failed",
        whatsapp_error_code: 131026,
        whatsapp_error_detail: "Message Undeliverable.",
      },
    });
  });

  /**
   * Meta manda hasta tres textos y no siempre los tres. `error_data.details`
   * es el que dice algo concreto; `title` es la etiqueta de catálogo.
   */
  it("cae al texto más específico que haya venido", async () => {
    await POST(fakeRequest(estadoBody("failed", [{ code: 131047, title: "Re-engagement message" }])));

    expect(statusUpdates[0].patch).toMatchObject({
      whatsapp_error_code: 131047,
      whatsapp_error_detail: "Re-engagement message",
    });
  });

  /**
   * Un estado que no es 'failed' limpia el motivo. Si un mensaje llegara a
   * remontar, un motivo viejo colgado debajo sería peor que ninguno.
   */
  it("no deja el motivo pegado cuando el mensaje sí llegó", async () => {
    await POST(fakeRequest(estadoBody("delivered")));

    expect(statusUpdates[0].patch).toMatchObject({
      whatsapp_status: "delivered",
      whatsapp_error_code: null,
      whatsapp_error_detail: null,
    });
  });
});

// ---------------------------------------------------------------------------
// El remitente que no es un teléfono
//
// `const phoneNumber = \`+${message.from}\`` con `from` ausente produce la
// cadena '+undefined' y la guarda como número de contacto. Uno de los 1.197
// contactos quedó así: un chat que se ve, que se abre y al que es imposible
// entregarle nada.
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/whatsapp — un remitente que no es un teléfono", () => {
  function mensajeDe(from: unknown, id: string) {
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
                    ...(from === undefined ? {} : { from }),
                    id,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "buenas, ¿tienen frenos?" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  it("no guarda nada cuando el mensaje llega sin remitente", async () => {
    const response = await POST(fakeRequest(mensajeDe(undefined, "wamid.sin-remitente-1")));

    // 200 igual: a Meta no se le pide que reintente algo que no vamos a poder
    // procesar nunca.
    expect(response.status).toBe(200);
    expect(insertedRows).toHaveLength(0);
    expect(enqueueAgentTurns).not.toHaveBeenCalled();
  });

  /**
   * El identificador que destapó el caso: decodificado de los wamid de sus
   * mensajes, el emisor era 'CO.1550555583222997'. Con la línea vieja habría
   * quedado guardado como '+CO.1550555583222997'.
   */
  it("tampoco guarda un identificador de la Cloud API que no es un número", async () => {
    await POST(fakeRequest(mensajeDe("CO.1550555583222997", "wamid.remitente-raro-1")));

    expect(insertedRows).toHaveLength(0);
  });

  it("un remitente normal se sigue guardando igual", async () => {
    await POST(fakeRequest(mensajeDe("584120000000", "wamid.remitente-bueno-1")));

    expect(insertedRows).toHaveLength(1);
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
  });
});
