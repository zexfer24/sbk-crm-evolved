import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// La prueba del incidente del 26 de agosto de 2026.
//
// Reconstruye las cinco conversaciones que salieron mal, con el estado exacto
// que tenían en la base en ese momento: assigned_agent_id nulo, ai_enabled en
// true, awaiting_reply en true —porque el cliente había contestado lo último—
// y un asesor humano escribiendo en el hilo.
//
// Con ese estado, las tres guardas que existían decían que sí. La pregunta
// que estas pruebas contestan es la única que le importa al dueño antes de
// volver a encender: ¿le puede escribir la IA a un cliente que ya está
// hablando con un asesor?
//
// T7 (8/9/2026): la guarda dejó de preguntar "¿alguna vez?" y pasó a mirar
// fechas (ver el docblock de human-handled.ts). Los cinco chats de acá abajo
// siguen bloqueados con la regla nueva, pero ahora por la cláusula de gracia
// —"está conversando AHORA"—, no por "alguna vez escribió". En los cinco el
// asesor escribió unos minutos antes de que el cliente respondiera, y el
// "ahora" de la prueba (`AHORA`, más abajo) está fijado a pocos minutos de
// distancia de los dos: es literalmente una conversación en curso, el caso
// que la cláusula de gracia existe para proteger.
// ---------------------------------------------------------------------------

interface MensajeFalso {
  sender_type: "customer" | "agent" | "ai" | "system";
  content: string;
  created_at: string;
  is_internal_note?: boolean;
}

interface ChatFalso {
  id: string;
  contactId: string;
  phoneNumber: string;
  mensajes: MensajeFalso[];
}

/** "Ahora" para toda la reconstrucción del incidente: 26/8/2026, 15:00 UTC. */
const AHORA = Date.parse("2026-08-26T15:00:00.000Z");
const HACE_5_MIN = new Date(AHORA - 5 * 60_000).toISOString();
const HACE_2_MIN = new Date(AHORA - 2 * 60_000).toISOString();
const HACE_1_MIN = new Date(AHORA - 1 * 60_000).toISOString();
const HACE_10_MIN = new Date(AHORA - 10 * 60_000).toISOString();
const HACE_3_MIN = new Date(AHORA - 3 * 60_000).toISOString();

/**
 * Los cinco casos del incidente, textuales.
 *
 * En los cinco, lo último que escribió el cliente es un fragmento que solo
 * significa algo con el turno anterior delante — y el turno anterior es de un
 * asesor, escrito minutos antes (conversación en curso, no un mensaje viejo).
 */
const CHATS_DE_ASESORES: ChatFalso[] = [
  {
    id: "conv-1",
    contactId: "contacto-1",
    phoneNumber: "+584120000001",
    mensajes: [
      { sender_type: "agent", content: "Te paso el código de descuento: SBK15", created_at: HACE_5_MIN },
      {
        sender_type: "customer",
        content: "Ok muchas gracias, igual metí el código y sale q no existe",
        created_at: HACE_2_MIN,
      },
    ],
  },
  {
    id: "conv-2",
    contactId: "contacto-2",
    phoneNumber: "+584120000002",
    mensajes: [
      { sender_type: "agent", content: "Listo, te lo aparto hasta mañana", created_at: HACE_5_MIN },
      { sender_type: "customer", content: "🙌🏽", created_at: HACE_2_MIN },
    ],
  },
  {
    id: "conv-3",
    contactId: "contacto-3",
    phoneNumber: "+584120000003",
    mensajes: [
      { sender_type: "agent", content: "Con Cashea te sale el envío gratis", created_at: HACE_5_MIN },
      {
        sender_type: "customer",
        content: "Y si yo no quiero usar xq voy a pagar el monto completo",
        created_at: HACE_2_MIN,
      },
    ],
  },
  {
    id: "conv-4",
    contactId: "contacto-4",
    phoneNumber: "+584120000004",
    mensajes: [
      { sender_type: "agent", content: "¿Te reservo el par entonces?", created_at: HACE_5_MIN },
      { sender_type: "customer", content: "Si", created_at: HACE_2_MIN },
    ],
  },
  {
    id: "conv-5",
    contactId: "contacto-5",
    phoneNumber: "+584120000005",
    mensajes: [
      { sender_type: "agent", content: "¿De qué medida lo necesitas?", created_at: HACE_5_MIN },
      { sender_type: "customer", content: "A él 20cm", created_at: HACE_2_MIN },
      { sender_type: "customer", content: "Y en divisas ?", created_at: HACE_1_MIN },
    ],
  },
];

