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

  // T2.1 (5/9/2026): la fila de conversación que devuelve el SELECT de
  // "¿existe ya?". Mutable y con setter/reset propios para que las pruebas
  // de reapertura (más abajo) puedan simular una conversación `closed` sin
  // afectar a las demás, que esperan la conversación abierta de siempre.
  let conversationRow = {
    id: "conv-1",
    last_customer_message_at: new Date().toISOString(),
    status: "open",
    ai_enabled: true,
    // Anexo A2 (5/9/2026): la fila por defecto trae `assigned_agent_id: null`
    // a propósito -- los casos existentes de reapertura no tienen asesor, y
    // solo el caso nuevo de "cerrada con asesor" lo pisa con `setConversationRow`.
    assigned_agent_id: null as string | null,
  };
  const conversationUpdates: { id: string; patch: Record<string, unknown> }[] = [];
  /** Cada llamada a la RPC `record_handoff`, con sus parámetros. */
  const handoffCalls: Record<string, unknown>[] = [];

  // T3.4 (5/9/2026): la lista de canales que ve resolveHealthChannel cuando
  // pide `.select("id, phone_number, status")` SIN `.eq()` -- distinto del
  // camino de siempre (`.select(...).eq("phone_number_id", ...).maybeSingle()`
  // para el mensaje entrante), que sigue devolviendo su fila fija de abajo.
  // Mutable con setter/reset propios, mismo patrón que conversationRow.
  let channelRows: { id: string; phone_number: string; status: string }[] = [
    { id: "chan-1", phone_number: "+15550001234", status: "connected" },
  ];
  const channelUpdates: { id: string; patch: Record<string, unknown> }[] = [];
  const templateUpdates: { name: string; language: string; patch: Record<string, unknown> }[] = [];

  const client = {
    from(table: string) {
      if (table === "whatsapp_channels") {
        return {
          select() {
            // Doble uso, igual que el `.update()` de `messages` más abajo: el
            // camino de siempre encadena `.eq(...).maybeSingle()`; T3.4 hace
            // `await` directo sin `.eq()` para traer la lista completa.
            return Object.assign(
              Promise.resolve({ data: channelRows.map((r) => ({ ...r })), error: null }),
              {
                eq() {
                  return {
                    maybeSingle: async () => ({
                      data: { id: "chan-1", phone_number_id: "1234567890", status: "connected" },
                      error: null,
                    }),
                  };
                },
              }
            );
          },
          update(patch: Record<string, unknown>) {
            return {
              eq: (_col: string, id: string) => {
                channelUpdates.push({ id, patch });
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }

      if (table === "templates") {
        return {
          update(patch: Record<string, unknown>) {
            return {
              eq(_col1: string, name: string) {
                return {
                  eq(_col2: string, language: string) {
                    templateUpdates.push({ name, language, patch });
                    return Promise.resolve({ data: null, error: null });
                  },
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
                      // Ventana abierta a propósito: evita que el test dependa
                      // de la lógica de bienvenida (fuera de alcance acá).
                      maybeSingle: async () => ({ data: { ...conversationRow }, error: null }),
                    };
                  },
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            return {
              eq: async (_col: string, id: string) => {
                conversationUpdates.push({ id, patch });
                // T2.1: la reapertura del webhook relee `status` en la misma
                // invocación cuando un lote trae varios mensajes del mismo
                // contacto — sin esto, el segundo mensaje del lote vería la
                // fila todavía `closed` y dispararía un segundo traspaso.
                if (typeof patch.status === "string") conversationRow.status = patch.status;
                return { data: null, error: null };
              },
            };
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
          insert(row: { whatsapp_message_id?: string; type?: string }) {
            return {
              select() {
                return {
                  single: async () => {
                    // Solo un wamid de verdad puede chocar: Postgres no
                    // considera duplicados dos NULL bajo una unique
                    // constraint, y acá pasa lo mismo con el evento de
                    // sistema de la reapertura (T2.1), que no trae
                    // whatsapp_message_id — sin este `if` colisionaría contra
                    // sí mismo entre pruebas (el Map de este cliente vive
                    // para todo el archivo, no se limpia en cada test).
                    const wamid = row.whatsapp_message_id;
                    if (wamid && insertedMessages.has(wamid)) {
                      return {
                        data: null,
                        error: {
                          code: "23505",
                          message: "duplicate key value violates unique constraint",
                        },
                      };
                    }
                    const created = { id: `msg-${nextId++}` };
                    if (wamid) insertedMessages.set(wamid, created);
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
    rpc: async (fn: string, params?: Record<string, unknown>) => {
      if (fn === "rate_limit_allow") return { data: rateLimitAllows, error: null };
      // Con la IA apagada el webhook no encola: la cola dejaba de ser el
      // reflejo de lo que la IA iba a hacer y crecía con el interruptor abajo.
      if (fn === "agent_can_run") return { data: aiCanRun, error: null };
      // T2.1: la reapertura de una conversación cerrada deja su traspaso acá.
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

  return {
    client,
    insertedMessages,
    mediaUpdates,
    conversationUpdates,
    handoffCalls,
    channelUpdates,
    templateUpdates,
    setConversationRow: (patch: Partial<typeof conversationRow>) => {
      conversationRow = { ...conversationRow, ...patch };
    },
    resetConversationRow: () => {
      conversationRow = {
        id: "conv-1",
        last_customer_message_at: new Date().toISOString(),
        status: "open",
        ai_enabled: true,
        assigned_agent_id: null,
      };
    },
    setChannelRows: (rows: { id: string; phone_number: string; status: string }[]) => {
      channelRows = rows;
    },
    resetChannelRows: () => {
      channelRows = [{ id: "chan-1", phone_number: "+15550001234", status: "connected" }];
    },
  };
}

const {
  client: fakeAdminClient,
  insertedMessages,
  mediaUpdates,
  conversationUpdates,
  handoffCalls,
  channelUpdates,
  templateUpdates,
  setChannelRows,
  resetChannelRows,
  setConversationRow,
  resetConversationRow,
} = createFakeAdminClient();

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

// 29/8/2026: bajo inanición extrema de CPU la carga en frío del grafo
// (cuatro fábricas con importOriginal) superó los 15 s del hookTimeout; el
// hook recibe presupuesto propio.
beforeAll(async () => {
  ({ POST } = await import("@/app/api/webhooks/whatsapp/route"));
  ({ enqueueAgentTurns, processAfterDebounce, DEBOUNCE_SECONDS, DEBOUNCE_SHORT_SECONDS } = await import(
    "@/lib/ai/queue"
  ));
}, 30_000);

/** Limpieza uniforme del estado compartido a nivel de módulo, antes de cada prueba. */
beforeEach(() => {
  insertedRows.length = 0;
  reactionUpdates.length = 0;
  statusUpdates.length = 0;
  conversationUpdates.length = 0;
  handoffCalls.length = 0;
  channelUpdates.length = 0;
  templateUpdates.length = 0;
  resetConversationRow();
  resetChannelRows();
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

      // Se guarda la ruta propia del CRM y no una URL del bucket: el bucket
      // es privado y una URL firmada guardada en la base vencería.
      //
      // La descarga corre en el after() mockeado (inline). Se espera el hecho —
      // la actualización del media_url — y no un tick del event loop: el tick
      // único se quedaba corto bajo carga (fallas intermitentes 28-29/8/2026).
      await vi.waitFor(
        () =>
          expect(mediaUpdates).toContainEqual({
            id: insertedRow!.id,
            mediaUrl: `/api/media/conv-1/${waMessageId}.jpg`,
          }),
        { timeout: 5000 }
      );
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

  /**
   * T3.2 (5/9/2026): antes esto guardaba una frase fija en castellano
   * ("El cliente envió un mensaje que el CRM todavía no sabe mostrar…").
   * Desde 20260905050000, `message_type` pasa a 'unsupported' con `content`
   * null y el tipo real de Meta en `payload.type` — sin inventar prosa sobre
   * algo que no se entiende. ("order" dejó de ser el caso de este test
   * porque ahora tiene su propio tratamiento, ver más abajo.)
   */
  it("un tipo que no conocemos queda con content null y el tipo real en payload", async () => {
    await POST(fakeRequest(webhookTypedBody("wamid.raro-1", { type: "poll" })));

    const fila = insertedRows.find((r) => r.whatsapp_message_id === "wamid.raro-1");
    expect(fila?.message_type).toBe("unsupported");
    expect(fila?.content).toBeNull();
    expect(fila?.payload).toEqual({ type: "poll" });
  });
});

// ---------------------------------------------------------------------------
// T3.2 (5/9/2026, migración 20260905050000): entrantes completos — botones,
// listas, pedidos, anuncios, "reproducido".
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/whatsapp — respuesta a un botón o a un ítem de lista", () => {
  it("botón (interactive.button_reply): content 'Respondió: …', customerText el título, payload con el id", async () => {
    await POST(
      fakeRequest(
        webhookTypedBody("wamid.boton-1", {
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: "btn-si", title: "Sí, me interesa" } },
        })
      )
    );

    const fila = insertedRows.find((r) => r.whatsapp_message_id === "wamid.boton-1");
    expect(fila?.message_type).toBe("interactive");
    expect(fila?.content).toBe("Respondió: Sí, me interesa");
    expect(fila?.payload).toEqual({ type: "button_reply", id: "btn-si" });
  });

  it("lista (interactive.list_reply): mismo tratamiento, con el id/título de la fila elegida", async () => {
    await POST(
      fakeRequest(
        webhookTypedBody("wamid.lista-1", {
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: "fila-3", title: "Cambio de aceite", description: "Sintético 20w50" },
          },
        })
      )
    );

    const fila = insertedRows.find((r) => r.whatsapp_message_id === "wamid.lista-1");
    expect(fila?.message_type).toBe("interactive");
    expect(fila?.content).toBe("Respondió: Cambio de aceite");
    expect(fila?.payload).toEqual({ type: "list_reply", id: "fila-3" });
  });

  it("botón de plantilla (type: button): mismo tratamiento, payload.template con el payload de la plantilla", async () => {
    await POST(
      fakeRequest(
        webhookTypedBody("wamid.boton-plantilla-1", {
          type: "button",
          button: { payload: "PLANTILLA-PAYLOAD-1", text: "Confirmar" },
        })
      )
    );

    const fila = insertedRows.find((r) => r.whatsapp_message_id === "wamid.boton-plantilla-1");
    expect(fila?.message_type).toBe("interactive");
    expect(fila?.content).toBe("Respondió: Confirmar");
    expect(fila?.payload).toEqual({ type: "button", template: "PLANTILLA-PAYLOAD-1" });
  });
});

describe("POST /api/webhooks/whatsapp — pedido del catálogo", () => {
  it("resumen en español con ítems y total; customerText es order.text cuando viene", async () => {
    await POST(
      fakeRequest(
        webhookTypedBody("wamid.pedido-1", {
          type: "order",
          order: {
            catalog_id: "catalogo-1",
            product_items: [
              { product_retailer_id: "SKU-1", quantity: 2, item_price: 10, currency: "USD" },
              { product_retailer_id: "SKU-2", quantity: 1, item_price: 5, currency: "USD" },
            ],
            text: "¿me lo pueden traer hoy?",
          },
        })
      )
    );

    const fila = insertedRows.find((r) => r.whatsapp_message_id === "wamid.pedido-1");
    expect(fila?.message_type).toBe("order");
    const contenido = String(fila?.content ?? "");
    expect(contenido).toContain("SKU-1");
    expect(contenido).toContain("SKU-2");
    expect(contenido).toContain("Total: USD 25.00");
    expect(fila?.payload).toMatchObject({ catalogId: "catalogo-1" });

    // Espera la ventana CORTA: el pedido trae un texto propio del cliente
    // ("¿me lo pueden traer hoy?"), como cualquier caption con texto.
    expect(enqueueAgentTurns).toHaveBeenCalledWith(expect.anything(), {
      debounceSeconds: DEBOUNCE_SHORT_SECONDS,
    });
  });

  it("sin order.text, customerText queda null y se espera la ventana larga (como un caption vacío)", async () => {
    await POST(
      fakeRequest(
        webhookTypedBody("wamid.pedido-2", {
          type: "order",
          order: {
            catalog_id: "catalogo-1",
            product_items: [{ product_retailer_id: "SKU-1", quantity: 1, item_price: 10, currency: "USD" }],
          },
        })
      )
    );

    expect(enqueueAgentTurns).toHaveBeenCalledWith(expect.anything(), {
      debounceSeconds: DEBOUNCE_SECONDS,
    });
  });
});

/** Lote con `context.referred_product`: el cliente respondió a un anuncio que referenciaba un producto puntual del catálogo. */
describe("POST /api/webhooks/whatsapp — producto referido de un anuncio", () => {
  it("context.referred_product se funde en el payload del mensaje, sea cual sea su tipo", async () => {
    await POST(
      fakeRequest(
        webhookTypedBody("wamid.producto-referido-1", {
          type: "text",
          text: { body: "¿cuánto cuesta esa bujía?" },
          context: {
            id: "wamid.no-existe",
            referred_product: { catalog_id: "catalogo-1", product_retailer_id: "SKU-9" },
          },
        })
      )
    );

    const fila = insertedRows.find((r) => r.whatsapp_message_id === "wamid.producto-referido-1");
    expect(fila?.payload).toEqual({
      referredProduct: { catalogId: "catalogo-1", productRetailerId: "SKU-9" },
    });
  });
});

describe("POST /api/webhooks/whatsapp — de qué anuncio vino la conversación", () => {
  it("message.referral guarda conversations.referral y deja el evento 'Llegó desde el anuncio'", async () => {
    await POST(
      fakeRequest(
        webhookTypedBody("wamid.referral-1", {
          type: "text",
          text: { body: "hola, vi su anuncio" },
          referral: {
            source_url: "https://fb.me/anuncio-1",
            source_type: "ad",
            headline: "Repuestos SBK al mejor precio",
          },
        })
      )
    );

    expect(conversationUpdates).toContainEqual(
      expect.objectContaining({
        id: "conv-1",
        patch: expect.objectContaining({
          referral: expect.objectContaining({
            headline: "Repuestos SBK al mejor precio",
            sourceUrl: "https://fb.me/anuncio-1",
          }),
        }),
      })
    );
    expect(
      insertedRows.some(
        (r) =>
          r.sender_type === "system" &&
          typeof r.content === "string" &&
          r.content.includes('Llegó desde el anuncio "Repuestos SBK al mejor precio"')
      )
    ).toBe(true);
  });
});

describe("POST /api/webhooks/whatsapp — 'played', una nota de voz reproducida", () => {
  it("guarda whatsapp_status: 'played' igual que cualquier otro estado", async () => {
    await POST(
      fakeRequest({
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "1234567890" },
                  statuses: [{ id: "wamid.nota-de-voz-1", status: "played" }],
                },
              },
            ],
          },
        ],
      })
    );

    expect(statusUpdates).toContainEqual(
      expect.objectContaining({ wamid: "wamid.nota-de-voz-1", patch: expect.objectContaining({ whatsapp_status: "played" }) })
    );
  });
});

describe("POST /api/webhooks/whatsapp — value.errors y el error del update de estados", () => {
  it("value.errors deja webhook_error_meta en el log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await POST(
        fakeRequest({
          entry: [
            {
              changes: [
                {
                  field: "messages",
                  value: {
                    metadata: { phone_number_id: "1234567890" },
                    errors: [{ code: 999, title: "Error de cuenta" }],
                  },
                },
              ],
            },
          ],
        })
      );

      const eventos = spy.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(eventos.some((e) => e.event === "webhook_error_meta" && e.codigo === 999)).toBe(true);
    } finally {
      spy.mockRestore();
    }
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

// ---------------------------------------------------------------------------
// T2.1 (5/9/2026): el cliente vuelve a escribir sobre una conversación que un
// asesor había cerrado. Antes el mensaje entraba igual, pero la fila seguía
// `status = 'closed'` -- invisible para "Pendientes" y para cualquier otra
// píldora que descuente lo cerrado. El webhook la reabre sola, ANTES de
// guardar ese mensaje, y deja el traspaso `reabierta_por_cliente`.
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/whatsapp — el cliente vuelve sobre una conversación cerrada", () => {
  it("con la IA encendida, reabre, avisa en el hilo y el traspaso vuelve a la IA", async () => {
    setConversationRow({ status: "closed", ai_enabled: true });

    const response = await POST(fakeRequest(webhookBody("wamid.reabre-con-ia-1")));

    expect(response.status).toBe(200);
    expect(conversationUpdates).toContainEqual({ id: "conv-1", patch: { status: "open" } });
    expect(
      insertedRows.some((r) => r.sender_type === "system" && r.content === "El cliente volvió a escribir")
    ).toBe(true);
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({
        p_conversation_id: "conv-1",
        p_to_kind: "ai",
        p_reason: "reabierta_por_cliente",
      })
    );
  });

  it("con la IA apagada en el chat, la deja sin dueño en vez de reactivarla sola", async () => {
    setConversationRow({ status: "closed", ai_enabled: false });

    await POST(fakeRequest(webhookBody("wamid.reabre-sin-ia-1")));

    expect(conversationUpdates).toContainEqual({ id: "conv-1", patch: { status: "open" } });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({
        p_conversation_id: "conv-1",
        p_to_kind: "unassigned",
        p_reason: "reabierta_por_cliente",
      })
    );
  });

  /**
   * Anexo A2 (5/9/2026): con la IA apagada PERO un asesor ya asignado al
   * chat, el traspaso es suyo -- `human` + su id --, no `unassigned`. Antes
   * de A2 el destino se decidía solo mirando `ai_enabled`, así que este caso
   * caía en el de arriba y una conversación con dueño quedaba en la
   * bitácora como si no lo tuviera.
   */
  it("con la IA apagada pero un asesor ya asignado, la devuelve a ESE asesor", async () => {
    setConversationRow({ status: "closed", ai_enabled: false, assigned_agent_id: "agent-7" });

    await POST(fakeRequest(webhookBody("wamid.reabre-con-asesor-1")));

    expect(conversationUpdates).toContainEqual({ id: "conv-1", patch: { status: "open" } });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({
        p_conversation_id: "conv-1",
        p_to_kind: "human",
        p_to_id: "agent-7",
        p_reason: "reabierta_por_cliente",
      })
    );
  });

  /**
   * La mutación manual prevista para esta tarea (T2.1, ver el plan): si
   * alguien quita la reapertura del webhook, este test se pone rojo en las
   * DOS aserciones que importan -- el UPDATE de `status` Y el traspaso --
   * no solo en una, para que no baste con revertir a medias.
   */
  it("una conversación abierta no dispara ningún UPDATE ni traspaso de reapertura", async () => {
    setConversationRow({ status: "open", ai_enabled: true });

    await POST(fakeRequest(webhookBody("wamid.no-reabre-1")));

    expect(conversationUpdates).toHaveLength(0);
    expect(handoffCalls.some((c) => c.p_reason === "reabierta_por_cliente")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T3.4 (5/9/2026): salud del número y estado de plantillas.
//
// Los tres payloads de acá abajo siguen el vocabulario real de Meta
// (verificado contra la documentación y ejemplos oficiales el 5/9/2026):
// `message_template_status_update` no trae número de teléfono -- una
// plantilla es de la cuenta de negocio, no de un número puntual --,
// mientras que `phone_number_quality_update` y `account_update` sí, y el
// canal se resuelve por coincidencia de dígitos contra
// `whatsapp_channels.phone_number` (fake sembrado con "+15550001234").
// ---------------------------------------------------------------------------
function webhookFieldBody(field: string, value: Record<string, unknown>) {
  return { entry: [{ changes: [{ field, value }] }] };
}

describe("POST /api/webhooks/whatsapp — estado de una plantilla", () => {
  it("una plantilla rechazada actualiza templates.status por nombre e idioma", async () => {
    const response = await POST(
      fakeRequest(
        webhookFieldBody("message_template_status_update", {
          event: "REJECTED",
          message_template_id: 1234567890123,
          message_template_name: "bienvenida_sbk",
          message_template_language: "es",
          reason: "INVALID_FORMAT",
        })
      )
    );

    expect(response.status).toBe(200);
    expect(templateUpdates).toContainEqual({
      name: "bienvenida_sbk",
      language: "es",
      patch: { status: "rejected" },
    });
  });

  it("aprobada guarda 'approved' sin dejar aviso de error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await POST(
        fakeRequest(
          webhookFieldBody("message_template_status_update", {
            event: "APPROVED",
            message_template_name: "confirmacion_pedido",
            message_template_language: "es",
          })
        )
      );

      expect(templateUpdates).toContainEqual({
        name: "confirmacion_pedido",
        language: "es",
        patch: { status: "approved" },
      });
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * PAUSED y DISABLED son las dos formas en las que Meta apaga una
   * plantilla por quejas repetidas -- el plan pide `log.error` en las dos,
   * más REJECTED (ya cubierto arriba).
   */
  it("pausada por quejas: guarda 'paused' y deja un log.error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await POST(
        fakeRequest(
          webhookFieldBody("message_template_status_update", {
            event: "PAUSED",
            message_template_name: "seguimiento_cotizacion",
            message_template_language: "es",
            reason: "NEGATIVE_FEEDBACK",
          })
        )
      );

      expect(templateUpdates).toContainEqual({
        name: "seguimiento_cotizacion",
        language: "es",
        patch: { status: "paused" },
      });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("plantilla_estado_degradado"));
    } finally {
      spy.mockRestore();
    }
  });

  it("deshabilitada: guarda 'disabled' y deja un log.error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await POST(
        fakeRequest(
          webhookFieldBody("message_template_status_update", {
            event: "DISABLED",
            message_template_name: "seguimiento_cotizacion",
            message_template_language: "es",
          })
        )
      );

      expect(templateUpdates).toContainEqual({
        name: "seguimiento_cotizacion",
        language: "es",
        patch: { status: "disabled" },
      });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("plantilla_estado_degradado"));
    } finally {
      spy.mockRestore();
    }
  });

  it("un evento sin mapeo (PENDING_DELETION) no toca templates.status", async () => {
    await POST(
      fakeRequest(
        webhookFieldBody("message_template_status_update", {
          event: "PENDING_DELETION",
          message_template_name: "promo_vieja",
          message_template_language: "es",
        })
      )
    );

    expect(templateUpdates.some((u) => u.name === "promo_vieja")).toBe(false);
  });
});

