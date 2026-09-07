import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Playbook } from "@/lib/types";
import type { Intent } from "@/lib/ai/classify";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";

// ---------------------------------------------------------------------------
// Fake de Supabase acotado a lo que el orquestador realmente consulta.
// ---------------------------------------------------------------------------
interface FakeState {
  aiGloballyEnabled: boolean;
  /** Lo que devuelve la función agent_can_run() de la base. */
  canRun: boolean;
  conversation: Record<string, unknown> | null;
  history: {
    sender_type: string;
    content: string | null;
    is_internal_note: boolean;
    /** T3.2 (5/9/2026): loadHistory salta 'unsupported' explícito, sin depender de que content sea null. */
    message_type?: string;
  }[];
  historyOrderAscending: boolean | null;
  /** Claves encendidas en public.agent_tools. */
  enabledToolKeys: string[];
  /** Qué devuelve el upsert de contact_tags. Sirve para probar que un fallo etiquetando no frena el turno. */
  tagUpsertError: { message: string } | null;
  /**
   * Mensajes de asesor humano en la conversación, con `created_at` (T7,
   * 8/9/2026: la guarda dejó de preguntar "¿alguna vez?" y ahora compara
   * fechas — ver human-handled.ts). Con uno cuyo `created_at` sea posterior a
   * `last_customer_message_at`, o de hace menos de la gracia configurada, el
   * turno no corre: el chat es de esa persona AHORA.
   */
  humanMessages: { created_at: string }[];
  /** Fallo al preguntar si escribió una persona. La guarda falla cerrado. */
  humanMessagesError: { message: string } | null;
  /**
   * Qué devuelve `ai_turn_lock_renew` (conversation-lock.ts). `true` de
   * fábrica: el lock nunca es el protagonista salvo en su propio describe.
   */
  turnLockRenewResult: { data: boolean | null; error: { message: string } | null };
  /**
   * El wamid del último mensaje ENTRANTE (T3.1, 4/9/2026): lo que
   * `fireTypingIndicator` necesita para el "message_id" que Meta exige.
   * `null` simula un chat sin ningún mensaje entrante con wamid.
   */
  lastInboundWamid: string | null;
  /**
   * Anexo B2 (5/9/2026): qué devuelve el UPDATE que marca `is_auto_reply`
   * sobre el mensaje de un escenario que escaló sin asesores. `null` de
   * fábrica — el UPDATE sale bien y el turno sigue igual.
   */
  messageUpdateError: { message: string } | null;
  /**
   * Frente B3 (5/9/2026): lo que trae la columna `business_hours` de la fila
   * de `agent_settings`. `undefined` de fábrica — sin columna, `parseBusinessHours`
   * cae al horario por defecto, que es como se comportaban todos los tests
   * escritos antes de este frente.
   */
  agentSettingsBusinessHours: unknown;
  /** Si viene con mensaje, la lectura de `agent_settings` falla — el turno no se cae por eso. */
  agentSettingsError: { message: string } | null;
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
  turnLockRenewResult: { data: true, error: null },
  lastInboundWamid: "wamid.ULTIMO_ENTRANTE",
  messageUpdateError: null,
  agentSettingsBusinessHours: undefined,
  agentSettingsError: null,
};
const conversationUpdates: Record<string, unknown>[] = [];
const agentTurnInserts: Record<string, unknown>[] = [];
const contactTagUpserts: { rows: unknown; options: unknown }[] = [];
/**
 * Anexo B2 (5/9/2026): cada UPDATE sobre `messages` (marcar `is_auto_reply`
 * en la despedida de un escenario que escaló sin asesores), con los valores y
 * los filtros que le llegaron encadenados.
 */
const messageUpdates: { values: Record<string, unknown>; filters: [string, unknown][] }[] = [];
/** Cada llamada a la RPC `record_handoff`, con los parámetros que le llegaron. */
const handoffCalls: Record<string, unknown>[] = [];
/**
 * Bitácora del orden real de los tres pasos del escenario. El requisito no es
 * solo que las tres cosas pasen: es que la etiqueta esté puesta ANTES de que
 * el asesor reciba el caso.
 */
const pasos: string[] = [];