/** El caso que la IA sí debe atender: nadie del equipo escribió nunca acá. */
const CHAT_SIN_TOCAR: ChatFalso = {
  id: "conv-nueva",
  contactId: "contacto-nueva",
  phoneNumber: "+584120000009",
  mensajes: [{ sender_type: "customer", content: "buenas, tienen cauchos para una Bera BR200?", created_at: HACE_1_MIN }],
};

/**
 * Una nota interna también marca el chat como trabajado por una persona.
 *
 * El asesor todavía no le escribió al cliente, pero está en el caso. Ante la
 * duda la IA se queda afuera: el costo de los dos lados no se parece. La nota
 * es POSTERIOR al mensaje del cliente (el asesor la deja después de leerlo),
 * así que acá bloquea por la cláusula de "se adelantó" (created_at > lcma),
 * la otra mitad de la regla nueva — no por la de gracia, que ya cubren los
 * cinco chats de arriba.
 */
const CHAT_CON_NOTA_INTERNA: ChatFalso = {
  id: "conv-nota",
  contactId: "contacto-nota",
  phoneNumber: "+584120000010",
  mensajes: [
    { sender_type: "customer", content: "necesito cambiar unos frenos", created_at: HACE_10_MIN },
    {
      sender_type: "agent",
      content: "Cliente de la semana pasada, revisar garantía",
      created_at: HACE_3_MIN,
      is_internal_note: true,
    },
  ],
};

const TODOS = [...CHATS_DE_ASESORES, CHAT_SIN_TOCAR, CHAT_CON_NOTA_INTERNA];

function porId(id: string): ChatFalso {
  const chat = TODOS.find((c) => c.id === id);
  if (!chat) throw new Error(`chat desconocido en la prueba: ${id}`);
  return chat;
}

/** El `created_at` del último mensaje del CLIENTE, o null si nunca escribió. */
function ultimoMensajeClienteISO(chat: ChatFalso): string | null {
  const deCliente = chat.mensajes.filter((m) => m.sender_type === "customer");
  return deCliente.length > 0 ? deCliente[deCliente.length - 1].created_at : null;
}

// ---------------------------------------------------------------------------
// Supabase falso. Reproduce el estado del incidente en la fila de
// `conversations`: las tres guardas viejas en verde.
// ---------------------------------------------------------------------------

/**
 * Cuántas veces queda encendido el interruptor antes de "apagarse".
 *
 * `Infinity` = nunca se apaga. Un número = las primeras N consultas dicen que
 * sí y el resto que no, que es como se simula al dueño pulsando el botón a
 * mitad de turno: la primera consulta es la de apertura y la última la de
 * justo antes de enviar.
 */
let consultasAntesDeApagar = Number.POSITIVE_INFINITY;
/** A partir de qué consulta el interruptor deja de poder consultarse. */
let consultasAntesDeRomperse = Number.POSITIVE_INFINITY;
let consultasDelInterruptor = 0;

