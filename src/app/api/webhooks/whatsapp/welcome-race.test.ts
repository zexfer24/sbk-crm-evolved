import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

// Espejo de route.test.ts y new-contact-race.test.ts (ver CLAUDE.md,
// Trampas): el importOriginal de la fábrica de @/lib/ai/queue carga los dos
// SDK de IA e ioredis con tal de leer un par de constantes puras. Se cortan
// acá para que el primer `await import(...)` no arrastre ese grafo entero.
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

// Mismo motivo: queue.ts importa getRedis de acá sólo para encolar/drenar.
// El webhook no debe tocar Redis directamente: si lo intenta, que lo delate.
vi.mock("@/lib/redis", () => ({
  getRedis: vi.fn(() => {
    throw new Error("El test del webhook no debe tocar Redis");
  }),
}));

// Se conserva la clase real MetaApiError (el catch de sendWelcome distingue
// por `instanceof`) y se espía sendWhatsappTemplate, que es lo único que
// estas pruebas necesitan controlar.
vi.mock("@/lib/whatsapp/meta-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp/meta-client")>();
  return {
    ...actual,
    sendWhatsappTemplate: vi.fn(async () => ({ whatsappMessageId: "wamid.bienvenida-enviada" })),
  };
});

interface FakeConversationRow {
  id: string;
  last_customer_message_at: string | null;
  welcome_sent_at: string | null;
}

/**
 * Fake de `conversations` con reclamo sincrónico (check-and-set) para
 * `claimWelcome`: mismo mecanismo que un UPDATE condicional real bajo READ
 * COMMITTED, sin el `await` intermedio que abriría una ventana de carrera
 * que el fake sí podría colar y el Postgres real no.
 */
function createWelcomeRaceFakeAdminClient() {
  let conversationRow: FakeConversationRow | null = null;
  // Cuántas veces el próximo SELECT de `conversations` debe fingir que no
  // hay fila todavía, aunque ya exista -- así se fuerza la ventana de carrera
  // de dos invocaciones "concurrentes" sin depender del orden real en que el
  // event loop las intercala.
  let selectMisses = 0;
  let nextMsgId = 1;
  const insertedMessages = new Map<string, { id: string }>();
  const templateRows: Record<string, unknown>[] = [];

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
                  if (selectMisses > 0) {
                    selectMisses--;
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
                  // Otra invocación "concurrente" ya ganó la carrera y creó
                  // la fila -- Postgres rechazaría este insert.
                  return {
                    data: null,
                    error: { code: "23505", message: "duplicate key value violates unique constraint" },
                  };
                }
                conversationRow = { id: "conv-1", last_customer_message_at: null, welcome_sent_at: null };
                return { data: { id: "conv-1" }, error: null };
              },
            }),
          }),
          // El webhook usa `.update(...).eq(...)` de dos formas distintas:
          //   1. claimWelcome:  .eq(...).or(filtro).select("id")   (el reclamo)
          //   2. el rollback:   .eq(...)                           (await directo)
          // El objeto que devuelve `.eq()` tiene que servir para las dos: un
          // `.or()` encadenable y, a la vez, ser "thenable" para el segundo
          // caso -- SIN ejecutar el `.then` cuando lo que sigue es `.or()`.
          update: (patch: { welcome_sent_at: string | null }) => ({
            eq: () => ({
              or: (filterExpr: string) => ({
                select: async () => {
                  if (!conversationRow) return { data: [], error: null };
                  const match = filterExpr.match(/welcome_sent_at\.lt\."([^"]+)"/);
                  const staleCutoff = match ? match[1] : null;
                  const eligible =
                    conversationRow.welcome_sent_at === null ||
                    (staleCutoff !== null && conversationRow.welcome_sent_at < staleCutoff);
                  if (!eligible) return { data: [], error: null };
                  conversationRow.welcome_sent_at = patch.welcome_sent_at;
                  return { data: [{ id: conversationRow.id }], error: null };
                },
              }),
              then: (resolve: (value: { data: null; error: null }) => void) => {
                if (conversationRow) conversationRow.welcome_sent_at = patch.welcome_sent_at;
                resolve({ data: null, error: null });
              },
            }),
          }),
        };
      }

      if (table === "messages") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          // La fila de la bienvenida se inserta con `await insert(...)` a
          // secas -- sin `.select().single()`, porque a sendWelcome no le
          // hace falta el id de vuelta. El mensaje entrante sí encadena
          // `.select("id").single()`. El objeto de acá tiene que servir para
          // las dos formas: resolverse solo si se hace `await` directo
          // (`.then`) y también responder a `.select().single()`.
          insert: (row: Record<string, unknown>) => {
            const wamid = row.whatsapp_message_id as string | undefined;
            const isDup = Boolean(wamid && insertedMessages.has(wamid));
            let created: { id: string } | null = null;
            if (!isDup) {
              created = { id: `msg-${nextMsgId++}` };
              if (wamid) insertedMessages.set(wamid, created);
              if (row.message_type === "template") templateRows.push(row);
            }
            const result = isDup
              ? { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }
              : { data: created, error: null };
            return {
              select: () => ({ single: async () => result }),
              then: (resolve: (value: typeof result) => void) => resolve(result),
            };
          },
        };
      }

      throw new Error(`Fake Supabase: tabla no soportada en este test: ${table}`);
    },
    // El límite de tasa y el interruptor global no son lo que se ejercita
    // acá: siempre dejan pasar.
    rpc: async () => ({ data: true, error: null }),
    storage: {
      from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }),
    },
  };

  return {
    client,
    getConversationRow: () => conversationRow,
    seedConversation: (row: FakeConversationRow) => {
      conversationRow = row;
    },
    setSelectMisses: (n: number) => {
      selectMisses = n;
    },
    templateRows,
    insertedMessages,
    reset: () => {
      conversationRow = null;
      selectMisses = 0;
      nextMsgId = 1;
      insertedMessages.clear();
      templateRows.length = 0;
    },
  };
}