function createFakeSupabase() {
  return {
    rpc(fn: string, params?: Record<string, unknown>) {
      // Igual que la función SQL: junta el interruptor global y el tope de gasto.
      if (fn === "agent_can_run") {
        return Promise.resolve({ data: state.aiGloballyEnabled && state.canRun, error: null });
      }
      // Lock por conversación (conversation-lock.ts): siempre libre, siempre
      // se puede renovar y soltar. Este archivo prueba UN solo turno a la
      // vez, así que el lock nunca es el protagonista acá.
      if (fn === "ai_turn_lock_acquire") return Promise.resolve({ data: true, error: null });
      if (fn === "ai_turn_lock_renew") {
        return state.turnLockRenewResult.error
          ? Promise.reject(new Error(state.turnLockRenewResult.error.message))
          : Promise.resolve({ data: state.turnLockRenewResult.data, error: null });
      }
      if (fn === "ai_turn_lock_release") return Promise.resolve({ data: true, error: null });
      // Bitácora de traspasos (handoffs.ts). La mayoría de las salidas de
      // este archivo solo necesitan que esto NO explote —qué fila escribe
      // cada salida silenciosa se prueba a fondo en handoffs.test.ts—, pero
      // T0.3 sí necesita mirar los parámetros acá: la salida
      // `rechazado_por_meta` (rechazo de Meta en el camino de escenario) es
      // más natural de cubrir en este archivo, que ya tiene el escenario
      // encendido con `matchPlaybookMock`. Si este caso faltara, el fake
      // lanza por la línea de abajo, `recordHandoff` se traga la excepción
      // —es su contrato— y deja un `traspaso_no_registrado` en el registro.
      if (fn === "record_handoff") {
        handoffCalls.push(params ?? {});
        return Promise.resolve({ data: "handoff-1", error: null });
      }
      throw new Error(`Fake Supabase: rpc no soportada: ${fn}`);
    },
    from(table: string) {
      if (table === "agent_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: state.agentSettingsError
                  ? null
                  : { ai_globally_enabled: state.aiGloballyEnabled, business_hours: state.agentSettingsBusinessHours },
                error: state.agentSettingsError,
              }),
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
              conversationUpdates.push(values);
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }

      if (table === "messages") {
        return {
          // Anexo B2 (5/9/2026): el UPDATE que marca `is_auto_reply` en la
          // despedida de un escenario que escaló sin asesores. La cadena real
          // termina en `.gt("created_at", ...)`, así que ahí se registra el
          // update completo (valores + filtros acumulados) y se devuelve lo
          // único que hace falta que sea `await`-able.
          update: (values: Record<string, unknown>) => {
            const filters: [string, unknown][] = [];
            const builder = {
              eq: (col: string, val: unknown) => {
                filters.push([col, val]);
                return builder;
              },
              gt: (col: string, val: unknown) => {
                filters.push([col, val]);
                messageUpdates.push({ values, filters: [...filters] });
                return Promise.resolve({ data: null, error: state.messageUpdateError });
              },
            };
            return builder;
          },
          select: (columns: string) => ({
            eq: () => ({
              // Se guarda cómo se pidió el orden: la IA tiene que leer los
              // mensajes MÁS RECIENTES, no los más antiguos.
              order: (_col: string, opts: { ascending: boolean }) => {
                state.historyOrderAscending = opts.ascending;
                return { limit: async () => ({ data: state.history }) };
              },
              // Segundo .eq(): dos consumidores distintos comparten esta forma
              // (conversation_id + un segundo filtro) y se distinguen por las
              // columnas que pidieron en select() — humanHasWritten (T7,
              // 8/9/2026) pide "created_at" y encadena `.order().limit()`
              // (antes pedía "id" y terminaba en `.limit()` sin `order()`, sin
              // ventana de tiempo que comparar); `lastInboundWamid` (T3.1,
              // 4/9/2026) pide "whatsapp_message_id" y sigue con
              // `.order().limit().maybeSingle()`. Se lee `state` en el momento
              // de la llamada, no al construir el fake: es lo que deja que un
              // asesor "entre" a mitad de turno.
              eq: () => {
                if (columns === "created_at") {
                  return {
                    order: () => ({
                      limit: async () => ({
                        data: state.humanMessagesError ? null : state.humanMessages,
                        error: state.humanMessagesError,
                      }),
                    }),
                  };
                }
                return {
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({
                        data: state.lastInboundWamid ? { whatsapp_message_id: state.lastInboundWamid } : null,
                        error: null,
                      }),
                    }),
                  }),
                };
              },
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
/**
 * `ZERO_USAGE` (8/9/2026, T2): agent.ts la usa como el "sin escenario, sin
 * costo" cuando salta `matchPlaybook` porque la última línea del cliente es
 * un marcador de media — el mock necesita exportar el mismo nombre, aunque
 * el valor exacto no importa para estos tests (nunca se suma a un total que
 * el test verifique).
 */
vi.mock("@/lib/ai/playbooks", () => ({
  matchPlaybook: (...args: unknown[]) => matchPlaybookMock(...args),
  fetchActivePlaybooks: () => fetchActivePlaybooksMock(),
  playbookSentRecently: (...args: unknown[]) => playbookSentRecentlyMock(...args),
  ZERO_USAGE: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
}));

type AnyMock = (...args: unknown[]) => Promise<unknown>;

/**
 * T0.3: `sendAgentText`/`sendPlaybookReply` dejaron de ser `Promise<void>` —
 * devuelven el `DeliveryOutcome` que agent.ts mira para saber si Meta
 * rechazó el envío. Un mock que resolviera `undefined` haría que `deliver()`
 * tratara CUALQUIER envío como bloqueado por una guarda (`if (!salida)
 * return`), así que el valor por defecto tiene que ser un outcome de verdad
 * — el mismo que produce un canal simulado (`whatsapp_status: null`, ni
 * enviado ni rechazado).
 */
const OUTCOME_NO_ENVIADO = {
  whatsapp_message_id: null,
  whatsapp_status: null as "sent" | "failed" | null,
  whatsapp_error_code: null,
  whatsapp_error_detail: null,
  origenDelFallo: null as "meta" | "red" | null,
};
const sendPlaybookReplyMock = vi.fn<AnyMock>(async () => OUTCOME_NO_ENVIADO);
const sendAgentTextMock = vi.fn<AnyMock>(async () => OUTCOME_NO_ENVIADO);
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

/**
 * Forwarding de argumentos (8/9/2026, T2): antes el wrapper de `vi.mock`
 * llamaba a `classifyIntentMock()` sin pasarle nada, así que ningún test
 * podía mirar QUÉ historial le llegó al clasificador — hacía falta para
 * probar que un audio sin texto SÍ le llega como línea `user` con el
 * marcador exacto (ver "solo un audio ya no deja el historial vacío" en el
 * describe de historial).
 */
const classifyIntentMock = vi.fn<(...args: unknown[]) => Promise<{ intent: Intent; usage: FakeUsage }>>(async () => ({
  intent: "consulta_disponibilidad",
  usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
}));
vi.mock("@/lib/ai/classify", () => ({ classifyIntent: (...args: unknown[]) => classifyIntentMock(...args) }));

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
/**
 * Guarda de identidad (6/9/2026): la ÚNICA reescritura que hace
 * `applyIdentityGuard` usa `generateText` (no `ToolLoopAgent` — las
 * herramientas ya corrieron). Default: un texto limpio que no vuelve a
 * calzar ningún patrón de `identity-guard.ts`, para que los tests que NO
 * disparan la guarda no tengan que preocuparse por este mock.
 */
const generateTextMock = vi.fn<
  (args: Record<string, unknown>) => Promise<{ text: string; usage: FakeUsage }>
>(async () => ({
  text: "texto reescrito limpio",
  usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  ToolLoopAgent: class {
    constructor(options: { instructions: string; tools: Record<string, unknown> }) {
      agentOptions.push(options);
    }
    generate = generateMock;
  },
  generateText: (...args: unknown[]) => generateTextMock(args[0] as Record<string, unknown>),
}));

/** Con qué `effort` se llamó `getAgentModel` en cada turno: lo usa el describe de la guarda de identidad para afirmar que la reescritura pide "low". */
const getAgentModelCalls: unknown[] = [];
vi.mock("@/lib/ai/model", () => ({
  getAgentModel: (effort?: unknown) => {
    getAgentModelCalls.push(effort);
    return { model: "modelo-falso" };
  },
  currentAgentModelLabel: () => "fake/modelo",
}));

/**
 * Anexo B2 (5/9/2026), test (e): `runPlaybook` acepta `lastCustomerMessageAt:
 * string | null` porque el TIPO lo permite, pero en un turno real nunca llega
 * nulo — `withinFreeformWindow(convo.last_customer_message_at)` ya lo exige
 * ANTES de que `runAgentTurn` llegue a abrir el lock. Para probar la rama
 * defensiva de todos modos, este mock deja pasar el `import` real de
 * `@/lib/dashboard` sin tocar nada salvo que un test puntual instale un
 * override — así se fuerza la ventana abierta con `last_customer_message_at:
 * null` sin mentirle a ningún otro test de este archivo (el describe de
 * "ventana de 24 h" sigue usando el comportamiento real).
 */
const withinFreeformWindowOverride: {
  fn: ((lastCustomerMessageAt: string | null, now?: number) => boolean) | null;
} = { fn: null };
vi.mock("@/lib/dashboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dashboard")>();
  return {
    ...actual,
    withinFreeformWindow: (lastCustomerMessageAt: string | null, now?: number) =>
      withinFreeformWindowOverride.fn
        ? withinFreeformWindowOverride.fn(lastCustomerMessageAt, now)
        : actual.withinFreeformWindow(lastCustomerMessageAt, now),
  };
});

/**
 * `buildEscalateTool` real (`tools.ts`) es lo que copia `result.unassigned`
 * al `outcome` cuando el MODELO invoca la herramienta durante el tool loop.
 * Acá el tool loop entero está fingido (`generateMock` no ejecuta ninguna
 * herramienta de verdad), así que para simular "el modelo llamó a
 * `escalarAAsesor`" un test puntual sobrescribe este mock para que mute el
 * `outcome` que le llega — el mismo objeto que `runTurnPhases` construye
 * ANTES de invocar `agent.generate()`, así que mutarlo acá tiene el mismo
 * efecto observable que si la herramienta hubiera corrido de verdad
 * (anexo A1, 5/9/2026).
 */
const buildEscalateToolMock = vi.fn<(deps: unknown, outcome: Record<string, unknown>) => Record<string, never>>(
  () => ({})
);
vi.mock("@/lib/ai/tools", () => ({
  buildCatalogTool: () => ({}),
  buildEscalateTool: (deps: unknown, outcome: Record<string, unknown>) => buildEscalateToolMock(deps, outcome),
  buildOrderHistoryTool: () => ({}),
}));

vi.mock("@/lib/ai/knowledge", () => ({
  buildKnowledgeTool: () => ({}),
}));

/** "Escribiendo…" hacia Meta (T3.1, 4/9/2026): nunca lanza, así que el mock tampoco. */
const sendTypingIndicatorMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/whatsapp/meta-client", () => ({
  sendTypingIndicator: (...args: unknown[]) => sendTypingIndicatorMock(...args),
}));

import { DESPEDIDA_CON_ASESOR, DESPEDIDA_SIN_ASESOR, runAgentTurn } from "@/lib/ai/agent";
import { OFF_TOPIC_REPLY, SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { revealsIdentity } from "@/lib/ai/identity-guard";
import { playbookMessageText } from "@/lib/ai/send";
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
  state.turnLockRenewResult = { data: true, error: null };
  state.lastInboundWamid = "wamid.ULTIMO_ENTRANTE";
  state.messageUpdateError = null;
  state.agentSettingsBusinessHours = undefined;
  state.agentSettingsError = null;
  withinFreeformWindowOverride.fn = null;
  sendTypingIndicatorMock.mockClear();
  conversationUpdates.length = 0;
  agentTurnInserts.length = 0;
  contactTagUpserts.length = 0;
  messageUpdates.length = 0;
  pasos.length = 0;
  handoffCalls.length = 0;
  agentOptions.length = 0;
  getAgentModelCalls.length = 0;
  vi.clearAllMocks();
  fetchActivePlaybooksMock.mockResolvedValue([]);
  generateTextMock.mockResolvedValue({
    text: "texto reescrito limpio",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  });
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
    return OUTCOME_NO_ENVIADO;
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

  /**
   * T3.2 (5/9/2026): 'unsupported' es Meta avisando que hay algo que el CRM
   * no sabe representar (content ya queda null en la base para ese tipo,
   * pero el filtro es explícito por `message_type`, no por esa nulidad) — no
   * es contenido del cliente ni una respuesta nuestra, así que no debe
   * meterse en el contexto que lee el modelo.
   */
  it("salta los mensajes 'unsupported' del historial", async () => {
    // El fake simula la consulta DESCENDENTE (más nuevo primero), igual que
    // Postgres: loadHistory la invierte para pasarle al modelo el orden
    // cronológico. Se escribe acá en el mismo orden que devuelve la base.
    state.history = [
      { sender_type: "customer", content: "¿tienen aceite 20w50?", is_internal_note: false, message_type: "text" },
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "unsupported" },
      { sender_type: "customer", content: "hola", is_internal_note: false, message_type: "text" },
    ];

    await runAgentTurn("conv-1");

    const enviados = matchPlaybookMock.mock.calls[0][0] as { content: string }[];
    expect(enviados.map((m) => m.content)).toEqual(["hola", "¿tienen aceite 20w50?"]);
  });

  /**
   * Un pedido del catálogo (T3.2, 5/9/2026) entra al historial con el mismo
   * resumen en español que el webhook ya dejó en `content` — no hace falta
   * releer `payload` acá, el resumen ya es el texto que el modelo necesita.
   */
  it("usa el resumen en español de un pedido del catálogo", async () => {
    state.history = [
      {
        sender_type: "customer",
        content: "🛒 El cliente envió un pedido del catálogo (1 producto):\n- 2x SKU-1 (USD 10.00 c/u)\nTotal: USD 20.00",
        is_internal_note: false,
        message_type: "order",
      },
    ];

    await runAgentTurn("conv-1");

    const enviados = matchPlaybookMock.mock.calls[0][0] as { content: string }[];
    expect(enviados[0].content).toContain("Total: USD 20.00");
  });

  /**
   * T2 (8/9/2026, "La IA ve lo que llega", Bug 1 medido en producción el
   * 7/9/2026): antes `loadHistory` descartaba TODA fila sin `content`, y el
   * webhook guarda audio con `content = caption ?? null` — sin pie (el caso
   * normal: WhatsApp no deja ponerle pie a una nota de voz), el historial
   * quedaba vacío y el turno salía sin rastro (caso `cea69118…`, 30
   * reencolados). Este es el test de la prueba de mutación: si `historyLine`
   * volviera a devolver `null` para `audio`, este test se pone rojo.
   */
  it("solo un audio ya no deja el historial vacío: se clasifica y se redacta", async () => {
    state.history = [{ sender_type: "customer", content: null, is_internal_note: false, message_type: "audio" }];

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    const historialRecibido = classifyIntentMock.mock.calls[0][0] as { role: string; content: string }[];
    expect(historialRecibido).toEqual([
      { role: "user", content: "[El cliente envió una nota de voz; no puedes escucharla]" },
    ]);
    // El turno no se queda callado: sin escenario que calce, cae al flujo
    // genérico y redacta.
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Caso `7631718e-52bc-4448-99f2-586789c073ff` (7/9/2026): una foto con pie
   * entra al contexto del modelo con su pie, no solo como "llegó una foto".
   */
  it("una foto con pie entra con su pie", async () => {
    state.history = [
      {
        sender_type: "customer",
        content: "Cualquiera de estos en talla L",
        is_internal_note: false,
        message_type: "image",
      },
    ];

    await runAgentTurn("conv-1");

    const historialRecibido = classifyIntentMock.mock.calls[0][0] as { role: string; content: string }[];
    expect(historialRecibido).toEqual([
      { role: "user", content: "[El cliente envió una foto. Pie: Cualquiera de estos en talla L]" },
    ]);
  });
});

