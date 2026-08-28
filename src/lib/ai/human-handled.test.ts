import { beforeEach, describe, expect, it, vi } from "vitest";

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
// ---------------------------------------------------------------------------

interface MensajeFalso {
  sender_type: "customer" | "agent" | "ai" | "system";
  content: string;
  is_internal_note?: boolean;
}

interface ChatFalso {
  id: string;
  contactId: string;
  phoneNumber: string;
  mensajes: MensajeFalso[];
}

/**
 * Los cinco casos del incidente, textuales.
 *
 * En los cinco, lo último que escribió el cliente es un fragmento que solo
 * significa algo con el turno anterior delante — y el turno anterior es de un
 * asesor.
 */
const CHATS_DE_ASESORES: ChatFalso[] = [
  {
    id: "conv-1",
    contactId: "contacto-1",
    phoneNumber: "+584120000001",
    mensajes: [
      { sender_type: "agent", content: "Te paso el código de descuento: SBK15" },
      { sender_type: "customer", content: "Ok muchas gracias, igual metí el código y sale q no existe" },
    ],
  },
  {
    id: "conv-2",
    contactId: "contacto-2",
    phoneNumber: "+584120000002",
    mensajes: [
      { sender_type: "agent", content: "Listo, te lo aparto hasta mañana" },
      { sender_type: "customer", content: "🙌🏽" },
    ],
  },
  {
    id: "conv-3",
    contactId: "contacto-3",
    phoneNumber: "+584120000003",
    mensajes: [
      { sender_type: "agent", content: "Con Cashea te sale el envío gratis" },
      { sender_type: "customer", content: "Y si yo no quiero usar xq voy a pagar el monto completo" },
    ],
  },
  {
    id: "conv-4",
    contactId: "contacto-4",
    phoneNumber: "+584120000004",
    mensajes: [
      { sender_type: "agent", content: "¿Te reservo el par entonces?" },
      { sender_type: "customer", content: "Si" },
    ],
  },
  {
    id: "conv-5",
    contactId: "contacto-5",
    phoneNumber: "+584120000005",
    mensajes: [
      { sender_type: "agent", content: "¿De qué medida lo necesitas?" },
      { sender_type: "customer", content: "A él 20cm" },
      { sender_type: "customer", content: "Y en divisas ?" },
    ],
  },
];

/** El caso que la IA sí debe atender: nadie del equipo escribió nunca acá. */
const CHAT_SIN_TOCAR: ChatFalso = {
  id: "conv-nueva",
  contactId: "contacto-nueva",
  phoneNumber: "+584120000009",
  mensajes: [{ sender_type: "customer", content: "buenas, tienen cauchos para una Bera BR200?" }],
};

/**
 * Una nota interna también marca el chat como trabajado por una persona.
 *
 * El asesor todavía no le escribió al cliente, pero está en el caso. Ante la
 * duda la IA se queda afuera: el costo de los dos lados no se parece.
 */
const CHAT_CON_NOTA_INTERNA: ChatFalso = {
  id: "conv-nota",
  contactId: "contacto-nota",
  phoneNumber: "+584120000010",
  mensajes: [
    { sender_type: "customer", content: "necesito cambiar unos frenos" },
    { sender_type: "agent", content: "Cliente de la semana pasada, revisar garantía", is_internal_note: true },
  ],
};

const TODOS = [...CHATS_DE_ASESORES, CHAT_SIN_TOCAR, CHAT_CON_NOTA_INTERNA];

function porId(id: string): ChatFalso {
  const chat = TODOS.find((c) => c.id === id);
  if (!chat) throw new Error(`chat desconocido en la prueba: ${id}`);
  return chat;
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
                    last_customer_message_at: new Date().toISOString(),
                    contact: { phone_number: chat.phoneNumber },
                    channel: { phone_number_id: "pnid-1", status: "connected" },
                  },
                };
              },
            }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: (_c: string, id: string) =>
              values.ai_turn_running === true
                ? { eq: () => ({ select: async () => ({ data: [{ id }] }) }) }
                : Promise.resolve({ data: null, error: null }),
          }),
        };
      }

      if (table === "messages") {
        return {
          select: (columnas: string) => ({
            // La comprobación de human-handled: filtra por sender_type.
            eq: (_c: string, id: string) => {
              const base = {
                eq: (_c2: string, senderType: string) => ({
                  limit: async () => ({
                    data: porId(id).mensajes.filter((m) => m.sender_type === senderType),
                    error: null,
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
import { humanHasWritten } from "@/lib/ai/human-handled";

beforeEach(() => {
  enviados.length = 0;
  consultasAntesDeApagar = Number.POSITIVE_INFINITY;
  consultasAntesDeRomperse = Number.POSITIVE_INFINITY;
  consultasDelInterruptor = 0;
});

describe("la IA no le escribe a un cliente que está hablando con un asesor", () => {
  /**
   * Este es EL test. Es el que hay que poder enseñarle al dueño antes de
   * volver a encender.
   *
   * Los cinco chats tienen las tres guardas viejas en verde —nadie asignado,
   * IA encendida, el cliente escribió lo último— y en los cinco hay un asesor
   * en el hilo. El escenario que más daño hizo calza siempre. Aun así no sale
   * ni un mensaje.
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

describe("humanHasWritten", () => {
  it("reconoce el chat que tocó un asesor", async () => {
    const supabase = createFakeSupabase() as never;

    expect(await humanHasWritten(supabase, "conv-1")).toBe(true);
    expect(await humanHasWritten(supabase, "conv-nueva")).toBe(false);
  });

  /**
   * Falla cerrado. Si no se puede comprobar, la IA no entra.
   *
   * Al revés —seguir ante un error de red— es exactamente el comportamiento
   * que causó el incidente, y los dos lados no cuestan lo mismo: no contestar
   * deja a un cliente esperando un rato más; contestar encima de un asesor le
   * escribe a alguien que está a mitad de una venta.
   */
  it("lanza en vez de dejar pasar si no puede comprobarlo", async () => {
    const roto = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: async () => ({ data: null, error: { message: "se cayó la conexión" } }),
            }),
          }),
        }),
      }),
    } as never;

    await expect(humanHasWritten(roto, "conv-1")).rejects.toThrow(/no se pudo comprobar/i);
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