const fake = createWelcomeRaceFakeAdminClient();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake.client,
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
                  text: { body: "hola, buenas" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Un lote con varios mensajes del MISMO contacto, como cuando Meta los agrupa. */
function webhookBodyMultiple(waMessageIds: string[]) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "1234567890" },
              contacts: [{ profile: { name: "Cliente Nuevo" }, wa_id: "584129999999" }],
              messages: waMessageIds.map((id) => ({
                from: "584129999999",
                id,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: "hola" },
              })),
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
let sendWhatsappTemplate: typeof import("@/lib/whatsapp/meta-client").sendWhatsappTemplate;
let MetaApiError: typeof import("@/lib/whatsapp/meta-client").MetaApiError;

// La carga en frío del grafo del webhook (cuatro fábricas con importOriginal)
// cae dentro del presupuesto de la primera prueba y bajo carga lo tumba: en
// beforeAll con presupuesto propio, igual que route.test.ts y
// new-contact-race.test.ts (29/8/2026).
beforeAll(async () => {
  ({ POST } = await import("@/app/api/webhooks/whatsapp/route"));
  ({ sendWhatsappTemplate, MetaApiError } = await import("@/lib/whatsapp/meta-client"));
}, 30_000);

beforeEach(() => {
  fake.reset();
  vi.mocked(sendWhatsappTemplate).mockClear();
  vi.mocked(sendWhatsappTemplate).mockResolvedValue({ whatsappMessageId: "wamid.bienvenida-enviada" });
  vi.stubEnv("WHATSAPP_WELCOME_TEMPLATE", "bienvenida_sbk");
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/webhooks/whatsapp — la bienvenida se reclama en la base", () => {
  it("dos POSTs concurrentes de un contacto nuevo mandan UNA sola bienvenida", async () => {
    // Ambas invocaciones deben fallar su lectura inicial de `conversations`:
    // así se simula que ninguna ve todavía la fila que crea la otra.
    fake.setSelectMisses(2);

    const [first, second] = await Promise.all([
      POST(fakeRequest(webhookBody("wamid.concurrente-1"))),
      POST(fakeRequest(webhookBody("wamid.concurrente-2"))),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Los dos mensajes del cliente se guardaron -- ninguno se perdió por la
    // carrera de creación de la conversación (esa parte ya la cubre
    // new-contact-race.test.ts; acá lo que importa es la bienvenida).
    expect(fake.insertedMessages.has("wamid.concurrente-1")).toBe(true);
    expect(fake.insertedMessages.has("wamid.concurrente-2")).toBe(true);

    expect(sendWhatsappTemplate).toHaveBeenCalledTimes(1);
    expect(fake.templateRows).toHaveLength(1);
  });

  it("dos mensajes del mismo contacto en el mismo lote mandan una sola bienvenida", async () => {
    // La garantía que antes daba el Set en memoria del POST, ahora sostenida
    // por welcome_sent_at: el segundo mensaje del lote vuelve a calcular
    // windowWasClosed=true (misma conversación recién creada, sin
    // last_customer_message_at todavía) y vuelve a llamar a sendWelcome --
    // claimWelcome es quien lo corta la segunda vez.
    const response = await POST(fakeRequest(webhookBodyMultiple(["wamid.lote-1", "wamid.lote-2"])));

    expect(response.status).toBe(200);
    expect(fake.insertedMessages.has("wamid.lote-1")).toBe(true);
    expect(fake.insertedMessages.has("wamid.lote-2")).toBe(true);

    expect(sendWhatsappTemplate).toHaveBeenCalledTimes(1);
    expect(fake.templateRows).toHaveLength(1);
  });

  it("el cliente que vuelve tras 24 h sí recibe otra bienvenida", async () => {
    const haceTreintaHoras = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    fake.seedConversation({
      id: "conv-1",
      last_customer_message_at: haceTreintaHoras,
      welcome_sent_at: haceTreintaHoras,
    });

    const response = await POST(fakeRequest(webhookBody("wamid.reengancha-1")));

    expect(response.status).toBe(200);
    expect(sendWhatsappTemplate).toHaveBeenCalledTimes(1);
    expect(fake.templateRows).toHaveLength(1);
    // El sello quedó resellado con la fecha nueva, no con la de hace 30 h.
    expect(fake.getConversationRow()?.welcome_sent_at).not.toBe(haceTreintaHoras);
  });

  it("si Meta rechaza la plantilla, la bienvenida no queda sellada", async () => {
    vi.mocked(sendWhatsappTemplate).mockRejectedValueOnce(
      new MetaApiError("Plantilla no aprobada por Meta", 400, { error: { code: 132001 } })
    );

    const response = await POST(fakeRequest(webhookBody("wamid.rechazo-meta-1")));

    expect(response.status).toBe(200);
    expect(sendWhatsappTemplate).toHaveBeenCalledTimes(1);
    // No salió nada: no hay fila de plantilla, y el sello se devuelve a null
    // para que el próximo mensaje del cliente pueda reintentar.
    expect(fake.templateRows).toHaveLength(0);
    expect(fake.getConversationRow()?.welcome_sent_at).toBeNull();
  });
});