describe("POST /api/webhooks/whatsapp — calidad del número", () => {
  it("FLAGGED guarda calidad RED, el límite y deja un log.error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(
        fakeRequest(
          webhookFieldBody("phone_number_quality_update", {
            display_phone_number: "15550001234",
            event: "FLAGGED",
            current_limit: "TIER_1K",
          })
        )
      );

      expect(response.status).toBe(200);
      expect(channelUpdates).toHaveLength(1);
      expect(channelUpdates[0].id).toBe("chan-1");
      expect(channelUpdates[0].patch).toMatchObject({ quality_rating: "RED", messaging_limit: "TIER_1K" });
      expect(typeof channelUpdates[0].patch.health_updated_at).toBe("string");
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("calidad_numero_degradada"));
    } finally {
      spy.mockRestore();
    }
  });

  it("UPGRADE deriva calidad GREEN y no deja aviso de error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await POST(
        fakeRequest(
          webhookFieldBody("phone_number_quality_update", {
            display_phone_number: "15550001234",
            event: "UPGRADE",
            current_limit: "TIER_10K",
          })
        )
      );

      expect(channelUpdates[0].patch).toMatchObject({ quality_rating: "GREEN", messaging_limit: "TIER_10K" });
      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining("calidad_numero_degradada"));
    } finally {
      spy.mockRestore();
    }
  });

  it("sin canal que coincida y sin ninguno conectado, no actualiza nada", async () => {
    setChannelRows([{ id: "chan-otro", phone_number: "+58412000000", status: "disconnected" }]);

    await POST(
      fakeRequest(
        webhookFieldBody("phone_number_quality_update", {
          display_phone_number: "15550001234",
          event: "DOWNGRADE",
          current_limit: "TIER_250",
        })
      )
    );

    expect(channelUpdates).toHaveLength(0);
  });
});

