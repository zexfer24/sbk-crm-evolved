import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Playbook } from "@/lib/types";
import type { Intent } from "@/lib/ai/classify";

// ---------------------------------------------------------------------------
// Fake de Supabase acotado a lo que el orquestador realmente consulta.
// ---------------------------------------------------------------------------
interface FakeState {
  aiGloballyEnabled: boolean;
  /** Lo que devuelve la función agent_can_run() de la base. */
  canRun: boolean;
  conversation: Record<string, unknown> | null;
  history: { sender_type: string; content: string | null; is_internal_note: boolean }[];
  historyOrderAscending: boolean | null;
  /** Claves encendidas en public.agent_tools. */
  enabledToolKeys: string[];
  /** Qué devuelve el upsert de contact_tags. Sirve para probar que un fallo etiquetando no frena el turno. */
  tagUpsertError: { message: string } | null;
  /**
   * Mensajes de asesor humano en la conversación. Con uno solo, el turno no
   * corre: el chat es de esa persona. Ver src/lib/ai/human-handled.ts.
   */
  humanMessages: { id: string }[];
  /** Fallo al preguntar si escribió una persona. La guarda falla cerrado. */
  humanMessagesError: { message: string } | null;
}

const state: FakeState = {
  aiGloballyEnabled: true,
  canRun: true,
  conversation: null,
  history: [],
  historyOrderAscending: null,
  enabledToolKeys: [],
  tagUpsertError: null,
  humanMessages: [],
  humanMessagesError: null,
};
const conversationUpdates: Record<string, unknown>[] = [];
const agentTurnInserts: Record<string, unknown>[] = [];
const contactTagUpserts: { rows: unknown; options: unknown }[] = [];
/**
 * Bitácora del orden real de los tres pasos del escenario. El requisito no es
 * solo que las tres cosas pasen: es que la etiqueta esté puesta ANTES de que
 * el asesor reciba el caso.
 */
const pasos: string[] = [];

function createFakeSupabase() {
  return {
    rpc(fn: string) {
      // Igual que la función SQL: junta el interruptor global y el tope de gasto.
      if (fn === "agent_can_run") {
        return Promise.resolve({ data: state.aiGloballyEnabled && state.canRun, error: null });
      }
      throw new Error(`Fake Supabase: rpc no soportada: ${fn}`);
    },
    from(table: string) {
      if (table === "agent_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { ai_globally_enabled: state.aiGloballyEnabled } }),
            }),
          }),
        };
      }

      if (table === "conversations") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: state.conversation }) }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: () => {
              // Adquisición del lock: encadena un segundo .eq() y un .select().
              if (values.ai_turn_running === true) {
                return { eq: () => ({ select: async () => ({ data: [{ id: "conv-1" }] }) }) };
              }
              conversationUpdates.push(values);
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }

      if (table === "messages") {
        return {
          select: () => ({
            eq: () => ({
              // Se guarda cómo se pidió el orden: la IA tiene que leer los
              // mensajes MÁS RECIENTES, no los más antiguos.
              order: (_col: string, opts: { ascending: boolean }) => {
                state.historyOrderAscending = opts.ascending;
                return { limit: async () => ({ data: state.history }) };
              },
              // Segundo .eq(): la comprobación de si un asesor escribió acá.
              // Se lee `state` en el momento de la llamada, no al construir el
              // fake: es lo que deja que un asesor "entre" a mitad de turno.
              eq: () => ({
                limit: async () => ({
                  data: state.humanMessagesError ? null : state.humanMessages,
                  error: state.humanMessagesError,
                }),
              }),
            }),
          }),
        };
      }

      if (table === "agent_tools") {
        return {
          select: () => ({
            eq: async () => ({ data: state.enabledToolKeys.map((key) => ({ key })), error: null }),
          }),
        };
      }

      if (table === "contact_tags") {
        return {
          upsert: (rows: unknown, options: unknown) => {
            contactTagUpserts.push({ rows, options });
            pasos.push("etiquetar");
            return Promise.resolve({ data: null, error: state.tagUpsertError });
          },
        };
      }

      if (table === "agent_turns") {
        return {
          insert: (row: Record<string, unknown>) => {
            agentTurnInserts.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }

      throw new Error(`Fake Supabase: tabla no soportada: ${table}`);
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createFakeSupabase() }));

const matchPlaybookMock = vi.fn();
const fetchActivePlaybooksMock = vi.fn(async () => [] as Playbook[]);
/** Si este escenario ya salió en este chat dentro de la ventana de repetición. */
const playbookSentRecentlyMock = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => false);
vi.mock("@/lib/ai/playbooks", () => ({
  matchPlaybook: (...args: unknown[]) => matchPlaybookMock(...args),
  fetchActivePlaybooks: () => fetchActivePlaybooksMock(),
  playbookSentRecently: (...args: unknown[]) => playbookSentRecentlyMock(...args),
}));