function createFakeSupabase() {
  return {
    rpc: (fn: string) => {
      // Lock por conversación (conversation-lock.ts): siempre libre. No debe
      // contar para `consultasDelInterruptor`, que solo mide agent_can_run.
      if (fn === "ai_turn_lock_acquire") return Promise.resolve({ data: true, error: null });
      if (fn === "ai_turn_lock_renew") return Promise.resolve({ data: true, error: null });
      if (fn === "ai_turn_lock_release") return Promise.resolve({ data: true, error: null });
      if (fn !== "agent_can_run") return Promise.reject(new Error(`rpc no soportada: ${fn}`));
      consultasDelInterruptor++;
      if (consultasDelInterruptor > consultasAntesDeRomperse) {
        return Promise.reject(new Error("se cayó la conexión con la base"));
      }
      return Promise.resolve({ data: consultasDelInterruptor <= consultasAntesDeApagar, error: null });
    },
    from(table: string) {
      if (table === "conversations") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => {
                const chat = porId(id);
                return {
                  data: {
                    id: chat.id,
                    contact_id: chat.contactId,
                    // Las tres guardas del incidente, tal cual estaban:
                    ai_enabled: true, // solo se apaga al escalar
                    assigned_agent_id: null, // los asesores no se asignan
                    welcome_sent_at: "2026-08-22T10:00:00Z",
                    last_customer_message_at: ultimoMensajeClienteISO(chat),
                    contact: { phone_number: chat.phoneNumber },
                    channel: { phone_number_id: "pnid-1", status: "connected" },
                  },
                };
              },
            }),
          }),
          update: () => ({
            eq: () => Promise.resolve({ data: null, error: null }),
          }),
        };
      }

      if (table === "messages") {
        return {
          select: (columnas: string) => ({
            // La comprobación de human-handled: filtra por sender_type.
            eq: (_c: string, id: string) => {
              const base = {
                // humanHasWritten (T7, 8/9/2026): .eq(sender_type,'agent')
                // .order(created_at desc).limit(1) — trae el mensaje de
                // asesor MÁS RECIENTE, no la lista entera.
                eq: (_c2: string, senderType: string) => ({
                  order: () => ({
                    limit: async () => {
                      const deEseTipo = porId(id).mensajes
                        .filter((m) => m.sender_type === senderType)
                        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
                      return {
                        data: deEseTipo.slice(0, 1).map((m) => ({ created_at: m.created_at })),
                        error: null,
                      };
                    },
                  }),
                }),
                // El historial que lee el turno.
                order: () => ({
                  limit: async () => ({ data: [...porId(id).mensajes].reverse() }),
                }),
              };
              void columnas;
              return base;
            },
          }),
        };
      }

      if (table === "agent_tools") return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      if (table === "agent_turns") return { insert: async () => ({ data: null, error: null }) };
      // B3 (5/9/2026): runAgentTurn lee el horario al arrancar; sin fila cae al default.
      if (table === "agent_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { business_hours: null }, error: null }) }) }) };
      }

      throw new Error(`tabla no soportada: ${table}`);
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createFakeSupabase() }));

/** Todo lo que la IA le mandó a un cliente. Si esto no está vacío, salió algo. */
const enviados: { conversationId: string; text: string }[] = [];
// `playbookMessageText` no se finge: es lo que compone el texto que sale, y el
// turno lo usa para reconocer su propio mensaje en el historial y no repetir
// un escenario. Ver alreadySentPlaybook en agent.ts.
vi.mock("@/lib/ai/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/send")>()),
  sendAgentText: async (_s: unknown, target: { conversationId: string }, text: string) => {
    enviados.push({ conversationId: target.conversationId, text });
  },
  sendPlaybookReply: async (_s: unknown, target: { conversationId: string }) => {
    enviados.push({ conversationId: target.conversationId, text: "(escenario)" });
  },
}));

/**
 * El escenario "gracias por tu compra" siempre calza.
 *
 * Es el peor caso a propósito: así la prueba mide la guarda y no la suerte
 * del clasificador. En el incidente ese escenario fue el que salió, y le
 * llegó a alguien que no había comprado nada.
 */
vi.mock("@/lib/ai/playbooks", () => ({
  matchPlaybook: async () => ({
    playbook: {
      id: "pb-gracias",
      name: "Gracias por tu compra",
      triggerDescription: "el cliente confirma que recibió su pedido",
      responseText: "¡Gracias por tu compra! 🏍️",
      attachmentUrl: null,
      attachmentType: null,
      afterSend: "wait",
      isActive: true,
      tags: [],
    },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }),
  fetchActivePlaybooks: async () => [],
  // Nunca repetido: acá se mide la guarda del asesor, no la de la repetición.
  playbookSentRecently: async () => false,
}));

vi.mock("@/lib/ai/classify", () => ({
  classifyIntent: async () => ({
    intent: "consulta_disponibilidad",
    usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
  }),
}));