describe("POST /api/webhooks/whatsapp — restricción de cuenta", () => {
  it("una restricción con número que coincide guarda account_restrictions y deja un log.error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(
        fakeRequest(
          webhookFieldBody("account_update", {
            phone_number: "15550001234",
            event: "ACCOUNT_RESTRICTION",
            restriction_info: [
              { restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: "2026-09-10T00:00:00+00:00" },
            ],
          })
        )
      );

      expect(response.status).toBe(200);
      expect(channelUpdates).toHaveLength(1);
      expect(channelUpdates[0].id).toBe("chan-1");
      expect(channelUpdates[0].patch.account_restrictions).toMatchObject({
        restriction_info: [{ restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING" }],
      });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("cuenta_whatsapp_restringida"));
    } finally {
      spy.mockRestore();
    }
  });

  it("un número sin coincidencia cae al único canal connected", async () => {
    await POST(
      fakeRequest(
        webhookFieldBody("account_update", {
          phone_number: "9999999999",
          event: "ACCOUNT_VIOLATION",
        })
      )
    );

    expect(channelUpdates).toHaveLength(1);
    expect(channelUpdates[0].id).toBe("chan-1");
  });

  it("VERIFIED_ACCOUNT no deja aviso de error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await POST(
        fakeRequest(
          webhookFieldBody("account_update", {
            phone_number: "15550001234",
            event: "VERIFIED_ACCOUNT",
          })
        )
      );

      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining("cuenta_whatsapp_restringida"));
    } finally {
      spy.mockRestore();
    }
  });
});