type AnyMock = (...args: unknown[]) => Promise<unknown>;

const sendPlaybookReplyMock = vi.fn<AnyMock>(async () => undefined);
const sendAgentTextMock = vi.fn<AnyMock>(async () => undefined);
// Los envíos se fingen; `playbookMessageText` no. Es lo que compone el texto
// que sale, y el turno lo usa para reconocer su propio mensaje en el
// historial: fingirlo acá sería escribir dos veces la misma regla y probar la
// copia. Ver alreadySentPlaybook en agent.ts.
vi.mock("@/lib/ai/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/send")>()),
  sendPlaybookReply: (...args: unknown[]) => sendPlaybookReplyMock(...args),
  sendAgentText: (...args: unknown[]) => sendAgentTextMock(...args),
}));

interface FakeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokenDetails?: { noCacheTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

const classifyIntentMock = vi.fn<() => Promise<{ intent: Intent; usage: FakeUsage }>>(async () => ({
  intent: "consulta_disponibilidad",
  usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
}));
vi.mock("@/lib/ai/classify", () => ({ classifyIntent: () => classifyIntentMock() }));

const escalateConversationMock = vi.fn<AnyMock>(async () => ({ escalated: true, assignedAgentName: "María" }));
vi.mock("@/lib/ai/escalate", () => ({
  escalateConversation: (...args: unknown[]) => escalateConversationMock(...args),
  RECLAMO_CATEGORIES: ["Envío", "Pago", "Producto", "Atención", "Garantía"],
}));

/** `steps` es lo que el turno mira para saber cuántos pasos gastó de verdad. */
const generateMock = vi.fn<() => Promise<{ text: string; usage: FakeUsage; steps: unknown[] }>>(
  async () => ({
    text: "respuesta redactada por el modelo",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    steps: [{}, {}],
  })
);
/** Opciones con las que se construyó el ToolLoopAgent: es donde viajan las instrucciones. */
const agentOptions: { instructions: string; tools: Record<string, unknown> }[] = [];
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  ToolLoopAgent: class {
    constructor(options: { instructions: string; tools: Record<string, unknown> }) {
      agentOptions.push(options);
    }
    generate = generateMock;
  },
}));

vi.mock("@/lib/ai/model", () => ({
  getAgentModel: () => ({ model: "modelo-falso" }),
  currentAgentModelLabel: () => "fake/modelo",
}));

vi.mock("@/lib/ai/tools", () => ({
  buildCatalogTool: () => ({}),
  buildEscalateTool: () => ({}),
  buildOrderHistoryTool: () => ({}),
}));

vi.mock("@/lib/ai/knowledge", () => ({
  buildKnowledgeTool: () => ({}),
}));

import { runAgentTurn } from "@/lib/ai/agent";
import { OFF_TOPIC_REPLY, SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { log } from "@/lib/log";

function playbook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "pb-1",
    name: "Catálogo general",
    triggerDescription: "el cliente pide el catálogo",
    responseText: "Claro, por acá te dejo el catálogo:",
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    isActive: true,
    tags: [],
    ...overrides,
  };
}

const NO_USAGE = { inputTokens: 3, outputTokens: 1, totalTokens: 4 };

beforeEach(() => {
  state.aiGloballyEnabled = true;
  state.canRun = true;
  state.conversation = {
    id: "conv-1",
    contact_id: "contact-1",
    ai_enabled: true,
    assigned_agent_id: null,
    welcome_sent_at: "2026-08-22T10:00:00Z",
    last_customer_message_at: new Date().toISOString(),
    contact: { phone_number: "+584121112233" },
    channel: { phone_number_id: null, status: "demo" },
  };
  state.history = [{ sender_type: "customer", content: "hola quiero accesorios", is_internal_note: false }];
  state.historyOrderAscending = null;
  state.enabledToolKeys = ["buscar_repuesto", "buscar_historial_compras", "consultar_biblioteca"];
  state.tagUpsertError = null;
  state.humanMessages = [];
  state.humanMessagesError = null;
  conversationUpdates.length = 0;
  agentTurnInserts.length = 0;
  contactTagUpserts.length = 0;
  pasos.length = 0;
  agentOptions.length = 0;
  vi.clearAllMocks();
  fetchActivePlaybooksMock.mockResolvedValue([]);
  matchPlaybookMock.mockResolvedValue({ playbook: null, usage: NO_USAGE });
  playbookSentRecentlyMock.mockResolvedValue(false);
  classifyIntentMock.mockResolvedValue({
    intent: "consulta_disponibilidad",
    usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
  });
  generateMock.mockResolvedValue({
    text: "respuesta redactada por el modelo",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    steps: [{}, {}],
  });
  sendPlaybookReplyMock.mockImplementation(async () => {
    pasos.push("responder");
  });
  escalateConversationMock.mockImplementation(async () => {
    pasos.push("escalar");
    return { escalated: true, assignedAgentName: "María" };
  });
});