vi.mock("@/lib/ai/escalate", () => ({
  escalateConversation: async () => ({ escalated: true, assignedAgentName: "María" }),
  RECLAMO_CATEGORIES: ["Envío", "Pago", "Producto", "Atención", "Garantía"],
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  ToolLoopAgent: class {
    generate = async () => ({
      text: "respuesta redactada por el modelo",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    });
  },
}));

vi.mock("@/lib/ai/model", () => ({
  getAgentModel: () => ({ model: "modelo-falso" }),
  getClassifierModel: () => ({ model: "modelo-falso" }),
  currentAgentModelLabel: () => "fake/modelo",
}));

vi.mock("@/lib/ai/tools", () => ({
  buildCatalogTool: () => ({}),
  buildEscalateTool: () => ({}),
  buildOrderHistoryTool: () => ({}),
}));
vi.mock("@/lib/ai/knowledge", () => ({ buildKnowledgeTool: () => ({}) }));

import { runAgentTurn } from "@/lib/ai/agent";
import { conversationsWrittenByHumans, humanClaimsChat, humanGraceMinutes, humanHasWritten } from "@/lib/ai/human-handled";

beforeEach(() => {
  enviados.length = 0;
  consultasAntesDeApagar = Number.POSITIVE_INFINITY;
  consultasAntesDeRomperse = Number.POSITIVE_INFINITY;
  consultasDelInterruptor = 0;
  // Congela el reloj del turno en el "ahora" de la reconstrucción: sin esto
  // `runAgentTurn` compara los `created_at` de arriba contra el reloj de
  // verdad del equipo que corre la prueba, y la gracia de 30 minutos por
  // default dejaría de cubrirlos con el paso de los días.
  vi.spyOn(Date, "now").mockReturnValue(AHORA);
});

afterEach(() => {
  vi.mocked(Date.now).mockRestore();
});

describe("la IA no le escribe a un cliente que está hablando con un asesor", () => {
  /**
   * Este es EL test. Es el que hay que poder enseñarle al dueño antes de
   * volver a encender.
   *
   * Los cinco chats tienen las tres guardas viejas en verde —nadie asignado,
   * IA encendida, el cliente escribió lo último— y en los cinco hay un asesor
   * en el hilo, escribiendo hace pocos minutos. El escenario que más daño
   * hizo calza siempre. Aun así no sale ni un mensaje.
   */
  it("no sale ni un mensaje en los cinco chats del incidente", async () => {
    await Promise.all(CHATS_DE_ASESORES.map((chat) => runAgentTurn(chat.id)));

    expect(enviados).toEqual([]);
  });

  it("tampoco sale nada donde un asesor solo dejó una nota interna", async () => {
    await runAgentTurn(CHAT_CON_NOTA_INTERNA.id);

    expect(enviados).toEqual([]);
  });

  /**
   * La contraparte, que es lo que hace que la guarda sirva de algo: si
   * bloqueara todo, la IA no atendería a nadie y el arreglo sería apagarla.
   */
  it("sí atiende el chat donde nadie del equipo escribió nunca", async () => {
    await runAgentTurn(CHAT_SIN_TOCAR.id);

    expect(enviados).toHaveLength(1);
    expect(enviados[0].conversationId).toBe("conv-nueva");
  });

  /**
   * El lote mezclado, que es como llega de verdad: la tanda del barrido tenía
   * 139 conversaciones y 22 eran de asesores.
   */
  it("en un lote mezclado sale solo lo que nadie estaba atendiendo", async () => {
    await Promise.all(TODOS.map((chat) => runAgentTurn(chat.id)));

    expect(enviados.map((e) => e.conversationId)).toEqual(["conv-nueva"]);
  });
});

