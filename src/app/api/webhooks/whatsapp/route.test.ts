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
/**
 * El error que devolvería la RPC `rate_limit_allow` si la base está caída.
 * Corrección hallada en la verificación a mano del orquestador (22/9/2026):
 * un error de esta RPC deja `allowed` en `null`, no en `false`, así que el
 * `if (allowed === false)` de route.ts no descarta el lote -- el test que lo
 * prueba pone esto y deja `rateLimitAllows` en `true` (la RPC ni siquiera
 * llegó a contestar), mismo patrón que `aiCanRunError`.
 */
let rateLimitAllowError: { message: string } | null = null;
/** El interruptor global. Se apaga en el test que comprueba que no se encola nada. */
let aiCanRun = true;
/**
 * El error que devolvería la RPC `agent_can_run` si la base está caída o la
 * red se corta. Corrección del 14/9/2026 (extensión de la Decisión 7 del
 * plan "La voz cercana y la espera visible" a este sitio): un error de la
 * RPC no es un `false` -- el test que lo prueba pone esto y deja `aiCanRun`
 * en `true` (la RPC ni siquiera llegó a contestar).
 */
let aiCanRunError: { message: string } | null = null;

function createFakeAdminClient() {
  const insertedMessages = new Map<string, FakeMessageRow>();
  const mediaUpdates: { id: string; mediaUrl: string }[] = [];
  // Tarea 6 (15/9/2026): las rutas con las que se subió cada archivo, para
  // poder comprobar la extensión real sin depender de `mediaUpdates` (esa
  // solo confirma el UPDATE de `media_url`, no el nombre subido a Storage).
  const uploadedPaths: string[] = [];
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
  /**
   * T2b, plan "Seba atiende el mostrador" (18/9/2026): cuántas lecturas más
   * del SELECT de "¿existe ya?" deben devolver `status: "closed"` aunque
   * `conversationRow.status` ya haya cambiado -- ver el comentario en
   * `maybeSingle`, más abajo. `0` de fábrica: por defecto cada SELECT ve el
   * estado real, como antes de esta tarea.
   */
  let forceStaleClosedReads = 0;
  /**
   * Tarea C4 (Tanda 1, "El resguardo antes del push", 20/9/2026): fuerza un
   * error en la consulta que comprueba, ANTES de reabrir un chat cerrado, si
   * el wamid del mensaje entrante ya está guardado. `false` de fábrica: por
   * defecto la consulta contesta bien, mirando `insertedMessages` de verdad.
   */
  let forceMessageLookupError = false;
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
  /**
   * Corrección hallada en la verificación a mano del orquestador (22/9/2026,
   * "apagar PostgREST durante un POST al webhook local"): fuerza el
   * `.eq("phone_number_id", …).maybeSingle()` del canal -- la PRIMERA
   * lectura del lote -- a devolver un error, para probar
   * `webhook_canal_no_consultable`. `null` de fábrica: por defecto ve el
   * canal fijo de siempre.
   */
  let forceChannelLookupError: { code?: string; message: string } | null = null;
  /** Simula "no hay canal registrado" (`data: null, error: null`) sin depender de que el fake mire el `phoneNumberId` real -- lo ignora, igual que antes de esta tarea. */
  let forceChannelNotFound = false;

  // T-S1 (6/9/2026): el contacto por defecto es el mismo remitente de
  // `webhookBody`/`webhookSystemBody` (+584120000000) con `id: "contact-1"`,
  // así que el resto del archivo -- que nunca toca `type: "system"` -- no
  // necesita saber que esta tabla ahora también admite `select`/`update`.
  let contactRows: { id: string; phone_number: string }[] = [{ id: "contact-1", phone_number: "+584120000000" }];
  const contactUpdates: { id: string; patch: Record<string, unknown> }[] = [];
  /** Fuerza el UPDATE de `contacts` a devolver 23505, para simular la carrera del punto D2. */
  let contactUpdateConflict = false;

  // -------------------------------------------------------------------------
  // T2, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026).
  //
  // Hasta esta tarea el fake solo conocía UNA conversación ("conv-1", del
  // contacto "contact-1" de fábrica): el SELECT de "¿existe ya?" devolvía
  // siempre esa misma fila sin mirar el `contact_id`, así que la rama de
  // conversación NUEVA de route.ts (el `.insert()`) no tenía NINGÚN test.
  // `otherConversations`/`contactToConversationId` modelan conversaciones
  // adicionales creadas DURANTE un test (un segundo contacto en el mismo
  // lote, o el camino feliz de "conversación nueva"); "conv-1" sigue
  // resuelta aparte, contra la `conversationRow` mutable de siempre, para no
  // tocar el comportamiento de ningún test que ya existía.
  // -------------------------------------------------------------------------
  const otherConversations = new Map<
    string,
    { id: string; last_customer_message_at: string | null; status: string; ai_enabled: boolean; assigned_agent_id: string | null }
  >();
  const contactToConversationId = new Map<string, string>();
  let nextOtherConversationSeq = 2;
  /** Fuerza el upsert de `contacts` a fallar para un teléfono puntual (contacto ~1048 de route.ts). */
  let forceContactUpsertErrorFor: { phone: string; error: { code?: string; message: string } } | null = null;
  /** Fuerza el insert de `conversations` a fallar para un contacto puntual (conversación ~1220 de route.ts). */
  let forceConversationInsertErrorFor: { contactId: string; error: { code?: string; message: string } } | null = null;
  /** Fuerza el insert de `messages` a fallar para un wamid puntual (mensaje ~1419 de route.ts). */
  const forceMessageInsertErrorFor = new Map<string, { code?: string; message: string }>();
  /** Fuerza el UPDATE de whatsapp_status a fallar (webhook_error_actualizar_estado). */
  let forceStatusUpdateError: { code?: string; message: string } | null = null;

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
                    maybeSingle: async () => {
                      if (forceChannelLookupError) {
                        return { data: null, error: forceChannelLookupError };
                      }
                      if (forceChannelNotFound) {
                        return { data: null, error: null };
                      }
                      return {
                        data: { id: "chan-1", phone_number_id: "1234567890", status: "connected" },
                        error: null,
                      };
                    },
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
          // T2, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026):
          // antes esto ignoraba el `row` entero y devolvía siempre "contact-1"
          // -- ningún test podía tener un SEGUNDO contacto/conversación en el
          // mismo lote (hacía falta para probar que el turno de la OTRA
          // conversación se encola aunque otro mensaje del lote no se haya
          // podido guardar). Ahora busca-o-crea por teléfono, como el upsert
          // real, y respeta `forceContactUpsertErrorFor` para simular un
          // corte de la base en ese paso puntual.
          upsert(row: { phone_number: string }) {
            return {
              select() {
                return {
                  single: async () => {
                    if (forceContactUpsertErrorFor && forceContactUpsertErrorFor.phone === row.phone_number) {
                      return { data: null, error: forceContactUpsertErrorFor.error };
                    }
                    const existing = contactRows.find((r) => r.phone_number === row.phone_number);
                    if (existing) return { data: { id: existing.id }, error: null };
                    const id = `contact-${contactRows.length + 1}`;
                    contactRows.push({ id, phone_number: row.phone_number });
                    return { data: { id }, error: null };
                  },
                };
              },
            };
          },
          // T-S1 (6/9/2026, "El cliente que cambió de número"): handleSystemMessage
          // busca contactos por teléfono (el viejo, y el nuevo para detectar
          // conflicto) en vez de upsertarlos. `contactRows` es mutable con
          // setter/reset propios, mismo patrón que conversationRow/channelRows.
          select() {
            return {
              eq(_col: string, phone: string) {
                return {
                  maybeSingle: async () => {
                    const row = contactRows.find((r) => r.phone_number === phone);
                    return { data: row ? { id: row.id } : null, error: null };
                  },
                };
              },
            };
          },
          update(patch: { phone_number?: string }) {
            return {
              eq: async (_col: string, id: string) => {
                contactUpdates.push({ id, patch });
                if (contactUpdateConflict) {
                  return { data: null, error: { code: "23505", message: "duplicate key value" } };
                }
                if (patch.phone_number) {
                  const row = contactRows.find((r) => r.id === id);
                  if (row) row.phone_number = patch.phone_number;
                }
                return { data: null, error: null };
              },
            };
          },
        };
      }

      if (table === "conversations") {
        return {
          select() {
            return {
              // T2, plan "Nada se pierde en un corte ni en un deploy"
              // (21-22/9/2026): antes este SELECT devolvía SIEMPRE la misma
              // `conversationRow` sin mirar `contact_id` -- ningún test podía
              // ejercitar la rama de "conversación nueva" (el `.insert()` de
              // route.ts, más abajo), que hasta esta tarea no tenía NINGUNA
              // cobertura. Con un `contactId` distinto de "contact-1" (el
              // contacto por defecto) busca en `contactToConversationId`; sin
              // fila todavía, `data: null` -- exactamente lo que hace que
              // route.ts entre a crear una conversación nueva.
              eq(_col1: string, contactId: string) {
                return {
                  eq() {
                    return {
                      // Ventana abierta a propósito: evita que el test dependa
                      // de la lógica de bienvenida (fuera de alcance acá).
                      maybeSingle: async () => {
                        if (contactId !== "contact-1") {
                          const convId = contactToConversationId.get(contactId);
                          if (!convId) return { data: null, error: null };
                          return { data: { ...otherConversations.get(convId) }, error: null };
                        }
                        // T2b, plan "Seba atiende el mostrador" (18/9/2026):
                        // `forceStaleClosedReads` simula la lectura VIEJA que
                        // vería un segundo webhook concurrente del mismo
                        // lote -- el SELECT real de Postgres bajo READ
                        // COMMITTED puede seguir viendo `status = 'closed'`
                        // aunque el primer UPDATE ya lo haya reabierto, hasta
                        // que ese segundo webhook intenta SU PROPIO UPDATE
                        // (que entonces sí ve la fila ya reabierta y afecta 0
                        // filas). Sin esto, el fake "auto-corrige" el estado
                        // en cada SELECT y el camino de 0 filas del reclamo
                        // nunca se ejercita.
                        if (forceStaleClosedReads > 0) {
                          forceStaleClosedReads--;
                          return { data: { ...conversationRow, status: "closed" }, error: null };
                        }
                        return { data: { ...conversationRow }, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
          // T2: la rama de conversación NUEVA de route.ts -- sin cobertura
          // hasta esta tarea porque el SELECT de arriba nunca devolvía
          // `null`. `forceConversationInsertErrorFor` simula que ESE insert
          // puntual falla (para probar `webhook_conversacion_no_creada`).
          insert(row: { contact_id: string; whatsapp_channel_id: string }) {
            return {
              select() {
                return {
                  single: async () => {
                    if (
                      forceConversationInsertErrorFor &&
                      forceConversationInsertErrorFor.contactId === row.contact_id
                    ) {
                      return { data: null, error: forceConversationInsertErrorFor.error };
                    }
                    const id = `conv-${nextOtherConversationSeq++}`;
                    otherConversations.set(id, {
                      id,
                      last_customer_message_at: null,
                      status: "open",
                      ai_enabled: true,
                      assigned_agent_id: null,
                    });
                    contactToConversationId.set(row.contact_id, id);
                    return { data: { id }, error: null };
                  },
                };
              },
            };
          },
          // T2b, plan "Seba atiende el mostrador" (18/9/2026): el webhook usa
          // `.update(...).eq(...)` de dos formas -- un `await` directo (el
          // UPDATE de `referral`, un solo `.eq()`) y el reclamo de reapertura
          // (`.eq("id", id).eq("status", "closed").select("id")`, T2b). El
          // objeto que devuelve el primer `.eq()` tiene que servir para las
          // dos: "thenable" para el `await` directo, y encadenable con un
          // segundo `.eq()` + `.select()` para el reclamo -- mismo patrón que
          // ya usa welcome-race.test.ts para `claimWelcome`.
          update(patch: Record<string, unknown>) {
            return {
              // T2: `target` generaliza este UPDATE a las conversaciones
              // NUEVAS que `insert()` (arriba) haya creado en el test -- para
              // "conv-1" sigue siendo la misma `conversationRow` mutable de
              // siempre (ningún test viejo cambia de comportamiento).
              eq: (_col1: string, id: string) => {
                const target: Record<string, unknown> =
                  id === "conv-1"
                    ? (conversationRow as unknown as Record<string, unknown>)
                    : ((otherConversations.get(id) ?? {}) as unknown as Record<string, unknown>);
                return {
                  eq: (col2: string, val2: unknown) => ({
                    select: async (_cols: string) => {
                      // El reclamo filtra por el WHERE real: si la fila ya no
                      // calza (otro webhook concurrente del mismo lote ya la
                      // reabrió), el UPDATE no afecta ninguna fila.
                      const calza = target[col2] === val2;
                      if (!calza) return { data: [], error: null };
                      conversationUpdates.push({ id, patch });
                      Object.assign(target, patch);
                      return { data: [{ id }], error: null };
                    },
                  }),
                  then: (resolve: (value: { data: null; error: null }) => void) => {
                    conversationUpdates.push({ id, patch });
                    // T2.1: la reapertura del webhook relee `status` en la
                    // misma invocación cuando un lote trae varios mensajes del
                    // mismo contacto — sin esto, el segundo mensaje del lote
                    // vería la fila todavía `closed` y dispararía un segundo
                    // traspaso. Con el reclamo (arriba) esto ya no hace falta
                    // para la reapertura, pero el UPDATE de `referral` sigue
                    // pasando por acá.
                    if (typeof patch.status === "string") target.status = patch.status as string;
                    resolve({ data: null, error: null });
                  },
                };
              },
            };
          },
        };
      }

      if (table === "messages") {
        return {
          select() {
            return {
              eq(_col: string, value: string) {
                return {
                  maybeSingle: async () => {
                    // Tarea C4 (20/9/2026): esta misma forma
                    // (`select("id").eq("whatsapp_message_id", …).maybeSingle()`)
                    // la usan DOS caminos reales -- la cita a un mensaje
                    // propio (`message.context.id`) y, desde esta tarea, la
                    // comprobación de reentrega antes de reabrir un chat
                    // cerrado -- así que reflejar `insertedMessages` de
                    // verdad sirve para los dos sin duplicar el fake.
                    if (forceMessageLookupError) {
                      return {
                        data: null,
                        error: { message: "conexión perdida al comprobar reentrega" },
                      };
                    }
                    const existente = insertedMessages.get(value);
                    return { data: existente ? { id: existente.id } : null, error: null };
                  },
                };
              },
            };
          },
          insert(row: { whatsapp_message_id?: string; type?: string }) {
            return {
              select() {
                return {
                  single: async () => {
                    // T2, plan "Nada se pierde en un corte ni en un deploy"
                    // (21-22/9/2026): un test fuerza el error de ESTE insert
                    // puntual por wamid, para simular un corte transitorio (o
                    // uno permanente) de la base al guardar el mensaje.
                    const wamid = row.whatsapp_message_id;
                    if (wamid && forceMessageInsertErrorFor.has(wamid)) {
                      return { data: null, error: forceMessageInsertErrorFor.get(wamid)! };
                    }
                    // Solo un wamid de verdad puede chocar: Postgres no
                    // considera duplicados dos NULL bajo una unique
                    // constraint, y acá pasa lo mismo con el evento de
                    // sistema de la reapertura (T2.1), que no trae
                    // whatsapp_message_id — sin este `if` colisionaría contra
                    // sí mismo entre pruebas (el Map de este cliente vive
                    // para todo el archivo, no se limpia en cada test).
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
                  select: async () => {
                    // T2 (route.test.ts:1587 lo nombraba y no lo probaba):
                    // `forceStatusUpdateError` simula que ESTE UPDATE puntual
                    // (el de whatsapp_status) falla, para probar
                    // `webhook_error_actualizar_estado`.
                    if ("whatsapp_status" in patch && forceStatusUpdateError) {
                      return { data: null, error: forceStatusUpdateError };
                    }
                    return {
                      data: [{ id: "msg-1", conversation_id: "conv-1" }],
                      error: null,
                    };
                  },
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
      if (fn === "rate_limit_allow") {
        return rateLimitAllowError ? { data: null, error: rateLimitAllowError } : { data: rateLimitAllows, error: null };
      }
      // Con la IA apagada el webhook no encola: la cola dejaba de ser el
      // reflejo de lo que la IA iba a hacer y crecía con el interruptor abajo.
      if (fn === "agent_can_run") return { data: aiCanRunError ? null : aiCanRun, error: aiCanRunError };
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
          upload: async (path: string) => {
            uploadedPaths.push(path);
            return { error: null };
          },
          getPublicUrl: () => ({ data: { publicUrl: "https://example.com/media" } }),
        };
      },
    },
  };

  return {
    client,
    insertedMessages,
    mediaUpdates,
    uploadedPaths,
    conversationUpdates,
    handoffCalls,
    channelUpdates,
    templateUpdates,
    setConversationRow: (patch: Partial<typeof conversationRow>) => {
      conversationRow = { ...conversationRow, ...patch };
    },
    setForceStaleClosedReads: (n: number) => {
      forceStaleClosedReads = n;
    },
    setForceMessageLookupError: (value: boolean) => {
      forceMessageLookupError = value;
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
    setForceChannelLookupError: (error: { code?: string; message: string } | null) => {
      forceChannelLookupError = error;
    },
    setForceChannelNotFound: (value: boolean) => {
      forceChannelNotFound = value;
    },
    contactUpdates,
    setContactRows: (rows: { id: string; phone_number: string }[]) => {
      contactRows = rows;
    },
    resetContactRows: () => {
      contactRows = [{ id: "contact-1", phone_number: "+584120000000" }];
    },
    setContactUpdateConflict: (value: boolean) => {
      contactUpdateConflict = value;
    },
    // T2: setters/reset de los cuatro puntos de inyección de fallo -- los
    // tres `continue` de pérdida (contacto/conversación/mensaje) más el
    // UPDATE de estado (webhook_error_actualizar_estado).
    setForceContactUpsertError: (phone: string, error: { code?: string; message: string } | null) => {
      forceContactUpsertErrorFor = error ? { phone, error } : null;
    },
    setForceConversationInsertError: (contactId: string, error: { code?: string; message: string } | null) => {
      forceConversationInsertErrorFor = error ? { contactId, error } : null;
    },
    setForceMessageInsertError: (wamid: string, error: { code?: string; message: string } | null) => {
      if (error) forceMessageInsertErrorFor.set(wamid, error);
      else forceMessageInsertErrorFor.delete(wamid);
    },
    setForceStatusUpdateError: (error: { code?: string; message: string } | null) => {
      forceStatusUpdateError = error;
    },
    resetExtraConversations: () => {
      otherConversations.clear();
      contactToConversationId.clear();
      nextOtherConversationSeq = 2;
      forceContactUpsertErrorFor = null;
      forceConversationInsertErrorFor = null;
      forceMessageInsertErrorFor.clear();
      forceStatusUpdateError = null;
    },
  };
}

const {
  client: fakeAdminClient,
  insertedMessages,
  mediaUpdates,
  uploadedPaths,
  conversationUpdates,
  handoffCalls,
  channelUpdates,
  templateUpdates,
  setChannelRows,
  resetChannelRows,
  setForceChannelLookupError,
  setForceChannelNotFound,
  setConversationRow,
  setForceStaleClosedReads,
  setForceMessageLookupError,
  resetConversationRow,
  contactUpdates,
  setContactRows,
  resetContactRows,
  setContactUpdateConflict,
  setForceContactUpsertError,
  setForceConversationInsertError,
  setForceMessageInsertError,
  setForceStatusUpdateError,
  resetExtraConversations,
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

/**
 * Un lote con DOS mensajes del MISMO contacto, como cuando Meta los agrupa
 * (T2b, "Seba atiende el mostrador", 18/9/2026): la prueba de que el reclamo
 * de reapertura no duplica el evento ni el traspaso necesita dos mensajes en
 * la MISMA invocación, procesados uno tras otro por el mismo bucle.
 */
function webhookBodyTwoMessages(waMessageId1: string, waMessageId2: string) {
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
                  id: waMessageId1,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "hola" },
                },
                {
                  from: "584120000000",
                  id: waMessageId2,
                  timestamp: String(Math.floor(Date.now() / 1000) + 1),
                  type: "text",
                  text: { body: "otra vez" },
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

function webhookAudioBody(waMessageId: string) {
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
                  type: "audio",
                  audio: { id: "meta-media-id-audio-1", mime_type: "audio/ogg; codecs=opus" },
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
// Tarea 6 (15/9/2026): se necesita el mock ya creado en la fábrica de arriba
// para poder pisarlo una vez con `mockResolvedValueOnce` en el test de la
// nota de voz, sin afectar al resto (que dependen del default `image/jpeg`).
let getMetaMediaUrl: typeof import("@/lib/whatsapp/meta-client").getMetaMediaUrl;

// 29/8/2026: bajo inanición extrema de CPU la carga en frío del grafo
// (cuatro fábricas con importOriginal) superó los 15 s del hookTimeout; el
// hook recibe presupuesto propio.
beforeAll(async () => {
  ({ POST } = await import("@/app/api/webhooks/whatsapp/route"));
  ({ enqueueAgentTurns, processAfterDebounce, DEBOUNCE_SECONDS, DEBOUNCE_SHORT_SECONDS } = await import(
    "@/lib/ai/queue"
  ));
  ({ getMetaMediaUrl } = await import("@/lib/whatsapp/meta-client"));
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
  contactUpdates.length = 0;
  resetConversationRow();
  setForceStaleClosedReads(0);
  setForceMessageLookupError(false);
  resetChannelRows();
  setForceChannelLookupError(null);
  setForceChannelNotFound(false);
  resetContactRows();
  setContactUpdateConflict(false);
  resetExtraConversations();
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
      // La RPC SÍ contestó (data: false): esta es la única rama que deja el
      // traspaso "nadie se hace cargo" -- ver el test siguiente, que prueba
      // que un ERROR de la RPC no cae en esta misma rama.
      expect(handoffCalls).toContainEqual(
        expect.objectContaining({ p_reason: "agente_no_puede_correr" })
      );
    } finally {
      aiCanRun = true;
    }
  });

  /**
   * Corrección del 14/9/2026 (hallazgo 10 de la auditoría final del plan "La
   * voz cercana y la espera visible": extiende su Decisión 7 -- ya aplicada
   * en `runAgentTurn`, T5 -- a este sitio, que el plan no había tocado).
   * Antes, un ERROR de `agent_can_run` (base caída, red cortada) caía en la
   * misma rama que un `false` genuino: el webhook escribía el traspaso
   * `agente_no_puede_correr` y no encolaba nada, disfrazando un corte de
   * infraestructura de interruptor apagado -- verificado a mano contra el
   * dev local renombrando la función. Ahora el webhook sigue de largo y
   * encola igual: `runAgentTurn` vuelve a preguntar al abrir el turno, y si
   * sigue sin poder consultar, lanza y la cola reintenta (T5) sin haber
   * enviado nada.
   */
  it("con la RPC en error SÍ encola (no la trata como IA apagada) y no deja el traspaso", async () => {
    aiCanRunError = { message: "connection refused" };
    try {
      const response = await POST(fakeRequest(webhookBody("wamid.interruptor-no-consultable-1")));

      expect(response.status).toBe(200);
      expect(insertedMessages.has("wamid.interruptor-no-consultable-1")).toBe(true);
      expect(enqueueAgentTurns).toHaveBeenCalled();
      expect(handoffCalls.some((c) => c.p_reason === "agente_no_puede_correr")).toBe(false);
    } finally {
      aiCanRunError = null;
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

  // Tarea 6, "La voz de mostrador con nombre propio" (15/9/2026): Meta
  // reporta las notas de voz con `audio/ogg; codecs=opus` (con parámetro),
  // no `audio/ogg` a secas -- antes de `extensionForMime` (media-extension.ts)
  // el lookup exacto nunca calzaba y toda nota de voz quedaba guardada como
  // `.bin` en Storage.
  it("guarda una nota de voz con extensión .ogg, no .bin", async () => {
    const previousToken = process.env.WHATSAPP_ACCESS_TOKEN;
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    vi.mocked(getMetaMediaUrl).mockResolvedValueOnce({
      url: "https://meta.example/audio-file",
      mimeType: "audio/ogg; codecs=opus",
    });

    try {
      const waMessageId = "wamid.media-async-audio-1";

      const response = await POST(fakeRequest(webhookAudioBody(waMessageId)));
      expect(response.status).toBe(200);

      // La descarga corre en el after() mockeado (inline), igual que en el
      // test de la foto de arriba: se espera el hecho, no un tick.
      await vi.waitFor(() => expect(uploadedPaths).toContainEqual(expect.stringMatching(/\.ogg$/)), {
        timeout: 5000,
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

/** Un lote de mensajes crudos, ya armados por cada prueba, del mismo canal. */
function webhookMixedBatch(messages: Record<string, unknown>[]) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "1234567890" },
              contacts: [{ profile: { name: "Cliente Demo" }, wa_id: "584120000000" }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

/**
 * D3, plan "El cliente que cambió de número" (6/9/2026): un `unsupported`
 * que llega SOLO -- sin ninguna foto/video/audio/documento/sticker del mismo
 * remitente en el lote -- ya no se descarta: es contenido del cliente
 * (encuesta, "ver una vez", evento...) y se guarda para que caiga en
 * "Pendientes", pero sin turno de IA (no hay texto que atender).
 */
describe("POST /api/webhooks/whatsapp — el 'unsupported' que llega solo se guarda (D3)", () => {
  it("un unsupported solo: insert inbound con content null y payload.type/code, sin encolar turno de IA", async () => {
    const response = await POST(
      fakeRequest(
        webhookMixedBatch([
          {
            from: "584120000000",
            id: "wamid.unsupported-solo-1",
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: "unsupported",
            unsupported: { type: "poll" },
            errors: [{ code: 131051, title: "Message type unknown" }],
          },
        ])
      )
    );

    expect(response.status).toBe(200);
    const fila = insertedRows.find((r) => r.whatsapp_message_id === "wamid.unsupported-solo-1");
    expect(fila).toBeDefined();
    expect(fila?.direction).toBe("inbound");
    expect(fila?.sender_type).toBe("customer");
    expect(fila?.message_type).toBe("unsupported");
    expect(fila?.content).toBeNull();
    expect(fila?.payload).toEqual({ type: "poll", code: 131051 });
    expect(enqueueAgentTurns).not.toHaveBeenCalled();
  });

  it("unsupported + foto del mismo remitente: cero inserts del unsupported, la foto se guarda y encola como siempre", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    await POST(
      fakeRequest(
        webhookMixedBatch([
          {
            from: "584120000000",
            id: "wamid.con-foto-unsupported-1",
            timestamp,
            type: "unsupported",
            unsupported: { type: "poll" },
            errors: [{ code: 131051, title: "Message type unknown" }],
          },
          {
            from: "584120000000",
            id: "wamid.con-foto-imagen-1",
            timestamp,
            type: "image",
            image: { id: "media-99", mime_type: "image/jpeg" },
          },
        ])
      )
    );

    expect(insertedMessages.has("wamid.con-foto-unsupported-1")).toBe(false);
    expect(insertedMessages.has("wamid.con-foto-imagen-1")).toBe(true);
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
  });

  it("unsupported de un remitente y texto de otro: el unsupported se guarda sin encolar por sí solo, el texto se guarda y encola", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    await POST(
      fakeRequest(
        webhookMixedBatch([
          {
            from: "584120000000",
            id: "wamid.remitente-a-unsupported-1",
            timestamp,
            type: "unsupported",
            unsupported: { type: "poll" },
            errors: [{ code: 131051, title: "Message type unknown" }],
          },
          {
            from: "584127777777",
            id: "wamid.remitente-b-texto-1",
            timestamp,
            type: "text",
            text: { body: "hola, ¿tienen bujías?" },
          },
        ])
      )
    );

    expect(insertedMessages.has("wamid.remitente-a-unsupported-1")).toBe(true);
    expect(insertedMessages.has("wamid.remitente-b-texto-1")).toBe(true);
    // Se encola por el texto -- el unsupported de A no dispara turno por sí solo.
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
  });

  it("unsupported y texto del MISMO remitente, sin multimedia: se guardan los dos y la conversación se encola una sola vez", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    await POST(
      fakeRequest(
        webhookMixedBatch([
          {
            from: "584120000000",
            id: "wamid.mismo-remitente-unsupported-1",
            timestamp,
            type: "unsupported",
            unsupported: { type: "poll" },
            errors: [{ code: 131051, title: "Message type unknown" }],
          },
          {
            from: "584120000000",
            id: "wamid.mismo-remitente-texto-1",
            timestamp,
            type: "text",
            text: { body: "también les escribo esto" },
          },
        ])
      )
    );

    expect(insertedMessages.has("wamid.mismo-remitente-unsupported-1")).toBe(true);
    expect(insertedMessages.has("wamid.mismo-remitente-texto-1")).toBe(true);
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
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

  /**
   * T2, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026): el
   * describe de arriba se llama "...y el error del update de estados" desde
   * siempre, pero nunca había probado esa segunda mitad -- el UPDATE de
   * `whatsapp_status` que puede fallar (el trigger que impide retroceder el
   * doble check, por ejemplo) quedaba sin cobertura. `webhook_error_actualizar_estado`
   * no se toca en esta tarea (con T1 debería bajar solo), pero el test que
   * faltaba sí se escribe acá.
   */
  it("un error al actualizar whatsapp_status deja webhook_error_actualizar_estado en el log, y sigue en 200", async () => {
    setForceStatusUpdateError({ message: "trigger: no se puede retroceder el estado" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(
        fakeRequest({
          entry: [
            {
              changes: [
                {
                  field: "messages",
                  value: {
                    metadata: { phone_number_id: "1234567890" },
                    statuses: [{ id: "wamid.estado-fallido-1", status: "delivered" }],
                  },
                },
              ],
            },
          ],
        })
      );

      expect(response.status).toBe(200);
      const eventos = spy.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(
        eventos.some(
          (e) =>
            e.event === "webhook_error_actualizar_estado" &&
            e.whatsappMessageId === "wamid.estado-fallido-1" &&
            typeof e.detalle === "string" &&
            e.detalle.includes("no se puede retroceder")
        )
      ).toBe(true);
    } finally {
      spy.mockRestore();
      setForceStatusUpdateError(null);
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
// T2, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026).
//
// Hallazgo 2 del plan: un corte TRANSITORIO de la base al guardar el
// contacto, la conversación o el mensaje entrante perdía ese mensaje del
// cliente para siempre -- `console.error` + `continue`, respondiendo 200.
// Meta no reintenta un 200. Ahora los tres `continue` de pérdida levantan
// `persistenciaFallida` cuando `esFalloTransitorioDeBase(error)` es cierto,
// y el POST responde 503 al final -- DESPUÉS de encolar los turnos de lo que
// sí se guardó -- para que Meta reentregue el lote completo. Un fallo NO
// transitorio (payload raro, constraint) sigue en 200: ahí no hay nada que
// un reintento de Meta vaya a arreglar.
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/whatsapp — persistencia fallida (D1)", () => {
  /**
   * Dos mensajes de DOS contactos distintos en el mismo lote -- el contacto
   * por defecto ("+584120000000", contact-1/conv-1) y uno nuevo, que el
   * fake crea de cero (contact-2/conv-2) mientras procesa este mismo POST.
   * Hace falta un segundo contacto de verdad (no solo un segundo mensaje del
   * mismo contacto) para probar que el turno de la OTRA conversación del
   * lote se encola aunque la primera no se haya podido guardar.
   */
  function webhookBodyDosContactos(wamidA: string, wamidB: string) {
    return {
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "1234567890" },
                contacts: [
                  { profile: { name: "Cliente Uno" }, wa_id: "584120000000" },
                  { profile: { name: "Cliente Dos" }, wa_id: "584120000099" },
                ],
                messages: [
                  {
                    from: "584120000000",
                    id: wamidA,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "hola" },
                  },
                  {
                    from: "584120000099",
                    id: wamidB,
                    timestamp: String(Math.floor(Date.now() / 1000) + 1),
                    type: "text",
                    text: { body: "hola desde el otro contacto" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  it("mensaje: un fallo TRANSITORIO responde 503 y deja webhook_mensaje_no_guardado, pero encola el turno de la OTRA conversación del lote", async () => {
    const wamidFalla = "wamid.persistencia-mensaje-transitorio-A";
    const wamidOk = "wamid.persistencia-mensaje-transitorio-B";
    setForceMessageInsertError(wamidFalla, { code: "08006", message: "connection failure" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(fakeRequest(webhookBodyDosContactos(wamidFalla, wamidOk)));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, retry: true });

      const eventos = spy.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(
        eventos.some(
          (e) =>
            e.event === "webhook_mensaje_no_guardado" &&
            e.whatsappMessageId === wamidFalla &&
            typeof e.detail === "string" &&
            e.detail.includes("connection failure")
        )
      ).toBe(true);

      // El mensaje que SÍ se guardó (otro contacto, otra conversación) igual
      // encola su turno -- el 503 no debe tapar el trabajo que sí se hizo.
      expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
      expect(enqueueAgentTurns).toHaveBeenCalledWith(["conv-2"], expect.anything());
    } finally {
      spy.mockRestore();
      setForceMessageInsertError(wamidFalla, null);
    }
  });

  it("mensaje: un fallo NO transitorio responde 200 y deja el evento igual, sin frenar a Meta", async () => {
    const wamid = "wamid.persistencia-mensaje-no-transitorio";
    // 23502: NOT NULL violation -- un payload raro, no un corte de la base.
    setForceMessageInsertError(wamid, { code: "23502", message: "null value in column violates not-null constraint" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(fakeRequest(webhookBody(wamid)));

      expect(response.status).toBe(200);
      const eventos = spy.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(eventos.some((e) => e.event === "webhook_mensaje_no_guardado" && e.whatsappMessageId === wamid)).toBe(
        true
      );
      expect(enqueueAgentTurns).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      setForceMessageInsertError(wamid, null);
    }
  });

  it("mensaje: la reentrega (23505) sigue en 200 y NO deja webhook_mensaje_no_guardado", async () => {
    const wamid = "wamid.persistencia-23505-sigue-en-200";
    await POST(fakeRequest(webhookBody(wamid))); // primer intento: se guarda de verdad

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(fakeRequest(webhookBody(wamid))); // reentrega de Meta

      expect(response.status).toBe(200);
      const eventos = spy.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(eventos.some((e) => e.event === "webhook_mensaje_no_guardado")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("contacto: un fallo TRANSITORIO al upsertar responde 503 y deja webhook_contacto_no_guardado", async () => {
    const wamid = "wamid.persistencia-contacto-transitorio";
    setForceContactUpsertError("+584120000000", { code: "53300", message: "too many connections for role" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(fakeRequest(webhookBody(wamid)));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, retry: true });
      const eventos = spy.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(
        eventos.some(
          (e) =>
            e.event === "webhook_contacto_no_guardado" &&
            e.whatsappMessageId === wamid &&
            typeof e.detail === "string" &&
            e.detail.includes("too many connections")
        )
      ).toBe(true);
      // Sin contacto no hay a dónde colgar el mensaje: no se guarda nada y
      // no hay turno que encolar.
      expect(enqueueAgentTurns).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      setForceContactUpsertError("+584120000000", null);
    }
  });

  it("conversación: un fallo TRANSITORIO al crearla (contacto nuevo) responde 503 y deja webhook_conversacion_no_creada", async () => {
    const wamid = "wamid.persistencia-conversacion-transitoria";
    // Contacto nuevo (no "+584120000000"): el SELECT de "¿existe ya?" del
    // fake devuelve null para cualquier contacto que no sea el de fábrica,
    // así que route.ts entra a la rama de conversación NUEVA (.insert()).
    // El fake crea ese contacto como "contact-2" (contactRows arranca en 1
    // fila en cada test, ver beforeEach) -- por eso se puede fijar el fallo
    // de antemano.
    setForceConversationInsertError("contact-2", { code: "08006", message: "connection failure" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(
        fakeRequest({
          entry: [
            {
              changes: [
                {
                  field: "messages",
                  value: {
                    metadata: { phone_number_id: "1234567890" },
                    contacts: [{ profile: { name: "Cliente Nuevo" }, wa_id: "584120000077" }],
                    messages: [
                      {
                        from: "584120000077",
                        id: wamid,
                        timestamp: String(Math.floor(Date.now() / 1000)),
                        type: "text",
                        text: { body: "hola, soy nuevo" },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        })
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, retry: true });
      const eventos = spy.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(
        eventos.some(
          (e) =>
            e.event === "webhook_conversacion_no_creada" &&
            e.whatsappMessageId === wamid &&
            typeof e.detail === "string" &&
            e.detail.includes("connection failure")
        )
      ).toBe(true);
      expect(enqueueAgentTurns).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      setForceConversationInsertError("contact-2", null);
    }
  });

  /**
   * Objeción B del VPS (sumada al plan el 21/9/2026): D1 convierte la
   * reentrega en un camino que Meta puede provocar A PROPÓSITO (mandó un
   * lote, algo falló, reentrega el lote COMPLETO). Un lote reentregado trae
   * mensajes que YA se guardaron (23505) junto a uno nuevo -- el turno no
   * puede encolarse para la conversación VIEJA otra vez, solo para la del
   * mensaje nuevo. Hoy ya es así por construcción (el `continue` del 23505
   * corta antes de tocar `touchedByCustomer`), este test lo fija.
   *
   * A propósito con DOS CONTACTOS (conv-1 la vieja, conv-2 la nueva) y no
   * dos mensajes del mismo contacto: `touchedByCustomer` es un `Map` por
   * `conversationId`, así que un lote con dos mensajes de la MISMA
   * conversación ya colapsa a una sola entrada pase lo que pase con el
   * `continue` -- ese caso no distinguiría "se cortó antes" de "se agregó
   * dos veces la misma clave". Con dos conversaciones distintas, un
   * `continue` que se saltara SÍ agregaría la vieja (conv-1) al array.
   */
  it("la reentrega de un lote no encola el turno dos veces: solo la conversación del mensaje nuevo", async () => {
    const waViejo = "wamid.reentrega-lote-viejo";
    const waNuevo = "wamid.reentrega-lote-nuevo";

    await POST(fakeRequest(webhookBody(waViejo))); // contact-1/conv-1, se guarda de verdad
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
    vi.mocked(enqueueAgentTurns).mockClear();

    // waViejo reentregado (mismo contacto, 23505) junto a waNuevo, de un
    // contacto que el CRM nunca había visto (crea contact-2/conv-2 en el
    // mismo POST).
    const response = await POST(fakeRequest(webhookBodyDosContactos(waViejo, waNuevo)));

    expect(response.status).toBe(200);
    expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
    expect(enqueueAgentTurns).toHaveBeenCalledWith(["conv-2"], expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Corrección hallada en la verificación a mano del orquestador (22/9/2026,
// escenario "apagar PostgREST durante un POST al webhook local"): con la
// base caída, Kong responde 503 "name resolution failed" a TODO, y la
// PRIMERA lectura del lote es la consulta del canal (`whatsapp_channels`,
// antes de llegar a contacto/conversación/mensaje) -- el `error` de esa
// consulta se descartaba y se leía como "no hay canal registrado"
// (`webhook_canal_no_encontrado`), el mismo agujero que T2 cerró tres pasos
// más adelante, pero en el primer paso: el lote entero se descartaba con 200
// sin que ninguno de los tres inyectores de fallo de T2 llegara a correr.
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/whatsapp — el canal no se puede consultar", () => {
  it("canal: un fallo TRANSITORIO al consultarlo responde 503 y deja webhook_canal_no_consultable, sin guardar nada", async () => {
    const wamid = "wamid.persistencia-canal-transitorio";
    setForceChannelLookupError({ code: "08006", message: "connection failure" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(fakeRequest(webhookBody(wamid)));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, retry: true });
      const eventos = spy.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(
        eventos.some(
          (e) =>
            e.event === "webhook_canal_no_consultable" &&
            e.canalMeta === "1234567890" &&
            typeof e.detail === "string" &&
            e.detail.includes("connection failure")
        )
      ).toBe(true);
      // Sin canal no hay a dónde colgar nada de este lote: no se guarda el
      // mensaje ni se encola ningún turno.
      expect(insertedRows).toHaveLength(0);
      expect(enqueueAgentTurns).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      setForceChannelLookupError(null);
    }
  });

  it("canal: un fallo NO transitorio responde 200 y deja el evento igual, sin frenar a Meta", async () => {
    const wamid = "wamid.persistencia-canal-no-transitorio";
    // 42501: permiso denegado -- un rechazo real de la consulta, no un corte
    // de la base.
    setForceChannelLookupError({ code: "42501", message: "permission denied for table whatsapp_channels" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(fakeRequest(webhookBody(wamid)));

      expect(response.status).toBe(200);
      const eventos = spy.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(
        eventos.some(
          (e) => e.event === "webhook_canal_no_consultable" && e.canalMeta === "1234567890"
        )
      ).toBe(true);
      expect(enqueueAgentTurns).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      setForceChannelLookupError(null);
    }
  });

  /**
   * `phoneNumberId` como nombre de clave quedaba oculto por `lib/log.ts`
   * (tapa toda clave que contenga "phone", pensado para el teléfono de un
   * cliente) -- acá es el id del NÚMERO de Meta, infraestructura, no un dato
   * del cliente. La clave se renombró a `canalMeta`: este test comprueba que
   * el valor real llega LEGIBLE al evento, no `[oculto]`.
   */
  it("canal: sin canal y sin error, deja webhook_canal_no_encontrado con el id de Meta visible (no oculto)", async () => {
    const wamid = "wamid.canal-no-encontrado";
    setForceChannelNotFound(true);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(fakeRequest(webhookBody(wamid)));

      expect(response.status).toBe(200);
      const eventos = spy.mock.calls.map((call) => JSON.parse(String(call[0])));
      const evento = eventos.find((e) => e.event === "webhook_canal_no_encontrado");
      expect(evento?.canalMeta).toBe("1234567890");
      expect(insertedRows).toHaveLength(0);
      expect(enqueueAgentTurns).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      setForceChannelNotFound(false);
    }
  });

  /**
   * Punto 3 de la corrección: la RPC `rate_limit_allow` (el freno de
   * avalancha, ANTES del bucle de canales) también puede fallar por un corte
   * de la base. Con error, `allowed` queda en `null` -- no `false` -- así
   * que el `if (allowed === false)` de route.ts no descarta el lote: el
   * mensaje se guarda igual y responde 200 de siempre.
   */
  it("el freno de avalancha (rate_limit_allow) fallando no descarta el lote: el mensaje se guarda igual", async () => {
    const wamid = "wamid.rate-limit-allow-con-error";
    rateLimitAllowError = { message: "connection failure" };
    try {
      const response = await POST(fakeRequest(webhookBody(wamid)));

      expect(response.status).toBe(200);
      expect(insertedMessages.has(wamid)).toBe(true);
      expect(enqueueAgentTurns).toHaveBeenCalledTimes(1);
    } finally {
      rateLimitAllowError = null;
    }
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
//
// T2b, plan "Seba atiende el mostrador" (18/9/2026, D2): reescrito. El
// reopen dejó de tener ramas por `ai_enabled`/`assigned_agent_id` -- un chat
// reabierto arranca SIEMPRE de cero (IA encendida, sin asesor, Seba se
// presenta de nuevo) -- así que el UPDATE ahora es un RECLAMO con los cuatro
// campos y `.eq("status", "closed")` en el WHERE, y el traspaso es siempre
// `toKind: "ai"`.
// ---------------------------------------------------------------------------
describe("POST /api/webhooks/whatsapp — el cliente vuelve sobre una conversación cerrada", () => {
  const PATCH_REAPERTURA = { status: "open", ai_enabled: true, assigned_agent_id: null, welcome_sent_at: null };

  it("reabre con los cuatro campos, avisa en el hilo y el traspaso siempre vuelve a la IA", async () => {
    setConversationRow({ status: "closed", ai_enabled: true });

    const response = await POST(fakeRequest(webhookBody("wamid.reabre-con-ia-1")));

    expect(response.status).toBe(200);
    expect(conversationUpdates).toContainEqual({ id: "conv-1", patch: PATCH_REAPERTURA });
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

  /**
   * Antes de esta tarea, un chat cerrado con la IA apagada (o con asesor
   * asignado) se devolvía a esa misma persona -- `human`/`unassigned` según
   * el estado previo. D2 decidió que un chat reabierto arranca SIEMPRE de
   * cero: el traspaso es `ai` sin mirar cómo había quedado el chat al
   * cerrarse.
   */
  it("con la IA apagada, o con un asesor ya asignado, igual reabre encendiendo la IA y sin dueño previo", async () => {
    setConversationRow({ status: "closed", ai_enabled: false, assigned_agent_id: "agent-7" });

    await POST(fakeRequest(webhookBody("wamid.reabre-con-asesor-1")));

    expect(conversationUpdates).toContainEqual({ id: "conv-1", patch: PATCH_REAPERTURA });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({
        p_conversation_id: "conv-1",
        p_to_kind: "ai",
        p_reason: "reabierta_por_cliente",
      })
    );
    // Ningún traspaso de reapertura queda con `human` o `unassigned`: los dos
    // desaparecieron con las ramas por `ai_enabled`/`assigned_agent_id`.
    expect(
      handoffCalls.some((c) => c.p_reason === "reabierta_por_cliente" && c.p_to_kind !== "ai")
    ).toBe(false);
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

  /**
   * Mutación de esta tarea (T2b): quitar `.eq("status", "closed")` del
   * UPDATE de reapertura deja este test en rojo -- sin ese filtro en el
   * WHERE, el segundo mensaje del lote (que ve la fila todavía "closed" por
   * la lectura forzada abajo) volvería a afectar la fila ya reabierta por el
   * primero, y se duplicarían el evento de sistema y el traspaso.
   *
   * `setForceStaleClosedReads(2)` simula la lectura vieja que vería un
   * segundo webhook concurrente del mismo lote: el SELECT de "¿existe ya?"
   * devuelve `status: "closed"` para los DOS mensajes aunque el primer
   * UPDATE ya haya reabierto la fila de verdad -- así el reclamo del segundo
   * (`.eq("status", "closed").select("id")`) es el único que puede frenarlo.
   */
  it("dos mensajes del mismo lote no duplican ni el evento ni el traspaso de reapertura", async () => {
    setConversationRow({ status: "closed", ai_enabled: true });
    setForceStaleClosedReads(2);

    await POST(
      fakeRequest(
        webhookBodyTwoMessages("wamid.reabre-lote-1", "wamid.reabre-lote-2")
      )
    );

    expect(conversationUpdates.filter((u) => "status" in u.patch)).toHaveLength(1);
    expect(insertedRows.filter((r) => r.sender_type === "system" && r.content === "El cliente volvió a escribir")).toHaveLength(1);
    expect(handoffCalls.filter((c) => c.p_reason === "reabierta_por_cliente")).toHaveLength(1);
  });

  /**
   * Hallazgo H, Tanda 1 de "El resguardo antes del push" (20/9/2026): la
   * reapertura corría ANTES del dedupe de reentregas de Meta
   * (`insertError.code === "23505"`, que vive en el INSERT del mensaje, más
   * abajo en el archivo). Un asesor cierra el chat después de contestar; Meta
   * reentrega tarde ese mismo mensaje YA guardado; sin este freno el webhook
   * reabría igual -- IA encendida, sin asesor, sello de presentación a null,
   * traspaso a la IA -- sobre un chat que un asesor había cerrado a
   * propósito, sin que llegara ningún mensaje nuevo. Si ese chat había
   * quedado con `awaiting_reply = true`, el reconciliador lo recogía y Seba
   * saludaba y "contestaba" un mensaje VIEJO.
   */
  it("chat cerrado + wamid que ya estaba guardado (reentrega de Meta): no reabre, no deja traspaso ni encola turno", async () => {
    const wamid = "wamid.reentrega-cerrada-1";

    // Primer envío, con el chat todavía abierto (default): el mensaje se
    // guarda de verdad, como cualquier mensaje normal.
    const primera = await POST(fakeRequest(webhookBody(wamid)));
    expect(primera.status).toBe(200);
    expect(insertedMessages.has(wamid)).toBe(true);

    // El asesor cierra el chat después de haber contestado.
    setConversationRow({ status: "closed", ai_enabled: true });
    conversationUpdates.length = 0;
    handoffCalls.length = 0;
    insertedRows.length = 0;
    vi.mocked(enqueueAgentTurns).mockClear();

    // Meta reentrega tarde el MISMO mensaje (entrega "at-least-once").
    const segunda = await POST(fakeRequest(webhookBody(wamid)));

    expect(segunda.status).toBe(200);
    expect(conversationUpdates).toHaveLength(0);
    expect(handoffCalls.some((c) => c.p_reason === "reabierta_por_cliente")).toBe(false);
    expect(
      insertedRows.some((r) => r.sender_type === "system" && r.content === "El cliente volvió a escribir")
    ).toBe(false);
    expect(enqueueAgentTurns).not.toHaveBeenCalled();
  });

  /**
   * Mismo hallazgo H: un wamid NUEVO sobre un chat cerrado (el caso de
   * siempre, sin reentrega detrás) tiene que seguir reabriendo tal cual --
   * la comprobación nueva no puede frenar una reapertura legítima.
   */
  it("chat cerrado + wamid nuevo (sin reentrega): reabre como siempre", async () => {
    setConversationRow({ status: "closed", ai_enabled: true });

    const response = await POST(fakeRequest(webhookBody("wamid.reentrega-cerrada-wamid-nuevo-1")));

    expect(response.status).toBe(200);
    expect(conversationUpdates).toContainEqual({ id: "conv-1", patch: PATCH_REAPERTURA });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({
        p_conversation_id: "conv-1",
        p_to_kind: "ai",
        p_reason: "reabierta_por_cliente",
      })
    );
  });

  /**
   * Si la consulta que comprueba la reentrega falla (base caída, red
   * cortada), se sigue el camino de siempre -- perder un mensaje real por no
   * reabrir es peor que reabrir de más.
   */
  it("si falla la comprobación de reentrega antes de reabrir, se sigue el camino de siempre", async () => {
    setConversationRow({ status: "closed", ai_enabled: true });
    setForceMessageLookupError(true);

    const response = await POST(fakeRequest(webhookBody("wamid.reentrega-consulta-rota-1")));

    expect(response.status).toBe(200);
    expect(conversationUpdates).toContainEqual({ id: "conv-1", patch: PATCH_REAPERTURA });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({
        p_conversation_id: "conv-1",
        p_to_kind: "ai",
        p_reason: "reabierta_por_cliente",
      })
    );
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

// ---------------------------------------------------------------------------
// S1 del plan "El cliente que cambió de número" (6/9/2026): `type: "system"`,
// el cliente cambió de número de WhatsApp. D1 -- el contacto sigue al número
// nuevo; D2 -- si el nuevo ya tiene contacto, no se fusiona nada.
//
// El remitente por defecto (+584120000000) coincide con `contactRows` por
// defecto (contact-1) y con `conversationRow` (conv-1), así que el caso feliz
// no necesita tocar ningún setter.
// ---------------------------------------------------------------------------
function webhookSystemBody(waMessageId: string, system: Record<string, unknown>, from = "584120000000") {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "1234567890" },
              messages: [
                {
                  from,
                  id: waMessageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "system",
                  system,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("POST /api/webhooks/whatsapp — el cliente cambió de número (type: system)", () => {
  it("a un número libre: mueve el contacto, el evento lleva el número nuevo, sin turno de IA", async () => {
    const response = await POST(
      fakeRequest(
        webhookSystemBody("wamid.cambio-numero-1", {
          body: "User A changed from 584120000000 to 584129999999",
          wa_id: "584129999999",
          type: "user_changed_number",
        })
      )
    );

    expect(response.status).toBe(200);
    expect(contactUpdates).toContainEqual({ id: "contact-1", patch: { phone_number: "+584129999999" } });

    const evento = insertedRows.find(
      (r) => r.sender_type === "system" && typeof r.content === "string" && r.content.includes("+584129999999")
    );
    expect(evento).toBeDefined();
    expect(evento?.payload).toMatchObject({ newPhone: "+584129999999", systemType: "user_changed_number" });

    // Nada de esto es un mensaje del cliente: no abre turno de IA.
    expect(insertedRows.some((r) => r.direction === "inbound")).toBe(false);
    expect(enqueueAgentTurns).not.toHaveBeenCalled();
  });

  it("a un número que ya tiene contacto: no fusiona nada, el evento avisa el conflicto y log.error", async () => {
    setContactRows([
      { id: "contact-1", phone_number: "+584120000000" },
      { id: "contact-9", phone_number: "+584129999999" },
    ]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await POST(
        fakeRequest(
          webhookSystemBody("wamid.cambio-numero-conflicto-1", {
            body: "User A changed from 584120000000 to 584129999999",
            wa_id: "584129999999",
            type: "user_changed_number",
          })
        )
      );

      expect(response.status).toBe(200);
      expect(contactUpdates).toHaveLength(0);

      const evento = insertedRows.find(
        (r) => r.sender_type === "system" && typeof r.content === "string" && r.content.includes("+584129999999")
      );
      expect(evento?.content).toContain("ya tiene conversación en el CRM");

      const eventosLog = spy.mock.calls.map((call) => JSON.parse(String(call[0])));
      const conflicto = eventosLog.find((e) => e.event === "webhook_cambio_numero_conflicto");
      expect(conflicto).toMatchObject({ previo: "+584120000000", nuevo: "+584129999999" });
    } finally {
      spy.mockRestore();
    }
  });

  it("de un número sin conversación en el CRM: no inserta ni actualiza nada, responde 200", async () => {
    setContactRows([]);

    const response = await POST(
      fakeRequest(
        webhookSystemBody(
          "wamid.cambio-numero-sin-conversacion-1",
          { body: "User A changed from 584127777777 to 584129999999", wa_id: "584129999999", type: "user_changed_number" },
          "584127777777"
        )
      )
    );

    expect(response.status).toBe(200);
    expect(insertedRows).toHaveLength(0);
    expect(contactUpdates).toHaveLength(0);
  });

  it("system.type desconocido (customer_identity_changed): deja el evento genérico, sin tocar contacts", async () => {
    await POST(
      fakeRequest(
        webhookSystemBody("wamid.identidad-1", {
          type: "customer_identity_changed",
          identity: "algo-que-no-es-un-telefono",
        })
      )
    );

    expect(contactUpdates).toHaveLength(0);
    const evento = insertedRows.find((r) => r.sender_type === "system");
    expect(evento?.payload).toEqual({ type: "system", systemType: "customer_identity_changed" });
  });

  it("conversación cerrada que recibe system: no la reabre, no hay traspaso, el evento igual se inserta", async () => {
    setConversationRow({ status: "closed", ai_enabled: true });

    await POST(
      fakeRequest(
        webhookSystemBody("wamid.cambio-numero-cerrada-1", {
          body: "User A changed from 584120000000 to 584129999999",
          wa_id: "584129999999",
          type: "user_changed_number",
        })
      )
    );

    expect(conversationUpdates.some((u) => "status" in u.patch)).toBe(false);
    expect(handoffCalls.some((c) => c.p_reason === "reabierta_por_cliente")).toBe(false);
    expect(
      insertedRows.some(
        (r) => r.sender_type === "system" && typeof r.content === "string" && r.content.includes("+584129999999")
      )
    ).toBe(true);
  });
});