describe("runAgentTurn — historial", () => {
  /**
   * Con `ascending: true` y `limit(30)` se traían los TREINTA MÁS ANTIGUOS.
   * En un cliente recurrente eso significa que la IA lee la conversación de
   * hace semanas y nunca ve el mensaje al que tiene que responder.
   */
  it("lee los mensajes más recientes, no los primeros de la conversación", async () => {
    await runAgentTurn("conv-1");

    expect(state.historyOrderAscending).toBe(false);
  });

  it("se los pasa al modelo en orden cronológico, del más viejo al más nuevo", async () => {
    // Tal como los devuelve la consulta: del más nuevo al más viejo.
    state.history = [
      { sender_type: "customer", content: "para una Bera", is_internal_note: false },
      { sender_type: "customer", content: "tienen carburador", is_internal_note: false },
      { sender_type: "customer", content: "hola", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    const enviados = matchPlaybookMock.mock.calls[0][0] as { content: string }[];
    expect(enviados.map((m) => m.content)).toEqual(["hola", "tienen carburador", "para una Bera"]);
  });
});

describe("runAgentTurn — ventana de 24 h de Meta", () => {
  const HACE_25_HORAS = () => new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  /**
   * Fuera de la ventana Meta solo acepta una plantilla aprobada, y no hay
   * ninguna configurada. Sin esta guarda el turno corría completo —clasificar,
   * herramientas, redactar— para producir un mensaje que el cliente nunca ve
   * y una fila en `messages` diciendo que salió.
   */
  it("no atiende una conversación cuyo último mensaje del cliente tiene más de 24 h", async () => {
    state.conversation = { ...state.conversation, last_customer_message_at: HACE_25_HORAS() };

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * El caso que motiva que la guarda esté acá y no solo en la consulta que
   * elige a quién atender: el repaso del atraso encola de una vez y drena a lo
   * largo de una hora, así que una conversación puede cruzar el borde entre
   * que se encoló y que le toca el turno.
   */
  it("tampoco la atiende si un escenario coincidiría", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    state.conversation = { ...state.conversation, last_customer_message_at: HACE_25_HORAS() };

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /** Sin ningún mensaje del cliente no hay ventana abierta: falla cerrado. */
  it("no atiende una conversación sin ningún mensaje del cliente", async () => {
    state.conversation = { ...state.conversation, last_customer_message_at: null };

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  it("dentro de la ventana atiende con normalidad", async () => {
    state.conversation = {
      ...state.conversation,
      last_customer_message_at: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
    };

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });
});

describe("runAgentTurn — escenarios predeterminados", () => {
  /**
   * Lo que el escenario ahorra es la parte cara: redactar con el tool loop.
   *
   * La clasificación de intención ya no se ahorra, y es a propósito — sale en
   * paralelo con el reconocimiento de escenario para no encadenar dos esperas
   * de dos segundos. En el camino de escenario esa llamada se desperdicia; son
   * unos centavos a cambio de dos segundos en TODOS los turnos.
   */
  it("cuando un escenario coincide, responde con él y no llama al modelo redactor", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(sendPlaybookReplyMock.mock.calls[0][2]).toEqual(pb);
    expect(generateMock).not.toHaveBeenCalled();
  });

  /**
   * El escenario se manda una vez, no una por mensaje.
   *
   * El reconocimiento mira el hilo entero y elige el escenario que calza con
   * la conversación, así que mientras se siga hablando del catálogo el mismo
   * escenario vuelve a ganar en cada turno. Sin guarda, el cliente recibía el
   * mismo texto una y otra vez: preguntaba algo, le llegaba otra vez el
   * catálogo, repreguntaba, y otra vez.
   *
   * Es la misma guarda que ya tenía la redirección de fuera de tema, con la
   * misma regla: si nuestra última respuesta fue ESA, no se repite.
   */
  it("no repite el escenario que acaba de mandar: sigue por el flujo genérico", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    // Del más nuevo al más viejo, como los devuelve la consulta.
    state.history = [
      { sender_type: "customer", content: "y tienen para una AX100?", is_internal_note: false },
      { sender_type: "ai", content: pb.responseText, is_internal_note: false },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    // No se queda callado: el cliente preguntó algo y el turno lo contesta.
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  /**
   * El caso que la guarda del historial NO alcanza a ver, y que es justo el
   * que produce el bucle.
   *
   * Frenar el escenario hace que el turno caiga al flujo genérico y conteste
   * con otra cosa. En el turno siguiente, nuestra última respuesta ya no es el
   * catálogo sino esa otra cosa — así que el historial dice "no lo mandé" y el
   * escenario vuelve a salir. Catálogo, genérico, catálogo, genérico. La
   * ventana de seis horas es la que corta eso, porque no mira la última
   * respuesta sino si el escenario salió hace poco.
   */
  it("no lo manda si ya salió hace poco, aunque en el medio hayamos dicho otra cosa", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    playbookSentRecentlyMock.mockResolvedValue(true);
    // Del más nuevo al más viejo, como los devuelve la consulta.
    state.history = [
      { sender_type: "customer", content: "Talla s", is_internal_note: false },
      { sender_type: "ai", content: "Tenemos varios modelos, ¿cuál te interesa?", is_internal_note: false },
      { sender_type: "customer", content: "Precio y si hay talla s", is_internal_note: false },
      { sender_type: "ai", content: pb.responseText, is_internal_note: false },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    // Y el cliente no se queda sin respuesta: contesta el flujo genérico.
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("pregunta por la ventana con el escenario y la conversación de este turno", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(playbookSentRecentlyMock).toHaveBeenCalledWith(expect.anything(), "conv-1", pb.id);
  });

  /**
   * La consulta cuesta un viaje a la base y el historial ya está en memoria:
   * si el propio hilo ya delata la repetición, no hace falta preguntar.
   */
  it("no gasta la consulta cuando el historial ya delata la repetición", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    state.history = [
      { sender_type: "customer", content: "y tienen para una AX100?", is_internal_note: false },
      { sender_type: "ai", content: pb.responseText, is_internal_note: false },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(playbookSentRecentlyMock).not.toHaveBeenCalled();
  });

  /**
   * Ninguna de las dos redes es "una vez por conversación". Pasada la ventana,
   * el cliente que vuelve a pedir el catálogo lo está pidiendo de verdad y
   * tiene que recibirlo —con su adjunto, que es lo único que el flujo
   * genérico no sabe mandar—.
   */
  it("fuera de la ventana sí lo manda de nuevo", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    state.history = [
      { sender_type: "customer", content: "me lo pasas otra vez?", is_internal_note: false },
      { sender_type: "ai", content: "Sí, tenemos ese filtro en stock.", is_internal_note: false },
      { sender_type: "customer", content: "tienen filtro de aceite?", is_internal_note: false },
      { sender_type: "ai", content: pb.responseText, is_internal_note: false },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Con adjunto de tipo enlace, lo que sale por WhatsApp es el texto MÁS la
   * URL pegada abajo — eso es lo que queda guardado en el historial, y es
   * contra eso que hay que comparar. Comparando solo contra `responseText`,
   * la guarda no reconocía su propio mensaje y el catálogo salía otra vez.
   */
  it("reconoce su mensaje aunque el escenario lleve un enlace pegado", async () => {
    const pb = playbook({
      attachmentType: "link",
      attachmentUrl: "https://sbk.example/catalogo",
    });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    state.history = [
      { sender_type: "customer", content: "gracias!", is_internal_note: false },
      {
        sender_type: "ai",
        content: `${pb.responseText}\n\n${pb.attachmentUrl}`,
        is_internal_note: false,
      },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  it("clasifica en paralelo en vez de esperar a saber si hay escenario", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
  });

  /**
   * El riesgo de lanzarlas juntas: clasificar SÍ lanza ante un fallo del
   * proveedor, y su excepción no puede llevarse por delante un escenario que
   * el otro brazo reconoció perfectamente. En serie no podía pasar —el
   * escenario ya había ganado el turno—, así que es un modo de fallo nuevo.
   */
  it("un fallo al clasificar no tumba el escenario que sí se reconoció", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    classifyIntentMock.mockRejectedValue(new Error("429 del proveedor"));

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(agentTurnInserts[0]).toMatchObject({ playbook_id: "pb-1", action: "answered" });
  });

  it("registra en la bitácora qué escenario resolvió el turno y con qué mensaje del cliente", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({
      playbook_id: "pb-1",
      customer_message: "hola quiero accesorios",
      action: "answered",
      // Escenario + clasificación: la segunda ya se pagó aunque su resultado
      // no se use, y el panel de gasto tiene que verla.
      total_tokens: 10,
    });
  });

  it("un escenario con after_send 'escalate' pasa la conversación a un asesor", async () => {
    const pb = playbook({ afterSend: "escalate", name: "Guía de envío · Cashea" });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(escalateConversationMock.mock.calls[0][1]).toMatchObject({
      conversationId: "conv-1",
      motivo: "seguimiento",
    });
    expect(agentTurnInserts[0]).toMatchObject({ action: "escalated" });
  });

  it("un escenario con after_send 'wait' deja la conversación libre, sin escalar", async () => {
    const pb = playbook({ afterSend: "wait" });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(conversationUpdates).toContainEqual(expect.objectContaining({ journey_stage: null }));
  });

  it("sin escenarios cargados, el turno sigue por el flujo genérico de siempre", async () => {
    fetchActivePlaybooksMock.mockResolvedValue([]);

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });

  it("cuando ningún escenario coincide, suma los tokens del reconocimiento a los del turno", async () => {
    fetchActivePlaybooksMock.mockResolvedValue([playbook()]);
    matchPlaybookMock.mockResolvedValue({ playbook: null, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(generateMock).toHaveBeenCalledTimes(1);
    // 4 (reconocimiento) + 6 (clasificación) + 28 (redacción)
    expect(agentTurnInserts[0]).toMatchObject({ total_tokens: 38, playbook_id: null });
  });

  it("no reconoce escenarios si la IA está apagada globalmente", async () => {
    state.aiGloballyEnabled = false;
    fetchActivePlaybooksMock.mockResolvedValue([playbook()]);

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * El tope de gasto vive en la base (agent_can_run) para que la respuesta
   * sea la misma sin importar quién pregunte. Alcanzado el tope, el turno no
   * llama al modelo: ni para reconocer escenario ni para clasificar.
   */
  it("no corre el turno cuando ya se alcanzó el tope de gasto del día", async () => {
    state.canRun = false;
    fetchActivePlaybooksMock.mockResolvedValue([playbook()]);

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  it("no reconoce escenarios si la conversación ya tiene un asesor asignado", async () => {
    state.conversation = { ...state.conversation, assigned_agent_id: "agent-9" };
    fetchActivePlaybooksMock.mockResolvedValue([playbook()]);

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });
});

describe("runAgentTurn — etiquetas del escenario", () => {
  const ENVIO = { id: "tag-envio", label: "Envio", color: "accent" as const };
  const PENDIENTE = { id: "tag-pendiente", label: "pendiente-venta", color: "warning" as const };

  function conEtiquetas(tags: { id: string; label: string; color: "accent" | "warning" }[], afterSend: "wait" | "escalate" = "wait") {
    const pb = playbook({ tags, afterSend });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    return pb;
  }

  it("etiqueta el contacto con todas las etiquetas del escenario", async () => {
    conEtiquetas([ENVIO, PENDIENTE]);

    await runAgentTurn("conv-1");

    expect(contactTagUpserts).toHaveLength(1);
    expect(contactTagUpserts[0].rows).toEqual([
      { contact_id: "contact-1", tag_id: "tag-envio" },
      { contact_id: "contact-1", tag_id: "tag-pendiente" },
    ]);
  });

  /**
   * El escenario puede dispararse muchas veces con el mismo contacto. Sin
   * esto, cada repetición le pisaría la fecha a una etiqueta que ya estaba.
   */
  it("no pisa una etiqueta que el contacto ya tenía", async () => {
    conEtiquetas([ENVIO]);

    await runAgentTurn("conv-1");

    expect(contactTagUpserts[0].options).toEqual({ ignoreDuplicates: true });
  });

  /**
   * Lo pidió el cliente en estos términos: "etiquetar el chat antes de
   * pasarlo a un asesor". Si el orden se invierte, el asesor abre el caso sin
   * clasificar y lo ve cambiar después.
   */
  it("etiqueta ANTES de escalar, y ambas cosas después de responder", async () => {
    conEtiquetas([ENVIO], "escalate");

    await runAgentTurn("conv-1");

    expect(pasos).toEqual(["responder", "etiquetar", "escalar"]);
  });

  it("un escenario en 'wait' también etiqueta: no hace falta que escale", async () => {
    conEtiquetas([ENVIO], "wait");

    await runAgentTurn("conv-1");

    expect(pasos).toEqual(["responder", "etiquetar"]);
    expect(escalateConversationMock).not.toHaveBeenCalled();
  });

  /** El escenario que existía antes de esta función tiene que seguir funcionando igual. */
  it("un escenario sin etiquetas no toca contact_tags", async () => {
    conEtiquetas([]);

    await runAgentTurn("conv-1");

    expect(contactTagUpserts).toHaveLength(0);
    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
  });

  /**
   * El mensaje al cliente ya salió cuando esto corre. Un fallo etiquetando no
   * puede impedir que el caso llegue a un humano — eso sería cambiar una
   * marca de color por un cliente sin atender.
   */
  it("si el etiquetado falla, el escalamiento sigue adelante igual", async () => {
    state.tagUpsertError = { message: "permiso denegado" };
    conEtiquetas([ENVIO], "escalate");

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(agentTurnInserts[0].action).toBe("escalated");
  });

  /** Un id en la bitácora no le dice nada a quien la lee: van los nombres. */
  it("deja en la bitácora del turno qué etiquetas puso", async () => {
    conEtiquetas([ENVIO, PENDIENTE]);

    await runAgentTurn("conv-1");

    expect(agentTurnInserts[0].summary).toContain("Etiquetas: Envio, pendiente-venta.");
  });
});

/**
 * La carrera del 27 de agosto de 2026, reconstruida con los tiempos medidos
 * ese día en producción.
 *
 * Conversación c2b0a79b:
 *
 *   16:30:26.892  ASESOR  «Nos queda 1 talla ese»
 *   16:30:29.585  IA      «Catálogo cascos 🪖 …»   ← 2,7 s después, encima
 *
 * `runAgentTurn` preguntaba `humanHasWritten` al ABRIR el turno y no volvía a
 * preguntarlo nunca. Entre esa mirada y el envío pasan de 3 a 10 segundos
 * (`turno_tiempos` de ese día: clasificar 2,2–3,5 s, redactar 3,5–6,5 s,
 * entregar 0,83–1,14 s). El asesor entró justo ahí.
 *
 * El reloj se controla a mano para que los tramos duren lo que duraron: sin
 * eso la prueba diría "el asesor escribió en algún momento", que es una
 * afirmación mucho más débil que "escribió dentro del hueco real".
 */
describe("runAgentTurn — un asesor se mete mientras el turno corre", () => {
  const APERTURA = Date.parse("2026-08-27T16:30:19.900Z");
  /** Fin de la clasificación: 2,2 s, el tramo más rápido que se midió. */
  const FIN_CLASIFICACION = APERTURA + 2_200;
  /** El instante exacto en que el asesor mandó «Nos queda 1 talla ese». */
  const ASESOR_ESCRIBE = Date.parse("2026-08-27T16:30:26.892Z");
  /** Fin de la redacción: 6,5 s, el tramo más lento que se midió. */
  const FIN_REDACCION = APERTURA + 8_700;

  let reloj = APERTURA;

  beforeEach(() => {
    reloj = APERTURA;
    vi.spyOn(Date, "now").mockImplementation(() => reloj);
  });

  // El reloj vuelve a ser el de verdad al salir: un `Date.now` congelado que
  // se filtre al resto del archivo rompe las pruebas de tiempos del turno.
  afterEach(() => {
    vi.mocked(Date.now).mockRestore();
  });

  /** El asesor escribe en medio de la redacción, como pasó de verdad. */
  function elAsesorEntraRedactando() {
    generateMock.mockImplementation(async () => {
      reloj = ASESOR_ESCRIBE;
      state.humanMessages = [{ id: "msg-del-asesor" }];
      reloj = FIN_REDACCION;
      return {
        text: "Claro, tenemos varios cascos disponibles.",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });
  }

  function laClasificacionTarda() {
    classifyIntentMock.mockImplementation(async () => {
      reloj = FIN_CLASIFICACION;
      return {
        intent: "consulta_disponibilidad" as const,
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      };
    });
  }

  it("no envía el texto redactado: el asesor escribió dentro del hueco", async () => {
    laClasificacionTarda();
    elAsesorEntraRedactando();

    await runAgentTurn("conv-1");

    // Que el modelo SÍ haya redactado es la mitad que importa: prueba que el
    // turno llegó hasta el envío y se frenó ahí, no que murió al abrirse por
    // la guarda que ya existía.
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  /** Sin asesor de por medio el mismo turno, con los mismos tiempos, sí habla. */
  it("con el hueco vacío el mismo turno sí envía", async () => {
    laClasificacionTarda();
    generateMock.mockImplementation(async () => {
      reloj = FIN_REDACCION;
      return {
        text: "Claro, tenemos varios cascos disponibles.",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });

  /**
   * El evento va aparte de `turno_chat_de_una_persona` —el frenado al abrir—
   * porque cuentan cosas distintas: aquel cuenta chats que la IA no tocó, este
   * cuenta carreras perdidas. Es el número con el que se mide si el hueco
   * sigue abierto.
   */
  it("deja en el registro un evento propio, distinto del frenado al abrir", async () => {
    const warn = vi.spyOn(log, "warn");
    laClasificacionTarda();
    elAsesorEntraRedactando();

    await runAgentTurn("conv-1");

    expect(warn).toHaveBeenCalledWith("turno_persona_se_adelanto", {
      conversationId: "conv-1",
      fase: "redaccion",
    });
    expect(warn).not.toHaveBeenCalledWith("turno_chat_de_una_persona", expect.anything());
  });

  /** El camino más corto del turno tiene la misma puerta que el más largo. */
  it("tampoco sale el escenario si el asesor se adelantó mientras se reconocía", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockImplementation(async () => {
      reloj = ASESOR_ESCRIBE;
      state.humanMessages = [{ id: "msg-del-asesor" }];
      return { playbook: pb, usage: NO_USAGE };
    });

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    // Ni etiqueta ni escala: todo eso acompaña a un mensaje que no salió.
    expect(contactTagUpserts).toHaveLength(0);
    expect(escalateConversationMock).not.toHaveBeenCalled();
  });

  it("tampoco sale la redirección de fuera de tema", async () => {
    classifyIntentMock.mockImplementation(async () => {
      reloj = ASESOR_ESCRIBE;
      state.humanMessages = [{ id: "msg-del-asesor" }];
      return {
        intent: "fuera_de_tema" as const,
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      };
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  /**
   * Misma regla que la comprobación de apertura: si no se puede preguntar, no
   * se escribe. El costo de los dos lados no se parece — no contestar deja a
   * un cliente esperando un rato más; contestar encima de un asesor le escribe
   * a alguien que está a mitad de una venta.
   */
  it("si no se puede comprobar quién escribió, no envía", async () => {
    laClasificacionTarda();
    generateMock.mockImplementation(async () => {
      state.humanMessagesError = { message: "connection reset" };
      reloj = FIN_REDACCION;
      return {
        text: "Claro, tenemos varios cascos disponibles.",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await runAgentTurn("conv-1");

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });
});

describe("runAgentTurn — mensajes fuera de tema", () => {
  /**
   * Antes esto caía en "otro", que arranca el tool loop: el turno más caro
   * que existe, gastado en alguien que no es un cliente. Ahora termina en la
   * clasificación y el texto sale de una constante, sin costo de salida.
   */
  it("responde con el texto fijo y no llama al modelo redactor", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "fuera_de_tema",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });

    await runAgentTurn("conv-1");

    expect(generateMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe(OFF_TOPIC_REPLY);
    expect(agentTurnInserts[0]).toMatchObject({ intent: "fuera_de_tema", action: "answered" });
  });

  /**
   * Si alguien insiste, repetir la misma línea es un ping-pong que puede
   * durar indefinidamente — y del otro lado bien puede haber otro bot. Se
   * contesta una vez; a la segunda se calla, pero el turno igual queda en la
   * bitácora para que se vea en el panel.
   */
  it("no vuelve a contestar si su última respuesta ya fue la redirección", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "fuera_de_tema",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    // Del más nuevo al más viejo, como los devuelve la consulta.
    state.history = [
      { sender_type: "customer", content: "dale va, ayúdame igual", is_internal_note: false },
      { sender_type: "ai", content: OFF_TOPIC_REPLY, is_internal_note: false },
      { sender_type: "customer", content: "escríbeme un poema", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(agentTurnInserts).toHaveLength(1);
  });
});

describe("runAgentTurn — instrucciones que recibe el modelo", () => {
  it("le pasa el bloque estático como prefijo exacto, para que el caché lo reconozca", async () => {
    await runAgentTurn("conv-1");

    expect(agentOptions).toHaveLength(1);
    expect(agentOptions[0].instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
  });

  /**
   * La plantilla de bienvenida solo sale si WHATSAPP_WELCOME_TEMPLATE está
   * configurada. Sin ella `welcome_sent_at` queda en null y no saluda nadie:
   * el cliente recibiría su primera respuesta en seco.
   */
  it("manda saludar cuando la conversación nunca recibió bienvenida", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };

    await runAgentTurn("conv-1");

    expect(agentOptions[0].instructions.slice(SYSTEM_PROMPT.length)).toMatch(/saluda/i);
  });

  it("no manda saludar si la bienvenida ya salió", async () => {
    await runAgentTurn("conv-1");

    expect(agentOptions[0].instructions.slice(SYSTEM_PROMPT.length)).not.toMatch(/saluda/i);
  });
});

describe("runAgentTurn — interruptores de herramientas", () => {
  it("con todo encendido, una consulta lleva catálogo, biblioteca y escalamiento", async () => {
    await runAgentTurn("conv-1");

    expect(Object.keys(agentOptions[0].tools).sort()).toEqual([
      "buscarRepuesto",
      "consultarBiblioteca",
      "escalarAAsesor",
    ]);
  });

  /**
   * El pedido que motivó los interruptores: apagar la consulta de productos
   * sin apagar la IA. El turno corre, pero sin la herramienta — y con la
   * instrucción explícita de no cotizar de memoria, que es el riesgo real.
   */
  it("con el catálogo apagado, el turno corre sin esa herramienta y avisa al modelo", async () => {
    state.enabledToolKeys = ["buscar_historial_compras", "consultar_biblioteca"];

    await runAgentTurn("conv-1");

    expect(agentOptions[0].tools).not.toHaveProperty("buscarRepuesto");
    expect(agentOptions[0].instructions.slice(SYSTEM_PROMPT.length)).toMatch(/catálogo está apagada/);
  });

  it("con la biblioteca apagada, la herramienta no viaja", async () => {
    state.enabledToolKeys = ["buscar_repuesto", "buscar_historial_compras"];

    await runAgentTurn("conv-1");

    expect(agentOptions[0].tools).not.toHaveProperty("consultarBiblioteca");
    expect(agentOptions[0].tools).toHaveProperty("buscarRepuesto");
  });

  /** Escalar no tiene interruptor: es la única salida hacia un humano. */
  it("escalar a un asesor viaja siempre, aunque todo lo demás esté apagado", async () => {
    state.enabledToolKeys = [];

    await runAgentTurn("conv-1");

    expect(agentOptions[0].tools).toHaveProperty("escalarAAsesor");
    expect(Object.keys(agentOptions[0].tools)).toHaveLength(1);
  });

  it("en una devolución, el historial de compras respeta su interruptor", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "devolucion",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    state.enabledToolKeys = ["buscar_repuesto", "consultar_biblioteca"];

    await runAgentTurn("conv-1");

    expect(agentOptions[0].tools).not.toHaveProperty("buscarHistorialCompras");
    expect(agentOptions[0].tools).toHaveProperty("escalarAAsesor");
  });
});

describe("runAgentTurn — tokens cacheados", () => {
  /**
   * La entrada cacheada se factura mucho más barata que la normal. Sin
   * guardarla, el panel de costos cobra todo a precio completo y no hay
   * forma de saber si el prompt está cacheando de verdad o si alguien lo
   * rompió al editarlo.
   */
  it("registra cuántos tokens de entrada vinieron del caché", async () => {
    generateMock.mockResolvedValue({
      text: "respuesta redactada por el modelo",
      usage: {
        inputTokens: 2000,
        outputTokens: 8,
        totalTokens: 2008,
        inputTokenDetails: { noCacheTokens: 400, cacheReadTokens: 1600, cacheWriteTokens: 0 },
      },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(agentTurnInserts[0]).toMatchObject({ cached_input_tokens: 1600 });
  });

  it("guarda cero cuando el proveedor no informa caché", async () => {
    await runAgentTurn("conv-1");

    expect(agentTurnInserts[0]).toMatchObject({ cached_input_tokens: 0 });
  });
});

// ---------------------------------------------------------------------------
// Tiempos del turno
//
// El dueño pide respuesta en cuatro segundos. Para discutir ese número hay que
// saber dónde se van los que se van, y hasta ahora averiguarlo era restar a
// mano dos columnas de `messages`, conversación por conversación.
// ---------------------------------------------------------------------------
describe("runAgentTurn — tiempos del turno", () => {
  /** La línea estructurada que emite el turno, ya parseada. */
  function leerTiempos(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> | null {
    for (const [linea] of spy.mock.calls) {
      if (typeof linea !== "string") continue;
      const evento = JSON.parse(linea) as Record<string, unknown>;
      if (evento.event === "turno_tiempos") return evento;
    }
    return null;
  }

  it("registra cuánto tardó cada tramo y cuántos pasos gastó", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentTurn("conv-1");

      const tiempos = leerTiempos(spy);
      expect(tiempos).not.toBeNull();
      expect(tiempos).toMatchObject({
        conversationId: "conv-1",
        // Dos pasos del mock, contra el techo de cinco: es el dato que
        // contesta si MAX_STEPS = 5 es generoso o justo.
        pasos: 2,
        maxPasos: 5,
        entregado: true,
      });
      expect(typeof tiempos?.clasificacionMs).toBe("number");
      expect(typeof tiempos?.redaccionMs).toBe("number");
      expect(typeof tiempos?.envioMs).toBe("number");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * `esperaMs` es la ventana de silencio más la cola: el tramo que no se ve
   * desde dentro del turno y donde se fue casi todo el tiempo de la primera
   * noche (media de 4.521 s, con el tope de un turno por minuto puesto).
   */
  it("mide también la espera desde el mensaje del cliente", async () => {
    state.conversation = {
      ...state.conversation,
      last_customer_message_at: new Date(Date.now() - 8000).toISOString(),
    };

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentTurn("conv-1");

      const tiempos = leerTiempos(spy);
      expect(tiempos?.esperaMs).toBeGreaterThanOrEqual(8000);
      // El total es lo que mira el dueño: del mensaje del cliente a la
      // respuesta enviada, espera incluida.
      expect(tiempos?.totalMs).toBeGreaterThanOrEqual(tiempos?.esperaMs as number);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * En `finally`: el turno que revienta a los veinte segundos es justo el que
   * hay que poder ver, y es el que se perdería si esto colgara del camino
   * feliz.
   */
  it("registra los tiempos aunque el turno termine sin responder", async () => {
    generateMock.mockRejectedValue(new Error("el proveedor falló"));

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentTurn("conv-1");

      const tiempos = leerTiempos(spy);
      expect(tiempos).not.toBeNull();
      expect(tiempos).toMatchObject({ entregado: false, pasos: null });
      // El tramo que falló también se mide: cuánto tardó en fallar importa.
      expect(typeof tiempos?.redaccionMs).toBe("number");
    } finally {
      spy.mockRestore();
    }
  });
});