describe("el interruptor global para lo que ya está en vuelo", () => {
  /**
   * El dueño apagó la IA y los mensajes siguieron saliendo.
   *
   * El interruptor se miraba UNA vez, al abrir el turno, y después venían el
   * reconocimiento de escenario, la clasificación, hasta cinco pasos de tool
   * loop y el envío. Entre esa mirada y el envío pasan decenas de segundos, y
   * con tres turnos concurrentes apagar dejaba salir hasta tres mensajes más.
   *
   * Acá el interruptor está encendido cuando el turno abre y apagado cuando
   * llega al envío, que es exactamente lo que pasa si alguien pulsa el botón
   * mientras el modelo redacta.
   */
  it("no envía si se apagó mientras el turno corría", async () => {
    // La primera consulta (apertura) dice que sí; la del envío, que no.
    consultasAntesDeApagar = 1;

    await runAgentTurn(CHAT_SIN_TOCAR.id);

    expect(enviados).toEqual([]);
    // Y se comprobó más de una vez: si sólo mirara al abrir, esto sería 1.
    expect(consultasDelInterruptor).toBeGreaterThan(1);
  });

  /**
   * Falla cerrado. Un botón de pánico que ante la duda sigue adelante no es un
   * botón de pánico.
   */
  it("no envía si el interruptor no se puede consultar", async () => {
    // La apertura del turno pasa; la consulta de justo antes de enviar
    // revienta. Ante la duda, no se envía.
    consultasAntesDeRomperse = 1;

    await runAgentTurn(CHAT_SIN_TOCAR.id);

    expect(enviados).toEqual([]);
  });

  /** Encendido de principio a fin: el turno llega y envía, como siempre. */
  it("envía con normalidad si nadie apaga nada", async () => {
    await runAgentTurn(CHAT_SIN_TOCAR.id);

    expect(enviados).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pruebas unitarias de human-handled.ts (T7, 8/9/2026).
//
// Todo lo de acá abajo llama a las funciones directamente, sin pasar por
// `runAgentTurn`: `now` y `graceMinutes` se inyectan explícitos en cada caso,
// así que no dependen del `Date.now` congelado de arriba ni de
// `AI_HUMAN_GRACE_MINUTES` del entorno de pruebas.
//
// Los nueve casos numerados son los del brief de T7 (caso 9 = humanClaimsChat
// puro); los dos describes de arriba (humanHasWritten / conversationsWrittenByHumans)
// están en espejo: mismos nombres, mismo orden, para que sea evidente que las
// dos funciones deciden exactamente lo mismo.
// ---------------------------------------------------------------------------

interface MensajeAsesorFalso {
  conversation_id: string;
  created_at: string;
}

/**
 * Supabase falso para las pruebas unitarias: modela solo `messages`, con las
 * dos formas de consulta reales — individual (`humanHasWritten`) y de lote
 * (`conversationsWrittenByHumans`) — distinguidas por las columnas pedidas en
 * `select()`, igual que hace el Supabase real (una consulta u otra según qué
 * pidió el código, no según qué prueba está corriendo).
 */
function fakeMessagesTable(mensajes: MensajeAsesorFalso[]) {
  const llamadas: { tipo: "individual" | "lote"; conversationId?: string; ids?: string[]; umbral?: string }[] = [];

  return {
    llamadas,
    from(table: string) {
      if (table !== "messages") throw new Error(`Fake Supabase: tabla no soportada: ${table}`);
      return {
        select: (columnas: string) => {
          if (columnas === "created_at") {
            // humanHasWritten: .eq(conversation_id).eq(sender_type,'agent').order().limit(1)
            return {
              eq: (_c: string, conversationId: string) => ({
                eq: () => ({
                  order: () => ({
                    limit: async () => {
                      llamadas.push({ tipo: "individual", conversationId });
                      const propios = mensajes
                        .filter((m) => m.conversation_id === conversationId)
                        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
                      return { data: propios.slice(0, 1), error: null };
                    },
                  }),
                }),
              }),
            };
          }
          // conversationsWrittenByHumans: .in(ids).eq(sender_type,'agent').gt(created_at, umbral)
          return {
            in: (_c: string, ids: string[]) => ({
              eq: () => ({
                gt: async (_c3: string, umbral: string) => {
                  llamadas.push({ tipo: "lote", ids, umbral });
                  const filas = mensajes.filter((m) => ids.includes(m.conversation_id) && m.created_at > umbral);
                  return { data: filas, error: null };
                },
              }),
            }),
          };
        },
      };
    },
  };
}

/** Supabase que revienta cualquier consulta a `messages`: para las pruebas de fallo cerrado. */
function fakeMessagesTableRota(mensaje: string) {
  return {
    from(table: string) {
      if (table !== "messages") throw new Error(`Fake Supabase: tabla no soportada: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: mensaje } }) }) }),
          }),
          in: () => ({
            eq: () => ({ gt: async () => ({ data: null, error: { message: mensaje } }) }),
          }),
        }),
      };
    },
  };
}

/** "Ahora" para las pruebas unitarias: el mediodía del caso `3b654d2c…` (7/9/2026). */
const NOW = Date.parse("2026-09-07T12:54:00.000Z");
/** Gracia corta a propósito (10 min, no el default de 30): separa con claridad la cláusula de "se adelantó" de la de "está conversando ahora" en los casos 1 y 3. */
const G = 10;

describe("humanHasWritten", () => {
  /** Caso 1: el asesor respondió (o dejó nota) DESPUÉS del último mensaje del cliente. */
  it("bloquea si el humano escribió después del último mensaje del cliente", async () => {
    const lcma = new Date(NOW - 60 * 60_000).toISOString(); // hace 1h
    const humano = new Date(NOW - 45 * 60_000).toISOString(); // hace 45min: después de lcma, fuera de G
    const fake = fakeMessagesTable([{ conversation_id: "conv-x", created_at: humano }]);

    expect(await humanHasWritten(fake as never, "conv-x", lcma, { now: NOW, graceMinutes: G })).toBe(true);
  });

  /** Caso 2: el "a" del 28/8 contra el cliente del 7/9 — viejo y anterior al cliente, no bloquea. */
  it("no bloquea si el humano escribió antes del último mensaje del cliente y hace más de G", async () => {
    const lcma = new Date(NOW - 5 * 60_000).toISOString(); // cliente reciente
    const humano = new Date(NOW - 45 * 60_000).toISOString(); // viejo, antes del cliente, fuera de G
    const fake = fakeMessagesTable([{ conversation_id: "conv-x", created_at: humano }]);

    expect(await humanHasWritten(fake as never, "conv-x", lcma, { now: NOW, graceMinutes: G })).toBe(false);
  });

  /** Caso 3: asesor → cliente → IA en menos de G minutos. La IA no se mete a mitad de la venta. */
  it("bloquea si el humano escribió antes del último mensaje del cliente pero hace menos de G", async () => {
    const lcma = new Date(NOW - 2 * 60_000).toISOString(); // cliente hace 2 min
    const humano = new Date(NOW - 5 * 60_000).toISOString(); // asesor hace 5 min, antes del cliente, dentro de G
    const fake = fakeMessagesTable([{ conversation_id: "conv-x", created_at: humano }]);

    expect(await humanHasWritten(fake as never, "conv-x", lcma, { now: NOW, graceMinutes: G })).toBe(true);
  });

  /** Caso 4: nadie del equipo escribió nunca en el chat. */
  it("no bloquea si nunca escribió un humano", async () => {
    const lcma = new Date(NOW - 5 * 60_000).toISOString();
    const fake = fakeMessagesTable([]);

    expect(await humanHasWritten(fake as never, "conv-x", lcma, { now: NOW, graceMinutes: G })).toBe(false);
  });

  /** Caso 5: lead sin mensajes del cliente. No hay nada que contestar, y no se consulta la base. */
  it("no bloquea si lastCustomerMessageAt es null, y no consulta messages", async () => {
    const fake = fakeMessagesTable([{ conversation_id: "conv-x", created_at: new Date(NOW).toISOString() }]);

    expect(await humanHasWritten(fake as never, "conv-x", null, { now: NOW, graceMinutes: G })).toBe(false);
    expect(fake.llamadas).toHaveLength(0);
  });

  /** Caso 6: una nota interna cuenta igual que un mensaje al cliente. */
  it("una nota interna reciente bloquea igual", async () => {
    const lcma = new Date(NOW - 20 * 60_000).toISOString();
    // La nota es sender_type = 'agent', igual que un mensaje al cliente: la
    // consulta no distingue is_internal_note, así que estructuralmente es el
    // mismo caso que el 1 — se repite acá para dejarlo dicho explícitamente.
    const nota = new Date(NOW - 3 * 60_000).toISOString();
    const fake = fakeMessagesTable([{ conversation_id: "conv-x", created_at: nota }]);

    expect(await humanHasWritten(fake as never, "conv-x", lcma, { now: NOW, graceMinutes: G })).toBe(true);
  });

  it("falla cerrado: si la consulta revienta, lanza en vez de dejar pasar", async () => {
    const fake = fakeMessagesTableRota("se cayó la conexión");

    await expect(humanHasWritten(fake as never, "conv-x", new Date(NOW).toISOString(), { now: NOW })).rejects.toThrow(
      /no se pudo comprobar/i
    );
  });
});

describe("conversationsWrittenByHumans", () => {
  /** Caso 1, en espejo. */
  it("bloquea si el humano escribió después del último mensaje del cliente", async () => {
    const lcma = new Date(NOW - 60 * 60_000).toISOString();
    const humano = new Date(NOW - 45 * 60_000).toISOString();
    const fake = fakeMessagesTable([{ conversation_id: "conv-x", created_at: humano }]);

    const resultado = await conversationsWrittenByHumans(
      fake as never,
      [{ id: "conv-x", lastCustomerMessageAt: lcma }],
      { now: NOW, graceMinutes: G }
    );

    expect(resultado.has("conv-x")).toBe(true);
  });

  /** Caso 2, en espejo. */
  it("no bloquea si el humano escribió antes del último mensaje del cliente y hace más de G", async () => {
    const lcma = new Date(NOW - 5 * 60_000).toISOString();
    const humano = new Date(NOW - 45 * 60_000).toISOString();
    const fake = fakeMessagesTable([{ conversation_id: "conv-x", created_at: humano }]);

    const resultado = await conversationsWrittenByHumans(
      fake as never,
      [{ id: "conv-x", lastCustomerMessageAt: lcma }],
      { now: NOW, graceMinutes: G }
    );

    expect(resultado.has("conv-x")).toBe(false);
  });

  /** Caso 3, en espejo. */
  it("bloquea si el humano escribió antes del último mensaje del cliente pero hace menos de G", async () => {
    const lcma = new Date(NOW - 2 * 60_000).toISOString();
    const humano = new Date(NOW - 5 * 60_000).toISOString();
    const fake = fakeMessagesTable([{ conversation_id: "conv-x", created_at: humano }]);

    const resultado = await conversationsWrittenByHumans(
      fake as never,
      [{ id: "conv-x", lastCustomerMessageAt: lcma }],
      { now: NOW, graceMinutes: G }
    );

    expect(resultado.has("conv-x")).toBe(true);
  });

  /** Caso 4, en espejo. */
  it("no bloquea si nunca escribió un humano", async () => {
    const lcma = new Date(NOW - 5 * 60_000).toISOString();
    const fake = fakeMessagesTable([]);

    const resultado = await conversationsWrittenByHumans(
      fake as never,
      [{ id: "conv-x", lastCustomerMessageAt: lcma }],
      { now: NOW, graceMinutes: G }
    );

    expect(resultado.has("conv-x")).toBe(false);
  });

  /** Caso 5, en espejo: la fila se descarta de entrada, no entra ni en el umbral ni en la consulta. */
  it("no bloquea si lastCustomerMessageAt es null, y no consulta messages", async () => {
    const fake = fakeMessagesTable([{ conversation_id: "conv-x", created_at: new Date(NOW).toISOString() }]);

    const resultado = await conversationsWrittenByHumans(
      fake as never,
      [{ id: "conv-x", lastCustomerMessageAt: null }],
      { now: NOW, graceMinutes: G }
    );

    expect(resultado.has("conv-x")).toBe(false);
    expect(fake.llamadas).toHaveLength(0);
  });

  /** Caso 6, en espejo. */
  it("una nota interna reciente bloquea igual", async () => {
    const lcma = new Date(NOW - 20 * 60_000).toISOString();
    const nota = new Date(NOW - 3 * 60_000).toISOString();
    const fake = fakeMessagesTable([{ conversation_id: "conv-x", created_at: nota }]);

    const resultado = await conversationsWrittenByHumans(
      fake as never,
      [{ id: "conv-x", lastCustomerMessageAt: lcma }],
      { now: NOW, graceMinutes: G }
    );

    expect(resultado.has("conv-x")).toBe(true);
  });

  it("falla cerrado: si la consulta revienta, lanza en vez de dejar pasar", async () => {
    const fake = fakeMessagesTableRota("se cayó la conexión");

    await expect(
      conversationsWrittenByHumans(
        fake as never,
        [{ id: "conv-x", lastCustomerMessageAt: new Date(NOW).toISOString() }],
        { now: NOW }
      )
    ).rejects.toThrow(/no se pudo comprobar/i);
  });

  /**
   * Caso 8: el barrido mira ciento y pico de conversaciones. Preguntar una
   * por una serían ciento y pico de viajes — por eso el lote hace UNA sola
   * consulta, con un umbral que acota sin perder ninguna fila relevante:
   * `min(now − G, min(lcma de todas las filas))`.
   */
  it("hace UNA sola consulta a messages, con el umbral min(now − G, min lcma)", async () => {
    const lcmaVieja = new Date(NOW - 100 * 60_000).toISOString(); // la más vieja de las lcma
    const lcmaReciente = new Date(NOW - 5 * 60_000).toISOString();
    const fake = fakeMessagesTable([]);

    await conversationsWrittenByHumans(
      fake as never,
      [
        { id: "conv-vieja", lastCustomerMessageAt: lcmaVieja },
        { id: "conv-reciente", lastCustomerMessageAt: lcmaReciente },
      ],
      { now: NOW, graceMinutes: 30 } // graceCutoff = NOW - 30min, más reciente que lcmaVieja
    );

    expect(fake.llamadas).toHaveLength(1);
    expect(fake.llamadas[0].tipo).toBe("lote");
    // min(NOW - 30min, min(lcmaVieja, lcmaReciente)) = min(NOW-30min, NOW-100min) = NOW-100min = lcmaVieja.
    expect(fake.llamadas[0].umbral).toBe(lcmaVieja);
  });
});

describe("humanGraceMinutes", () => {
  const original = process.env.AI_HUMAN_GRACE_MINUTES;

  afterEach(() => {
    if (original === undefined) delete process.env.AI_HUMAN_GRACE_MINUTES;
    else process.env.AI_HUMAN_GRACE_MINUTES = original;
  });

  it("sin la variable, 30 por default", () => {
    delete process.env.AI_HUMAN_GRACE_MINUTES;
    expect(humanGraceMinutes()).toBe(30);
  });

  it('"45" da 45', () => {
    process.env.AI_HUMAN_GRACE_MINUTES = "45";
    expect(humanGraceMinutes()).toBe(45);
  });

  it.each(["abc", "0", "-5"])('"%s" cae al default de 30', (valor) => {
    process.env.AI_HUMAN_GRACE_MINUTES = valor;
    expect(humanGraceMinutes()).toBe(30);
  });
});

describe("humanClaimsChat (caso 9: la regla, pura)", () => {
  it("caso 1 — humano después de lcma: bloquea", () => {
    const lcma = NOW - 60 * 60_000;
    const humano = NOW - 45 * 60_000;
    expect(humanClaimsChat(new Date(humano).toISOString(), new Date(lcma).toISOString(), NOW, G)).toBe(true);
  });

  it("caso 2 — humano antes de lcma y hace más de G: no bloquea", () => {
    const lcma = NOW - 5 * 60_000;
    const humano = NOW - 45 * 60_000;
    expect(humanClaimsChat(new Date(humano).toISOString(), new Date(lcma).toISOString(), NOW, G)).toBe(false);
  });

  it("caso 3 — humano antes de lcma pero hace menos de G: bloquea", () => {
    const lcma = NOW - 2 * 60_000;
    const humano = NOW - 5 * 60_000;
    expect(humanClaimsChat(new Date(humano).toISOString(), new Date(lcma).toISOString(), NOW, G)).toBe(true);
  });

  it("caso 4 — sin humano: no bloquea", () => {
    const lcma = NOW - 5 * 60_000;
    expect(humanClaimsChat(null, new Date(lcma).toISOString(), NOW, G)).toBe(false);
  });

  it("caso 5 — lcma null: no bloquea", () => {
    const humano = NOW - 1 * 60_000;
    expect(humanClaimsChat(new Date(humano).toISOString(), null, NOW, G)).toBe(false);
  });
});