/**
 * S3 del plan (8/9/2026): si la última línea del CLIENTE en el historial es
 * un marcador de media, fase 0 (`matchPlaybook`) no corre — ningún
 * disparador de escenario calza contra "[El cliente envió una foto…]", así
 * que preguntarlo igual sería gastar una llamada de balde. La clasificación
 * de intención SÍ corre igual: define qué herramientas recibe el modelo, y
 * eso no depende de que el último mensaje traiga texto. El caso normal —un
 * texto DESPUÉS de una foto, caso `7631718e…`— sigue corriendo fase 0 con la
 * foto en contexto: ahí la última línea de cliente es texto, no marcador.
 */
describe("runAgentTurn — lo que llega sin texto", () => {
  it("un marcador como último mensaje no llama a matchPlaybook", async () => {
    const info = vi.spyOn(log, "info");
    // Descendente, como los devuelve la consulta: lo más reciente primero.
    state.history = [
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "image" },
      { sender_type: "customer", content: "hola, busco un repuesto", is_internal_note: false, message_type: "text" },
    ];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("turno_ultimo_mensaje_sin_texto", { conversationId: "conv-1" });
    // Nada con qué crear el escenario que faltó: la bitácora queda sin texto
    // de cliente, no con el marcador.
    expect(agentTurnInserts[0]).toMatchObject({ customer_message: null });
  });

  it("una foto seguida de texto sí corre fase 0 con la foto en contexto", async () => {
    // Descendente: lo más reciente (el texto) primero.
    state.history = [
      { sender_type: "customer", content: "Cualquiera de estos en talla L", is_internal_note: false, message_type: "text" },
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "image" },
    ];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).toHaveBeenCalledTimes(1);
    const enviados = matchPlaybookMock.mock.calls[0][0] as { role: string; content: string }[];
    expect(enviados.map((m) => m.content)).toEqual([
      "[El cliente envió una foto sin texto; no puedes verla]",
      "Cualquiera de estos en talla L",
    ]);
    expect(agentTurnInserts[0]).toMatchObject({ customer_message: "Cualquiera de estos en talla L" });
  });

  /**
   * Hallazgo 6 del plan (8/9/2026): `alreadySentPlaybook` salta los
   * marcadores salientes al buscar "nuestra última respuesta" — si el
   * asesor mandó una foto DESPUÉS del escenario, la red que evita repetirlo
   * seguía teniendo que reconocerlo.
   */
  it("la última respuesta nuestra para alreadySentPlaybook salta un marcador de foto del asesor", async () => {
    const info = vi.spyOn(log, "info");
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    // Descendente: lo más reciente primero. La foto del asesor es la última
    // respuesta "cronológica", pero la última respuesta con TEXTO sigue
    // siendo el escenario.
    state.history = [
      { sender_type: "ai", content: null, is_internal_note: false, message_type: "image" },
      { sender_type: "ai", content: playbookMessageText(pb), is_internal_note: false, message_type: "text" },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false, message_type: "text" },
    ];

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("escenario_no_se_repite", {
      conversationId: "conv-1",
      escenario: pb.name,
      motivo: "fue_la_ultima_respuesta",
    });
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

  /**
   * Sin esto en el registro, un chat que se quedó fuera de ventana es
   * indistinguible de uno que la IA nunca intentó atender: el mismo silencio.
   */
  it("deja en el registro el evento turno_fuera_de_ventana", async () => {
    const warn = vi.spyOn(log, "warn");
    state.conversation = { ...state.conversation, last_customer_message_at: HACE_25_HORAS() };

    await runAgentTurn("conv-1");

    expect(warn).toHaveBeenCalledWith("turno_fuera_de_ventana", { conversationId: "conv-1" });
  });
});

/**
 * Salidas de apertura de `runAgentTurn`, previas a cualquier intento de
 * hablar con el cliente. Antes de la tarea "Ningún lead invisible" estas
 * corrían sin resguardo: nada impedía que otra tarea les cambiara el
 * comportamiento —loguear de más, loguear de menos, dejar de frenar— sin que
 * ninguna prueba se enterara. Cada caso deja constancia además del hecho que
 * más importa: que no se le mandó nada al cliente.
 */
describe("runAgentTurn — salidas silenciosas de apertura", () => {
  /**
   * La fila puede desaparecer entre que la cola encoló el id y que le tocó el
   * turno: un chat borrado, una migración de datos. Sin la fila no hay nada
   * que atender, y el turno no deja rastro porque no llegó a abrir nada.
   */
  it("si la conversación no existe, no hace nada y no lanza", async () => {
    state.conversation = null;

    await expect(runAgentTurn("conv-1")).resolves.toBeUndefined();

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * Antes era un `return` mudo: con la cola llena y la IA apagada, los turnos
   * se reclamaban y desaparecían sin dejar rastro de por qué (ver el
   * comentario de `runAgentTurn` en agent.ts). El evento es lo que distingue
   * "no había nada que responder" de "algo impidió responder".
   */
  it("con el interruptor global apagado, deja turno_saltado_ia_apagada en el registro", async () => {
    const info = vi.spyOn(log, "info");
    state.canRun = false;

    await runAgentTurn("conv-1");

    expect(info).toHaveBeenCalledWith("turno_saltado_ia_apagada", { conversationId: "conv-1" });
    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * `ai_enabled` (apagado en ESTE chat) y `assigned_agent_id` (chat ya de un
   * asesor) son dos guardas separadas que registran su propio traspaso
   * (`pausada`/`asignada` — ver `handoffs.test.ts`), pero ninguna de las dos
   * deja nada en `log`: la bitácora vive en `conversation_handoffs`, no en
   * los logs. Anexo A2 (5/9/2026): el orden entre ellas se invirtió
   * (`assigned_agent_id` se mira primero), pero este caso no tiene asesor
   * asignado, así que sigue cayendo en la misma rama de siempre —
   * `pausada`/`unassigned`— y esta prueba no necesita tocarse.
   */
  it("con ai_enabled=false en el chat, no corre nada y no deja ningún evento en el registro", async () => {
    const info = vi.spyOn(log, "info");
    const warn = vi.spyOn(log, "warn");
    const error = vi.spyOn(log, "error");
    state.conversation = { ...state.conversation, ai_enabled: false };

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  /**
   * Un contacto sin teléfono utilizable —borrado entre la consulta y la
   * respuesta, o con un dato corrupto— es la identidad rota que buildTurnTarget
   * corta antes de que el turno corra entero para terminar en una llamada a
   * Meta con destinatario vacío. No se reintenta: una identidad rota no se
   * arregla sola, así que sale como NonRetryableTurnError.
   */
  it("si la identidad del turno no se puede verificar, no envía nada y sale como NonRetryableTurnError", async () => {
    const error = vi.spyOn(log, "error");
    state.conversation = { ...state.conversation, contact: { phone_number: "" } };

    await expect(runAgentTurn("conv-1")).rejects.toMatchObject({
      name: "NonRetryableTurnError",
      conversationId: "conv-1",
    });

    expect(error).toHaveBeenCalledWith(
      "turno_identidad_no_verificable",
      expect.objectContaining({ conversationId: "conv-1" })
    );
    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
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
      // Frente B4 (5/9/2026): el camino de escenario también enhebra el
      // horario hasta escalateConversation, no solo el tool loop genérico —
      // sin esto la despedida de un escenario sin asesores no podría decir
      // cuándo abre la tienda.
      businessHours: DEFAULT_BUSINESS_HOURS,
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

  /**
   * T0.3: hasta ahora un rechazo de Meta en el camino de escenario no frenaba
   * nada — el turno etiquetaba, escalaba (si tocaba) y escribía `agent_turns`
   * como si el cliente hubiera recibido el catálogo, aunque `messages` ya
   * dijera `whatsapp_status: 'failed'`. Con la respuesta del tool loop se
   * cubre en `handoffs.test.ts`; esto cierra el otro consumidor nombrado en
   * el plan.
   *
   * A3 (5/9/2026): además, `rejectedByMeta` ahora limpia `journey_stage`/
   * `active_tool` — sin eso, esta conversación se quedaba pintada
   * "Clasificando" en el tablero de Atascados para siempre, porque el
   * `return` salía antes de que el escenario llegara a resetear su propia
   * etapa.
   */
  it("rechazado_por_meta: el escenario sale rechazado por Meta, no se etiqueta ni se escala", async () => {
    const warn = vi.spyOn(log, "warn");
    const pb = playbook({
      afterSend: "escalate",
      tags: [{ id: "tag-envio", label: "Envio", color: "accent" as const }],
    });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    sendPlaybookReplyMock.mockImplementation(async () => ({
      whatsapp_message_id: null,
      whatsapp_status: "failed" as const,
      whatsapp_error_code: 131047,
      whatsapp_error_detail: "Meta rechazó el envío",
      origenDelFallo: "meta" as const,
    }));

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    // Ni la etiqueta ni el escalamiento acompañan a un mensaje que no salió.
    expect(contactTagUpserts).toHaveLength(0);
    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(agentTurnInserts).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("turno_rechazado_por_meta", {
      conversationId: "conv-1",
      codigo: 131047,
    });
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "rechazado_por_meta",
    });
    // La etapa no se queda congelada en "classifying": el rechazo la libera
    // igual que lo haría una respuesta que sí hubiera salido.
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
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

  /**
   * Anexo B2 (5/9/2026): un escenario con `afterSend: "escalate"` manda su
   * texto ANTES de escalar (T0.3 exige ese orden: nada acompaña a un mensaje
   * que Meta ya rechazó), así que sale con `is_auto_reply = false` sin saber
   * todavía si iba a hacer falta un asesor. Si `escalateConversation`
   * descubre que no hay NADIE, el turno marca ese mensaje con un UPDATE
   * después — el trigger que sumó B1 (migración 20260905070000) es quien
   * recalcula `last_reply_at`/`awaiting_reply` en la base; estos tests solo
   * miran que el UPDATE salga (o no) y con qué filtros.
   */
  describe("anexo B2: marca is_auto_reply cuando el escenario escaló sin asesores", () => {
    it("(a) escalate sin asesores: un UPDATE con is_auto_reply true, filtrado por la conversación y por created_at > el último mensaje del cliente", async () => {
      const pb = playbook({ afterSend: "escalate", name: "Guía de envío · Cashea" });
      fetchActivePlaybooksMock.mockResolvedValue([pb]);
      matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
      escalateConversationMock.mockImplementation(async () => {
        pasos.push("escalar");
        return { escalated: true, assignedAgentName: null, unassigned: true };
      });

      await runAgentTurn("conv-1");

      expect(messageUpdates).toHaveLength(1);
      expect(messageUpdates[0].values).toEqual({ is_auto_reply: true });
      expect(messageUpdates[0].filters).toEqual([
        ["conversation_id", "conv-1"],
        ["direction", "outbound"],
        ["sender_type", "ai"],
        ["is_internal_note", false],
        ["created_at", (state.conversation as { last_customer_message_at: string }).last_customer_message_at],
      ]);
    });

    /** Refuerza el test ya existente "un escenario con after_send 'escalate' pasa la conversación a un asesor": con asesor, ningún UPDATE. */
    it("(b) escalate CON asesor asignado: ningún UPDATE", async () => {
      const pb = playbook({ afterSend: "escalate", name: "Guía de envío · Cashea" });
      fetchActivePlaybooksMock.mockResolvedValue([pb]);
      matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
      // El beforeEach ya deja escalateConversationMock devolviendo un asesor
      // (María), sin `unassigned`.

      await runAgentTurn("conv-1");

      expect(escalateConversationMock).toHaveBeenCalledTimes(1);
      expect(messageUpdates).toHaveLength(0);
    });

    it("(c) escenario 'wait' (no escala): ningún UPDATE", async () => {
      const pb = playbook({ afterSend: "wait" });
      fetchActivePlaybooksMock.mockResolvedValue([pb]);
      matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

      await runAgentTurn("conv-1");

      expect(escalateConversationMock).not.toHaveBeenCalled();
      expect(messageUpdates).toHaveLength(0);
    });

    it("(d) el UPDATE falla: log.error con el evento y el turno termina igual (agent_turns con action escalated)", async () => {
      const error = vi.spyOn(log, "error");
      const pb = playbook({ afterSend: "escalate", name: "Guía de envío · Cashea" });
      fetchActivePlaybooksMock.mockResolvedValue([pb]);
      matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
      escalateConversationMock.mockImplementation(async () => {
        pasos.push("escalar");
        return { escalated: true, assignedAgentName: null, unassigned: true };
      });
      state.messageUpdateError = { message: "permiso denegado" };

      await runAgentTurn("conv-1");

      expect(error).toHaveBeenCalledWith("turno_escenario_despedida_no_marcada", {
        conversationId: "conv-1",
        detail: "permiso denegado",
      });
      expect(agentTurnInserts[0]).toMatchObject({ action: "escalated" });
    });

    /**
     * Rama defensiva: en un turno real esto no ocurre —
     * `withinFreeformWindow(convo.last_customer_message_at)` ya exige la
     * fecha para que el turno llegue hasta acá—, pero el tipo de
     * `runPlaybook` la admite. Se fuerza la ventana abierta con
     * `withinFreeformWindowOverride` para poder ejercer la rama sin mentirle
     * a ningún otro test del archivo.
     */
    it("(e) sin last_customer_message_at (forzado): log.warn y no marca nada", async () => {
      const warn = vi.spyOn(log, "warn");
      withinFreeformWindowOverride.fn = () => true;
      const pb = playbook({ afterSend: "escalate", name: "Guía de envío · Cashea" });
      fetchActivePlaybooksMock.mockResolvedValue([pb]);
      matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
      escalateConversationMock.mockImplementation(async () => {
        pasos.push("escalar");
        return { escalated: true, assignedAgentName: null, unassigned: true };
      });
      state.conversation = { ...state.conversation, last_customer_message_at: null };

      await runAgentTurn("conv-1");

      expect(messageUpdates).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith("turno_escenario_sin_fecha_cliente", { conversationId: "conv-1" });
    });
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
      // Conversando en el momento (caso 3 de human-handled.test.ts): el
      // `created_at` es el instante real en que el asesor escribió, muy
      // reciente frente al `now` que verá `deliver()` — lo bloquea la
      // cláusula de gracia, no la de `last_customer_message_at`.
      state.humanMessages = [{ created_at: new Date(reloj).toISOString() }];
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
      // Conversando en el momento (caso 3 de human-handled.test.ts): el
      // `created_at` es el instante real en que el asesor escribió, muy
      // reciente frente al `now` que verá `deliver()` — lo bloquea la
      // cláusula de gracia, no la de `last_customer_message_at`.
      state.humanMessages = [{ created_at: new Date(reloj).toISOString() }];
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
      // Conversando en el momento (caso 3 de human-handled.test.ts): el
      // `created_at` es el instante real en que el asesor escribió, muy
      // reciente frente al `now` que verá `deliver()` — lo bloquea la
      // cláusula de gracia, no la de `last_customer_message_at`.
      state.humanMessages = [{ created_at: new Date(reloj).toISOString() }];
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

/**
 * T7 (8/9/2026): hasta esta corrida, "escribió un humano" preguntaba "¿ALGUNA
 * VEZ?" y no "¿AHORA?" — caso real `3b654d2c-3cf8-4eef-8638-bc75e45cb10a`, un
 * "a" de un supervisor el 28/8/2026 dejaba muda a la IA para un cliente que
 * escribió el 7/9. Estas pruebas cubren el efecto en `runAgentTurn`: un
 * mensaje de asesor viejo, anterior al último mensaje del cliente y fuera de
 * la gracia, ya no frena el turno; y "Reactivar IA"/"Desasignar" —que solo
 * tocan `ai_enabled`/`assigned_agent_id`, nunca `messages`— vuelven a dejar
 * pasar el turno una vez que el cliente escribió después de esa gracia.
 */
describe("runAgentTurn — la guarda de humanos ya no es vitalicia (T7, 8/9/2026)", () => {
  it("un humano que escribió antes del último mensaje del cliente y hace más de G no frena el turno", async () => {
    const warn = vi.spyOn(log, "warn");
    // El "a" del 28/8: mucho antes del último mensaje del cliente (el
    // `last_customer_message_at` por defecto del beforeEach) y a años luz de
    // los 30 minutos de gracia por default.
    state.humanMessages = [{ created_at: "2026-08-28T00:00:00.000Z" }];

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith("turno_chat_de_una_persona", expect.anything());
    expect(handoffCalls.some((call) => call.p_reason === "humano_intervino")).toBe(false);
  });

  /**
   * `setAiEnabled(true)` y `unassign` (mutations.ts) escriben exactamente
   * `{ ai_enabled: true }` y `{ assigned_agent_id: null }` — nunca tocan
   * `messages`. Antes de T7 eso no alcanzaba para que la IA volviera a
   * hablar si alguna vez había escrito un asesor; ahora sí, en cuanto el
   * cliente escribió algo nuevo después de la gracia.
   */
  it("reactivar la IA y desasignar devuelven el chat", async () => {
    state.conversation = { ...state.conversation, ai_enabled: true, assigned_agent_id: null };
    // Humano viejo, muy anterior al último mensaje del cliente y a la gracia.
    state.humanMessages = [{ created_at: "2026-08-28T00:00:00.000Z" }];

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalled();
  });
});

/**
 * `lease.confirmar()` es la guarda más nueva de `deliver()`, y va PRIMERO:
 * si el lock ya no es nuestro, la conversación puede ser de otro turno (o de
 * uno resucitado tras un TTL vencido) y ni siquiera tiene sentido preguntar
 * el interruptor o si un asesor se metió.
 */
describe("runAgentTurn — el turno confirma que el lock sigue siendo suyo antes de hablar", () => {
  it("no envía nada si el lock ya no es suyo", async () => {
    state.turnLockRenewResult = { data: false, error: null };

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(agentTurnInserts.some((row) => row.action === "answered")).toBe(false);
  });

  /**
   * Falla cerrado, igual que el resto de las guardas del envío: ante la duda
   * de si el lock sigue siendo nuestro, no se sigue hablando. El error se
   * deja pasar (con `.catch`) porque, a diferencia del `data: false` de
   * arriba, acá el RPC mismo revienta: `confirmar()` no lo atrapa, así que
   * el turno vuelve a la cola como reintentable — lo que sí importa acá es
   * que no llegó a enviar nada.
   */
  it("un fallo al confirmar el lock tampoco envía", async () => {
    state.turnLockRenewResult = { data: null, error: { message: "conexión perdida" } };

    await runAgentTurn("conv-1").catch(() => undefined);

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * El evento es lo que permite distinguir, leyendo el registro, "el lock ya
   * no era nuestro" de cualquier otra guarda de `deliver()` que también
   * termina en un envío que no salió. `fase` dice en qué tramo del turno
   * pasó — acá "redaccion", porque el flujo por defecto de las pruebas de
   * este archivo no calza ningún escenario.
   */
  it("deja en el registro el evento turno_lock_perdido_sin_enviar con la fase donde se perdió", async () => {
    const warn = vi.spyOn(log, "warn");
    state.turnLockRenewResult = { data: false, error: null };

    await runAgentTurn("conv-1");

    expect(warn).toHaveBeenCalledWith("turno_lock_perdido_sin_enviar", {
      conversationId: "conv-1",
      fase: "redaccion",
    });
  });
});

/**
 * Guarda (b) de `deliver()`: la misma pregunta del interruptor que se hizo al
 * abrir el turno (`agent_can_run`), repetida justo antes de hablar. Entre
 * abrir el turno y llegar acá pasan de tres a diez segundos —clasificar,
 * redactar—, y apagar el interruptor en ese hueco tiene que frenar el envío
 * igual que lo frena si se apaga antes de empezar.
 */
describe("runAgentTurn — el interruptor se vuelve a revisar justo antes de enviar", () => {
  it("si se apaga mientras el turno redacta, no envía nada", async () => {
    const warn = vi.spyOn(log, "warn");
    generateMock.mockImplementation(async () => {
      // Igual que la carrera del asesor: el interruptor cambia DESPUÉS de
      // abrir el turno, mientras el modelo todavía está redactando.
      state.canRun = false;
      return {
        text: "respuesta redactada por el modelo",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await runAgentTurn("conv-1");

    // El modelo sí redactó: el turno llegó hasta el envío y se frenó ahí,
    // no antes por la guarda de apertura que ya existía.
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("turno_abortado_por_interruptor", { conversationId: "conv-1" });
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

  /**
   * Corrección 5/9/2026: T0.3 conectó `rejectedByMeta()` en el escenario de
   * fase 0 y en la respuesta final del tool loop, pero se le olvidó el
   * tercer consumidor de `sendAgentText` — esta redirección. Era un `return`
   * que abandonaba la conversación sin traspaso: exactamente el bug que la
   * invariante de CLAUDE.md prohíbe.
   */
  it("rechazado_por_meta: la redirección de fuera de tema sale rechazada por Meta, sin segundo envío", async () => {
    const warn = vi.spyOn(log, "warn");
    classifyIntentMock.mockResolvedValue({
      intent: "fuera_de_tema",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    sendAgentTextMock.mockResolvedValueOnce({
      whatsapp_message_id: null,
      whatsapp_status: "failed" as const,
      whatsapp_error_code: 131047,
      whatsapp_error_detail: "Meta rechazó el envío",
      origenDelFallo: "meta" as const,
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    // El turno termina en el rechazo: no llega a escribir agent_turns.
    expect(agentTurnInserts).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("turno_rechazado_por_meta", {
      conversationId: "conv-1",
      codigo: 131047,
    });
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "rechazado_por_meta",
    });
    // A3 (5/9/2026): mismo reseteo que en el camino de escenario — sin él, el
    // tablero de Atascados veía esta conversación congelada en "Clasificando".
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
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

    expect(agentOptions[0].instructions.slice(SYSTEM_PROMPT.length)).toMatch(/es el primer mensaje que recibe de nosotros/i);
  });

  // Ojo: no se busca /saluda/i a secas — desde Frente B3 (5/9/2026) turnClockLine
  // SIEMPRE trae la palabra ("... saluda 'buenas tardes' ..."), salga o no la
  // instrucción de saludar. Lo que distingue el primer contacto es esta frase.
  it("no manda saludar si la bienvenida ya salió", async () => {
    await runAgentTurn("conv-1");

    expect(agentOptions[0].instructions.slice(SYSTEM_PROMPT.length)).not.toMatch(
      /es el primer mensaje que recibe de nosotros/i
    );
  });

  /**
   * Frente B3 (5/9/2026): el horario que lee `runAgentTurn` de
   * `agent_settings.business_hours` tiene que llegar hasta las instrucciones
   * del turno, no quedarse en la variable. Con la tienda cerrada los siete
   * días la aserción no depende de a qué hora corra la suite: sin ninguna
   * franja en toda la semana, `businessStatus` siempre da CERRADA sin
   * "abre tal día", así que la salida es la misma corra cuando corra.
   */
  it("lee el horario de agent_settings y lo pasa a las instrucciones del turno", async () => {
    state.agentSettingsBusinessHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

    await runAgentTurn("conv-1");

    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toContain("cerrado todos los días");
    expect(sufijo).toContain("Ahora mismo: CERRADA.");
  });

  /** El mismo horario le llega también a `matchPlaybook` (fase 0), no solo al flujo genérico. */
  it("le pasa el mismo horario a matchPlaybook", async () => {
    const horario = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    state.agentSettingsBusinessHours = horario;

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock.mock.calls[0][3]).toEqual(horario);
  });

  /** Una fila rota (forma inválida) no tumba el turno: cae al horario por defecto. */
  it("con agent_settings.business_hours roto, cae al horario por defecto sin romper el turno", async () => {
    state.agentSettingsBusinessHours = { esto: "no es un horario válido" };

    await runAgentTurn("conv-1");

    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toContain("lunes a viernes de 8:00 am a 6:00 pm");
  });

  /** Un fallo leyendo agent_settings tampoco tumba el turno: horario por defecto y log.warn. */
  it("si agent_settings no se puede leer, sigue con el horario por defecto y avisa por log", async () => {
    const warn = vi.spyOn(log, "warn");
    state.agentSettingsError = { message: "conexión perdida" };

    await runAgentTurn("conv-1");

    expect(agentOptions).toHaveLength(1);
    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toContain("lunes a viernes de 8:00 am a 6:00 pm");
    expect(warn).toHaveBeenCalledWith("turno_horario_no_legible", {
      conversationId: "conv-1",
      detail: "conexión perdida",
    });
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

/**
 * T4, corrida "La IA ve lo que llega" (8/9/2026, Bug 2 / S4). Hallazgo 2 del
 * plan: había TRES puertas en `runTurnPhases` que dejaban `journey_stage`
 * congelado en "classifying"/"tool_running" para siempre porque el turno
 * salía antes de llegar al reseteo normal. Este describe cubre las tres.
 */
describe("runAgentTurn — salidas que limpian su etapa", () => {
  /** La línea `turno_tiempos`, ya parseada, entre las llamadas de un spy. */
  function tiemposDe(info: ReturnType<typeof vi.spyOn>): Record<string, unknown> | undefined {
    const call = info.mock.calls.find((args: unknown[]) => args[0] === "turno_tiempos");
    return call?.[1] as Record<string, unknown> | undefined;
  }

  /**
   * Caso `cea69118…`: un historial que solo trae `unsupported` o notas —nada
   * legible para el modelo, tras describir la media con `historyLine`
   * (T2)— ya no sale mudo. Prueba de mutación del orquestador: si el
   * `return` por historial vacío volviera a ser mudo (`if (history.length
   * === 0) return;`), este test se pone rojo.
   */
  it("un historial sin nada legible deja traspaso sin_contenido_legible y limpia la etapa", async () => {
    const warn = vi.spyOn(log, "warn");
    const info = vi.spyOn(log, "info");
    state.history = [
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "unsupported" },
    ];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("turno_sin_contenido_legible", { conversationId: "conv-1" });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({
        p_conversation_id: "conv-1",
        p_to_kind: "unassigned",
        p_reason: "sin_contenido_legible",
      })
    );

    // journey_stage se puso en "classifying" al abrir el turno y se limpió
    // DESPUÉS, no antes: el orden importa, es la prueba de que no es un
    // reseteo que ya estaba ahí por otro motivo.
    const classificando = conversationUpdates.findIndex((u) => u.journey_stage === "classifying");
    const limpieza = conversationUpdates.findIndex(
      (u, i) => i > classificando && u.journey_stage === null && u.active_tool === null
    );
    expect(classificando).toBeGreaterThanOrEqual(0);
    expect(limpieza).toBeGreaterThan(classificando);

    expect(tiemposDe(info)).toMatchObject({ entregado: false });
  });

  /** Mismo resultado con una nota interna: tampoco es texto de cliente que leer. */
  it("un historial con solo una nota interna también deja traspaso sin_contenido_legible y limpia la etapa", async () => {
    const warn = vi.spyOn(log, "warn");
    const info = vi.spyOn(log, "info");
    state.history = [{ sender_type: "agent", content: "revisar con el proveedor", is_internal_note: true }];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("turno_sin_contenido_legible", { conversationId: "conv-1" });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({ p_to_kind: "unassigned", p_reason: "sin_contenido_legible" })
    );
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
    expect(tiemposDe(info)).toMatchObject({ entregado: false });
  });

  /**
   * El corte de red de OpenRouter del 7/9/2026 a las 11:57 UTC pasó
   * exactamente por esta puerta: el turno registraba el fallo en
   * `agent_turns` pero dejaba `journey_stage = "classifying"` sin limpiar.
   * Acá NO se escribe un traspaso nuevo — `agent_turns` con `action: "error"`
   * ya es suficiente para que el reconciliador la recoja.
   */
  it("si la clasificación falla, la etapa no se queda en classifying", async () => {
    classifyIntentMock.mockRejectedValue(new Error("rate limit"));

    await runAgentTurn("conv-1");

    expect(agentTurnInserts).toContainEqual(expect.objectContaining({ action: "error" }));
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
    expect(handoffCalls.some((call) => call.p_reason === "sin_contenido_legible")).toBe(false);
  });

  /**
   * Antes este `catch` solo apagaba `active_tool` y dejaba `journey_stage`
   * congelado en "classifying"/"tool_running". Tampoco escribe traspaso
   * nuevo, por el mismo motivo que la clasificación fallida.
   */
  it("si el tool loop lanza, la etapa no se queda en tool_running", async () => {
    generateMock.mockRejectedValue(new Error("fetch failed"));

    await runAgentTurn("conv-1");

    expect(agentTurnInserts).toContainEqual(expect.objectContaining({ action: "error" }));
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
    expect(handoffCalls.some((call) => call.p_reason === "sin_contenido_legible")).toBe(false);
  });
});

/**
 * S6, corrida "La IA ve lo que llega" (hallazgo 4, 8/9/2026). El corte de red
 * de OpenRouter del 7/9 a las 11:57 UTC dejó dos envíos `failed` con
 * `detalle: "fetch failed"` que el código de entonces trataba como rechazo
 * de Meta. `deliveryFailed` (antes `rejectedByMeta`) ahora bifurca por
 * `entrega.origenDelFallo`.
 */
describe("runAgentTurn — un corte de red no se confunde con un rechazo de Meta (S6)", () => {
  const FALLO_DE_RED = {
    whatsapp_message_id: null,
    whatsapp_status: "failed" as const,
    whatsapp_error_code: null,
    whatsapp_error_detail: "fetch failed",
    origenDelFallo: "red" as const,
  };

  it("la respuesta redactada del tool loop falla por red: entrega_fallida, no rechazado_por_meta, log de red, etapa reseteada", async () => {
    const error = vi.spyOn(log, "error");
    const warn = vi.spyOn(log, "warn");
    sendAgentTextMock.mockResolvedValueOnce(FALLO_DE_RED);

    await runAgentTurn("conv-1");

    expect(error).toHaveBeenCalledWith("turno_envio_fallo_de_red", {
      conversationId: "conv-1",
      detalle: "fetch failed",
    });
    expect(warn).not.toHaveBeenCalledWith("turno_rechazado_por_meta", expect.anything());
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({
        p_conversation_id: "conv-1",
        p_to_kind: "unassigned",
        p_reason: "entrega_fallida",
      })
    );
    expect(handoffCalls.some((call) => call.p_reason === "rechazado_por_meta")).toBe(false);
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
  });

  it("el escenario de fase 0 falla por red: también entrega_fallida, no se etiqueta ni se escala", async () => {
    const error = vi.spyOn(log, "error");
    const pb = playbook({
      afterSend: "escalate",
      tags: [{ id: "tag-envio", label: "Envio", color: "accent" as const }],
    });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    sendPlaybookReplyMock.mockImplementation(async () => FALLO_DE_RED);

    await runAgentTurn("conv-1");

    expect(contactTagUpserts).toHaveLength(0);
    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("turno_envio_fallo_de_red", {
      conversationId: "conv-1",
      detalle: "fetch failed",
    });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({ p_to_kind: "unassigned", p_reason: "entrega_fallida" })
    );
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
  });

  /**
   * Mismo criterio que un rechazo de Meta: si ya hay una escalación previa
   * (asesor asignado, traspaso `escalada` ya escrito), un fallo de red en el
   * envío final NO agrega un segundo traspaso `unassigned` que pisaría al
   * asesor ya asignado. Solo queda el log.
   */
  it("ya escalada + fallo de red: solo se registra el log, sin traspaso nuevo", async () => {
    const error = vi.spyOn(log, "error");
    classifyIntentMock.mockResolvedValue({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    escalateConversationMock.mockImplementation(async (...args: unknown[]) => {
      const [supabaseArg, params] = args as [
        { rpc: (fn: string, params: Record<string, unknown>) => Promise<unknown> },
        { conversationId: string },
      ];
      await supabaseArg.rpc("record_handoff", {
        p_conversation_id: params.conversationId,
        p_to_kind: "human",
        p_reason: "escalada",
        p_to_id: "asesor-42",
      });
      return { escalated: true, assignedAgentName: "María" };
    });
    sendAgentTextMock.mockResolvedValueOnce(FALLO_DE_RED);

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({ p_to_kind: "human", p_reason: "escalada", p_to_id: "asesor-42" });
    expect(error).toHaveBeenCalledWith("turno_envio_fallo_de_red", {
      conversationId: "conv-1",
      detalle: "fetch failed",
    });
    // journey_stage ya quedó "assigned" por la escalación: no se pisa con null.
    expect(conversationUpdates).not.toContainEqual({ journey_stage: null, active_tool: null });
  });
});

/**
 * Corrección 5/9/2026 (HUECO 2). En devolución/queja, la escalación forzada
 * (`escalateConversation`) corre ANTES del envío final y ya deja su propio
 * traspaso —`escalada` con asesor, `escalada_sin_asesor` sin uno—. Si ese
 * envío final es justo el que Meta rechaza, `rejectedByMeta()` no debe
 * escribir un SEGUNDO traspaso `unassigned`: como el conteo "Sin dueño" mira
 * la ÚLTIMA fila de `conversation_handoffs`, una conversación que sí quedó
 * con asesor asignado aparecería como sin dueño. Un solo traspaso por
 * salida, el más específico.
 */
describe("runAgentTurn — un solo traspaso por salida cuando la escalación forzada y el rechazo de Meta coinciden", () => {
  /**
   * El mock de `escalateConversation` no ejecuta el código real de
   * escalate.ts (está reemplazado por `vi.mock`), así que para probar "un
   * solo recordHandoff" hay que dejar que ESTE mock deje su traspaso, tal
   * como lo hace la función real ANTES de devolver.
   */
  it("queja escalada a un asesor + envío final rechazado por Meta: un solo recordHandoff, el de la escalación", async () => {
    const warn = vi.spyOn(log, "warn");
    classifyIntentMock.mockResolvedValue({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    escalateConversationMock.mockImplementation(async (...args: unknown[]) => {
      const [supabaseArg, params] = args as [
        { rpc: (fn: string, params: Record<string, unknown>) => Promise<unknown> },
        { conversationId: string },
      ];
      pasos.push("escalar");
      // Espeja lo que hace escalate.ts de verdad: deja su propio traspaso
      // ANTES de devolver, con el asesor ya asignado.
      await supabaseArg.rpc("record_handoff", {
        p_conversation_id: params.conversationId,
        p_to_kind: "human",
        p_reason: "escalada",
        p_to_id: "asesor-42",
      });
      return { escalated: true, assignedAgentName: "María" };
    });
    sendAgentTextMock.mockResolvedValueOnce({
      whatsapp_message_id: null,
      whatsapp_status: "failed" as const,
      whatsapp_error_code: 131047,
      whatsapp_error_detail: "Meta rechazó el envío",
      origenDelFallo: "meta" as const,
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    // Exactamente UN traspaso, y es el de la escalación — no un segundo
    // `rechazado_por_meta` que lo pisara.
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "human",
      p_reason: "escalada",
      p_to_id: "asesor-42",
    });
    // El rechazo de Meta sí se ve en el registro: solo se omite la bitácora.
    expect(warn).toHaveBeenCalledWith("turno_rechazado_por_meta", {
      conversationId: "conv-1",
      codigo: 131047,
      traspaso_omitido: "escalada_previa",
    });
    // A3 (5/9/2026): tampoco se pisa journey_stage. escalateConversation ya
    // dejó "assigned" antes del envío rechazado — resetear acá a null
    // disfrazaría de "sin escalar" un caso que sí tiene asesor.
    expect(conversationUpdates).not.toContainEqual({ journey_stage: null, active_tool: null });
  });

  /** El caso que ya existía (cubierto también en handoffs.test.ts) sigue igual: sin escalación previa, el rechazo de Meta registra su propio traspaso. */
  it("sin escalación previa, el rechazo de Meta en el tool loop sigue registrando rechazado_por_meta", async () => {
    const warn = vi.spyOn(log, "warn");
    sendAgentTextMock.mockResolvedValueOnce({
      whatsapp_message_id: null,
      whatsapp_status: "failed" as const,
      whatsapp_error_code: 131047,
      whatsapp_error_detail: "Meta rechazó el envío",
      origenDelFallo: "meta" as const,
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("turno_rechazado_por_meta", {
      conversationId: "conv-1",
      codigo: 131047,
    });
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "rechazado_por_meta",
    });
  });
});

/**
 * Anexo A1 (5/9/2026): la despedida de la IA al escalar sin asesores no
 * cuenta como respuesta real. Cubre los dos caminos por los que la IA se
 * despide sin nadie detrás —la red de seguridad de devolución/queja, y el
 * modelo que redacta su propia despedida tras invocar la herramienta— y los
 * dos controles: con asesor asignado, y una respuesta que ni siquiera
 * escaló.
 */
describe("runAgentTurn — anexo A1: is_auto_reply en la despedida de la IA al escalar sin asesores", () => {
  it("(a) red de seguridad de queja sin asesores: el texto fijo sale con isAutoReply true", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    // El modelo no redacta nada (tool loop agotado sin escalar de verdad):
    // el texto que sale es el fijo que arma la red de seguridad.
    generateMock.mockResolvedValueOnce({
      text: "",
      usage: { inputTokens: 20, outputTokens: 0, totalTokens: 20 },
      steps: [{}],
    });
    escalateConversationMock.mockImplementation(async () => {
      pasos.push("escalar");
      return { escalated: true, assignedAgentName: null, unassigned: true };
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Ya dejé tu caso registrado para que lo revise un asesor. En cuanto haya alguien disponible te escriben por acá.",
      { isAutoReply: true }
    );
  });

  it("(b) el modelo llama a escalarAAsesor, queda sin asesor y redacta su propia despedida: isAutoReply true", async () => {
    // Simula lo que haría la herramienta real (`buildEscalateTool`) si el
    // modelo la invocara durante el tool loop: mutar el `outcome` que le
    // llegó ANTES de que `agent.generate()` devuelva texto.
    buildEscalateToolMock.mockImplementationOnce((_deps, outcome) => {
      outcome.escalated = true;
      outcome.assignedAgentName = undefined;
      outcome.unassigned = true;
      pasos.push("escalar");
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "Ya dejé tu caso registrado, en cuanto haya alguien libre te escribe.",
      usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Ya dejé tu caso registrado, en cuanto haya alguien libre te escribe.",
      { isAutoReply: true }
    );
  });

  it("(c) escalación CON asesor: isAutoReply falso o ausente", async () => {
    buildEscalateToolMock.mockImplementationOnce((_deps, outcome) => {
      outcome.escalated = true;
      outcome.assignedAgentName = "María";
      outcome.unassigned = false;
      pasos.push("escalar");
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "Ya te paso con María, ella te ayuda con esto.",
      usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toBe("Ya te paso con María, ella te ayuda con esto.");
    const opciones = llamada[3] as { isAutoReply?: boolean } | undefined;
    expect(opciones?.isAutoReply).not.toBe(true);
  });

  it("(d) respuesta normal sin escalar: sin la marca", async () => {
    await runAgentTurn("conv-1");

    const llamada = sendAgentTextMock.mock.calls[0];
    const opciones = llamada[3] as { isAutoReply?: boolean } | undefined;
    expect(opciones?.isAutoReply).not.toBe(true);
  });
});

/**
 * "Escribiendo…" hacia el cliente (T3.1, 4/9/2026): se dispara justo al
 * arrancar el tool loop, y solo cuando de verdad hay a quién avisarle — canal
 * conectado, dentro de la ventana de 24h y con un mensaje entrante al que
 * apuntar. Ninguno de los tests de arriba lo dispara: su canal por defecto es
 * `demo` (ver beforeEach), así que este describe es el único que lo activa a
 * propósito.
 */
describe("runAgentTurn — 'escribiendo…' hacia el cliente", () => {
  beforeEach(() => {
    state.conversation = {
      ...state.conversation,
      channel: { phone_number_id: "phone-id-1", status: "connected" },
    };
    process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
  });

  afterEach(() => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
  });

  it("lo dispara sin esperar a que el modelo termine de redactar, con el wamid del último mensaje entrante", async () => {
    const ordenDeLlamadas: string[] = [];
    sendTypingIndicatorMock.mockImplementation(async () => {
      ordenDeLlamadas.push("typing");
    });
    // El modelo queda deliberadamente colgado: si el typing dependiera de que
    // `generate` termine (o corriera DESPUÉS de él), este test se quedaría
    // esperando para siempre en el primer `waitFor` de abajo.
    let resolverGenerate: () => void = () => {};
    generateMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolverGenerate = () => {
            ordenDeLlamadas.push("generate");
            resolve({
              text: "respuesta redactada por el modelo",
              usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
              steps: [{}, {}],
            });
          };
        })
    );

    const turno = runAgentTurn("conv-1");

    await vi.waitFor(() => expect(sendTypingIndicatorMock).toHaveBeenCalledTimes(1));
    expect(sendTypingIndicatorMock).toHaveBeenCalledWith("phone-id-1", "token-de-prueba", "wamid.ULTIMO_ENTRANTE");
    // El aviso ya llegó y el modelo TODAVÍA no devolvió nada: no lo esperó.
    expect(ordenDeLlamadas).toEqual(["typing"]);

    resolverGenerate();
    await turno;

    expect(ordenDeLlamadas).toEqual(["typing", "generate"]);
  });

  it("no lo dispara cuando el escenario responde: ese camino no redacta con el modelo", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(sendTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("no lo dispara fuera de la ventana de 24h de Meta", async () => {
    state.conversation = {
      ...state.conversation,
      last_customer_message_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };

    await runAgentTurn("conv-1");

    expect(sendTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("no lo dispara con el canal simulado (no 'connected')", async () => {
    state.conversation = { ...state.conversation, channel: { phone_number_id: null, status: "demo" } };

    await runAgentTurn("conv-1");

    expect(sendTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("no lo dispara sin WHATSAPP_ACCESS_TOKEN en el servidor", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;

    await runAgentTurn("conv-1");

    expect(sendTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("no lo dispara sin ningún mensaje entrante con wamid", async () => {
    state.lastInboundWamid = null;

    await runAgentTurn("conv-1");

    expect(sendTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("un fallo del typing no aborta el turno: el cliente igual recibe la respuesta", async () => {
    sendTypingIndicatorMock.mockRejectedValue(new Error("no debería pasar, pero si pasa no debe tumbar el turno"));

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Guarda de identidad (6/9/2026): último control antes de hablarle al
 * cliente, sobre el texto final del tool loop —después de la red de
 * seguridad de devolución/queja, justo antes del envío de la redacción. El
 * 26 y 27/8/2026 la IA se despidió como "el asistente automatizado de SBK
 * Motorcycles" 34 de 68 y 26 de 151 veces pese a que el SYSTEM_PROMPT ya lo
 * prohibía; esta es la cerradura para cuando el guion vuelve a fallar.
 */
describe("runAgentTurn — guarda de identidad", () => {
  it("(a) texto limpio: pasa sin llamada extra a generateText", async () => {
    const warn = vi.spyOn(log, "warn");
    const error = vi.spyOn(log, "error");
    // Negativo del catálogo a propósito: "automático" es un repuesto, no una
    // autorreferencia — revealsIdentity no debe calzar acá.
    generateMock.mockResolvedValueOnce({
      text: "El automático de la Horse está en 12$ a tasa BCV",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe("El automático de la Horse está en 12$ a tasa BCV");
    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(agentTurnInserts[0].summary).not.toMatch(/^\[identidad/);
    expect(warn).not.toHaveBeenCalledWith("identidad_reescrita", expect.anything());
    expect(error).not.toHaveBeenCalledWith("identidad_bloqueada", expect.anything());
  });

  it("(b) texto que calza: se reescribe una vez y sale limpio", async () => {
    const warn = vi.spyOn(log, "warn");
    const borrador =
      "¡Buenos días! Soy el asistente automatizado de SBK Motorcycles. El automático de la Horse está en 12$.";
    const reescrito = "¡Buenos días! Acá en SBK el automático de la Horse está en 12$.";
    generateMock.mockResolvedValueOnce({
      text: borrador,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });
    generateTextMock.mockResolvedValueOnce({
      text: reescrito,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });

    await runAgentTurn("conv-1");

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const opciones = generateTextMock.mock.calls[0][0] as {
      system: string;
      messages: { role: string; content: string }[];
      maxRetries: number;
    };
    expect(opciones.system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(opciones.system).toContain("asistente automatizado");
    expect(opciones.messages).toEqual([{ role: "user", content: borrador }]);
    expect(opciones.maxRetries).toBe(0);
    expect(getAgentModelCalls).toContain("low");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe(reescrito);
    // Nunca el borrador que se delataba.
    expect(sendAgentTextMock.mock.calls.some((llamada) => llamada[2] === borrador)).toBe(false);
    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("identidad_reescrita", {
      conversationId: "conv-1",
      categoria: "automatizacion",
      fragmento: "asistente automatizado",
    });

    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({ action: "answered" });
    expect((agentTurnInserts[0].summary as string).startsWith("[identidad reescrita]")).toBe(true);
    // 4 (reconocimiento de escenario, NO_USAGE del beforeEach) + 6
    // (clasificación) + 28 (redacción) + 14 (reescritura) = 52.
    expect(agentTurnInserts[0].total_tokens).toBe(52);
  });

  it("(c) reescrito que sigue calzando: se bloquea, se escala por 'seguimiento' y sale la despedida CON asesor", async () => {
    const error = vi.spyOn(log, "error");
    const borrador =
      "¡Buenos días! Soy el asistente automatizado de SBK Motorcycles. El automático de la Horse está en 12$.";
    const reescritoQueSigueCalzando = "Soy un asistente virtual de SBK, el automático está en 12$.";
    generateMock.mockResolvedValueOnce({
      text: borrador,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });
    generateTextMock.mockResolvedValueOnce({
      text: reescritoQueSigueCalzando,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    // Mock por defecto del beforeEach: { escalated: true, assignedAgentName: "María" } — CON asesor.

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe(DESPEDIDA_CON_ASESOR);
    const opcionesEnvio = sendAgentTextMock.mock.calls[0][3] as { isAutoReply?: boolean } | undefined;
    expect(opcionesEnvio?.isAutoReply).not.toBe(true);
    // Nunca el borrador ni el reescrito que se seguían delatando.
    expect(sendAgentTextMock.mock.calls.some((llamada) => llamada[2] === borrador)).toBe(false);
    expect(sendAgentTextMock.mock.calls.some((llamada) => llamada[2] === reescritoQueSigueCalzando)).toBe(false);

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(escalateConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        motivo: "seguimiento",
        resumen: "La respuesta redactada se describía como automatizada y no pudo corregirse. Retomar el hilo.",
      })
    );
    expect(error).toHaveBeenCalledWith("identidad_bloqueada", expect.objectContaining({ conversationId: "conv-1" }));

    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({ action: "escalated" });
    const summary = agentTurnInserts[0].summary as string;
    expect(summary.startsWith("[identidad bloqueada]")).toBe(true);
    expect(summary).toContain("seguimiento");
  });

  it("(c2) variante sin asesor: sale la despedida SIN asesor, marcada is_auto_reply", async () => {
    generateMock.mockResolvedValueOnce({
      text: "Soy un asistente virtual de SBK, el automático está en 12$.",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });
    generateTextMock.mockResolvedValueOnce({
      text: "Soy un asistente virtual de SBK, el automático está en 12$.",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    escalateConversationMock.mockImplementationOnce(async () => {
      pasos.push("escalar");
      return { escalated: true, assignedAgentName: null, unassigned: true };
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe(DESPEDIDA_SIN_ASESOR);
    const opciones = sendAgentTextMock.mock.calls[0][3] as { isAutoReply?: boolean } | undefined;
    expect(opciones?.isAutoReply).toBe(true);
  });

  it("(c3) generateText lanza: se trata como reescritura fallida, nunca se envía el borrador", async () => {
    const error = vi.spyOn(log, "error");
    const borrador = "Soy un bot, dame un momento y te cotizo el automático.";
    generateMock.mockResolvedValueOnce({
      text: borrador,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });
    generateTextMock.mockRejectedValueOnce(new Error("proveedor caído"));

    // No debe lanzar: un proveedor caído en la reescritura no puede tumbar el
    // turno, tiene que resolver igual con la despedida fija.
    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).not.toBe(borrador);
    expect([DESPEDIDA_SIN_ASESOR, DESPEDIDA_CON_ASESOR]).toContain(sendAgentTextMock.mock.calls[0][2]);
    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(escalateConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ motivo: "seguimiento" })
    );
    expect(error).toHaveBeenCalledWith(
      "identidad_bloqueada",
      expect.objectContaining({ conversationId: "conv-1", motivo: "reescritura_fallida" })
    );
  });

  it("(d) el modelo ya había escalado (queja) antes de redactar: no se escala una segunda vez por 'seguimiento'", async () => {
    const error = vi.spyOn(log, "error");
    classifyIntentMock.mockResolvedValueOnce({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    generateMock.mockResolvedValueOnce({
      text: "Soy un bot, ya te paso con un asesor.",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });
    generateTextMock.mockResolvedValueOnce({
      text: "Soy un asistente virtual, ya te paso con un asesor.",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    // escalateConversationMock por defecto (beforeEach): { escalated: true, assignedAgentName: "María" } —
    // es la llamada de la red de seguridad de "queja", ANTES de que corra la guarda de identidad.

    await runAgentTurn("conv-1");

    // Una sola escalación en todo el turno: la de "queja". La guarda NO
    // escala una segunda vez porque outcome.escalated ya era true.
    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(escalateConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ motivo: "queja" })
    );

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect([DESPEDIDA_SIN_ASESOR, DESPEDIDA_CON_ASESOR]).toContain(sendAgentTextMock.mock.calls[0][2]);
    expect(error).toHaveBeenCalledWith("identidad_bloqueada", expect.objectContaining({ conversationId: "conv-1" }));

    expect(agentTurnInserts).toHaveLength(1);
    const summary = agentTurnInserts[0].summary as string;
    expect(summary.startsWith("[identidad bloqueada]")).toBe(true);
  });

  /**
   * Test estático: las constantes y textos fijos que la propia guarda podría
   * llegar a mandar (u OFF_TOPIC_REPLY, que nunca pasa por la guarda en
   * caliente) no pueden delatarse a sí mismos — si alguna vez alguien les
   * agrega la palabra equivocada, este test lo agarra sin levantar el turno
   * completo.
   */
  it("(e) las despedidas fijas y OFF_TOPIC_REPLY no calzan ningún patrón de identidad", () => {
    expect(revealsIdentity(OFF_TOPIC_REPLY)).toBeNull();
    expect(revealsIdentity(DESPEDIDA_SIN_ASESOR)).toBeNull();
    expect(revealsIdentity(DESPEDIDA_CON_ASESOR)).toBeNull();
  });

  /**
   * Hueco cerrado el 6/9/2026 al integrar la guarda: la red de seguridad de
   * devolución/queja (más arriba en `runTurnPhases`, ANTES de la guarda de
   * identidad) copiaba `escalated`/`assignedAgentName`/`unassigned` de
   * `forced` pero nunca `outcome.motivo` — a diferencia de
   * `buildEscalateTool` en tools.ts, que sí lo hace. Sin esa copia, el
   * `summary` de `agent_turns` quedaba "Escalado a X. Motivo: undefined."
   * en vez de nombrar "queja" o "devolucion".
   */
  it("(f) red de seguridad de queja: el summary trae 'Motivo: queja.', no 'undefined'", async () => {
    classifyIntentMock.mockResolvedValueOnce({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    // Texto limpio, sin nada que la guarda de identidad tenga que tocar: este
    // test es sobre la red de seguridad de devolución/queja, no sobre la
    // guarda.
    generateMock.mockResolvedValueOnce({
      text: "Lamento lo que pasó, ya te paso con un asesor.",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(agentTurnInserts).toHaveLength(1);
    const summary = agentTurnInserts[0].summary as string;
    expect(summary).toContain("Motivo: queja.");
    expect(summary).not.toContain("undefined");
  });
});
