import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "@/lib/ai/classify";

// ---------------------------------------------------------------------------
// Prueba el lado de la bitácora (`record_handoff`) de las salidas silenciosas
// de `runAgentTurn`. `agent.test.ts` ya prueba, para cada una de estas mismas
// salidas, el lado del comportamiento (qué NO se envía); acá se prueba el
// lado nuevo: qué fila queda en `conversation_handoffs` y con qué razón.
//
// El fake de Supabase es una copia reducida del de `agent.test.ts` —mismas
// tablas, mismos RPC, mismo patrón de `state`— con un añadido: `record_handoff`
// queda capturado en `handoffCalls`, y `state.recordHandoffShouldFail` deja
// simular que la RPC falla, para la prueba de la regla inviolable.
//
// No se reutiliza el archivo de `agent.test.ts` porque cada archivo de test
// corre en su propio proceso (`pool: forks`, `isolate: true`): un `vi.mock`
// de uno no le llega al otro, así que hace falta su propio juego de mocks.
// ---------------------------------------------------------------------------

interface FakeState {
  canRun: boolean;
  conversation: Record<string, unknown> | null;
  history: { sender_type: string; content: string | null; is_internal_note: boolean }[];
  enabledToolKeys: string[];
  humanMessages: { created_at: string }[];
  turnLockRenewResult: { data: boolean | null; error: { message: string } | null };
  /** Si `true`, el insert de `agent_turns` revienta: dispara la salida "entrega_fallida". */
  agentTurnInsertShouldFail: boolean;
  /** Si `true`, la RPC `record_handoff` devuelve error en vez de insertar. */
  recordHandoffShouldFail: boolean;
}

const state: FakeState = {
  canRun: true,
  conversation: null,
  history: [],
  enabledToolKeys: [],
  humanMessages: [],
  turnLockRenewResult: { data: true, error: null },
  agentTurnInsertShouldFail: false,
  recordHandoffShouldFail: false,
};

/** Cada llamada a la RPC `record_handoff`, con los parámetros que le llegaron. */
const handoffCalls: Record<string, unknown>[] = [];
/** Cada `update` a `conversations`, con los valores que le llegaron (A3, 5/9/2026). */
const conversationUpdates: Record<string, unknown>[] = [];

function createFakeSupabase() {
  return {
    rpc(fn: string, params?: Record<string, unknown>) {
      if (fn === "agent_can_run") return Promise.resolve({ data: state.canRun, error: null });
      if (fn === "ai_turn_lock_acquire") return Promise.resolve({ data: true, error: null });
      if (fn === "ai_turn_lock_renew") {
        return state.turnLockRenewResult.error
          ? Promise.reject(new Error(state.turnLockRenewResult.error.message))
          : Promise.resolve({ data: state.turnLockRenewResult.data, error: null });
      }
      if (fn === "ai_turn_lock_release") return Promise.resolve({ data: true, error: null });
      if (fn === "record_handoff") {
        handoffCalls.push(params ?? {});
        if (state.recordHandoffShouldFail) {
          return Promise.resolve({ data: null, error: { message: "conexión perdida" } });
        }
        return Promise.resolve({ data: "handoff-1", error: null });
      }
      throw new Error(`Fake Supabase: rpc no soportada: ${fn}`);
    },
    from(table: string) {
      if (table === "agent_settings") {
        // Frente B3 (5/9/2026): runAgentTurn ahora lee el horario junto con
        // agent_can_run y la conversación. Sin fila ni error: parseBusinessHours
        // cae al horario por defecto y el turno sigue igual — este archivo no
        // prueba nada del horario, solo que su lectura no tumbe el turno.
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
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
          select: () => ({
            eq: () => ({
              order: () => ({ limit: async () => ({ data: state.history }) }),
              // Segundo `.eq()`: humanHasWritten (ver human-handled.ts). T7
              // (8/9/2026): ahora trae el mensaje de asesor MÁS RECIENTE
              // (`.order().limit(1)`), no la lista entera.
              eq: () => ({
                order: () => ({
                  limit: async () => {
                    const masReciente = [...state.humanMessages].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
                    return { data: masReciente ? [masReciente] : [], error: null };
                  },
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
        return { upsert: () => Promise.resolve({ data: null, error: null }) };
      }

      if (table === "agent_turns") {
        return {
          insert: () =>
            state.agentTurnInsertShouldFail
              ? Promise.reject(new Error("no se pudo escribir agent_turns"))
              : Promise.resolve({ data: null, error: null }),
        };
      }

      throw new Error(`Fake Supabase: tabla no soportada: ${table}`);
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createFakeSupabase() }));

vi.mock("@/lib/ai/playbooks", () => ({
  matchPlaybook: async () => ({ playbook: null, usage: NO_USAGE }),
  fetchActivePlaybooks: async () => [],
  playbookSentRecently: async () => false,
}));

type AnyMock = (...args: unknown[]) => Promise<unknown>;

/**
 * T0.3: `sendAgentText`/`sendPlaybookReply` devuelven el `DeliveryOutcome`
 * que `deliver()` mira para decidir si Meta rechazó el envío. Un mock que
 * resolviera `undefined` haría que TODO envío se leyera como bloqueado por
 * una guarda — el valor por defecto tiene que ser un outcome de verdad, el
 * mismo que produce un canal simulado.
 */
const OUTCOME_NO_ENVIADO = {
  whatsapp_message_id: null,
  whatsapp_status: null as "sent" | "failed" | null,
  whatsapp_error_code: null,
  whatsapp_error_detail: null,
};
/** El mismo outcome, pero como si Meta lo hubiera rechazado — para la salida `rechazado_por_meta`. */
function outcomeRechazado(codigo: number | null = 131047) {
  return {
    whatsapp_message_id: null,
    whatsapp_status: "failed" as const,
    whatsapp_error_code: codigo,
    whatsapp_error_detail: "Meta rechazó el envío",
  };
}
const sendPlaybookReplyMock = vi.fn<AnyMock>(async () => OUTCOME_NO_ENVIADO);
const sendAgentTextMock = vi.fn<AnyMock>(async () => OUTCOME_NO_ENVIADO);
vi.mock("@/lib/ai/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/send")>()),
  sendPlaybookReply: (...args: unknown[]) => sendPlaybookReplyMock(...args),
  sendAgentText: (...args: unknown[]) => sendAgentTextMock(...args),
}));

interface FakeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const NO_USAGE: FakeUsage = { inputTokens: 3, outputTokens: 1, totalTokens: 4 };

/** Por defecto clasifica algo que NO calza ninguna rama especial del turno. */
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

const generateMock = vi.fn(async () => ({
  text: "respuesta redactada por el modelo",
  usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
  steps: [{}, {}],
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  ToolLoopAgent: class {
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
import { log } from "@/lib/log";

function baseConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    contact_id: "contact-1",
    ai_enabled: true,
    assigned_agent_id: null,
    welcome_sent_at: "2026-08-22T10:00:00Z",
    last_customer_message_at: new Date().toISOString(),
    contact: { phone_number: "+584121112233" },
    channel: { phone_number_id: null, status: "demo" },
    ...overrides,
  };
}

beforeEach(() => {
  state.canRun = true;
  state.conversation = baseConversation();
  state.history = [{ sender_type: "customer", content: "hola quiero accesorios", is_internal_note: false }];
  state.enabledToolKeys = ["buscar_repuesto", "buscar_historial_compras", "consultar_biblioteca"];
  state.humanMessages = [];
  state.turnLockRenewResult = { data: true, error: null };
  state.agentTurnInsertShouldFail = false;
  state.recordHandoffShouldFail = false;
  handoffCalls.length = 0;
  conversationUpdates.length = 0;
  vi.clearAllMocks();
  classifyIntentMock.mockResolvedValue({
    intent: "consulta_disponibilidad",
    usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
  });
  generateMock.mockResolvedValue({
    text: "respuesta redactada por el modelo",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    steps: [{}, {}],
  });
});

describe("runAgentTurn — traspasos registrados en cada salida silenciosa", () => {
  it("si la conversación no existe, no registra ningún traspaso (FK contra conversations)", async () => {
    state.conversation = null;

    await runAgentTurn("conv-1");

    expect(handoffCalls).toHaveLength(0);
  });

  it("agente_no_puede_correr: con el interruptor global apagado", async () => {
    state.canRun = false;

    await runAgentTurn("conv-1");

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "agente_no_puede_correr",
    });
  });

  it("pausada: con ai_enabled=false en el chat", async () => {
    state.conversation = baseConversation({ ai_enabled: false });

    await runAgentTurn("conv-1");

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "pausada",
    });
  });

  it("asignada: con un asesor ya asignado al chat, viaja el toId", async () => {
    state.conversation = baseConversation({ assigned_agent_id: "asesor-42" });

    await runAgentTurn("conv-1");

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "human",
      p_reason: "asignada",
      p_to_id: "asesor-42",
    });
  });

  /**
   * Anexo A2 (5/9/2026): el estado normal tras una escalación o un cierre
   * manual es justo este -- IA apagada Y un asesor ya asignado. `openTurn`
   * mira `assigned_agent_id` ANTES que `ai_enabled` desde este anexo, así
   * que el traspaso tiene que ser `asignada`/`human`, nunca `pausada`. Antes
   * del reordenamiento este caso caía en `pausada`/`unassigned` -- una
   * conversación CON dueño quedando en la bitácora como si no lo tuviera.
   */
  it("asignada: ai_enabled=false Y un asesor ya asignado, gana el asesor (no pausada)", async () => {
    state.conversation = baseConversation({ ai_enabled: false, assigned_agent_id: "asesor-42" });

    await runAgentTurn("conv-1");

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "human",
      p_reason: "asignada",
      p_to_id: "asesor-42",
    });
    expect(handoffCalls.some((c) => c.p_reason === "pausada")).toBe(false);
  });

  it("humano_intervino: un asesor ya había escrito antes de abrir el turno", async () => {
    state.humanMessages = [{ created_at: new Date().toISOString() }];

    await runAgentTurn("conv-1");

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "human",
      p_reason: "humano_intervino",
    });
  });

  it("fuera_de_ventana: pasadas 24 h del último mensaje del cliente", async () => {
    state.conversation = baseConversation({
      last_customer_message_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });

    await runAgentTurn("conv-1");

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "fuera_de_ventana",
    });
  });

  it("identidad_no_verificable: se registra ANTES de que el turno lance NonRetryableTurnError", async () => {
    state.conversation = baseConversation({ contact: { phone_number: "" } });

    await expect(runAgentTurn("conv-1")).rejects.toMatchObject({ name: "NonRetryableTurnError" });

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "identidad_no_verificable",
    });
  });

  it("lock_perdido: el lease ya no era nuestro justo antes de enviar", async () => {
    state.turnLockRenewResult = { data: false, error: null };

    await runAgentTurn("conv-1");

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "lock_perdido",
    });
  });

  // D2 (6/9/2026): antes esta rama registraba `pausada`, pero `stillEnabled`
  // vuelve a consultar `agent_can_run` (interruptor global + tope de gasto),
  // NO el `ai_enabled` del chat -- `pausada` le correspondía al otro caso
  // (arriba, la guarda de `openTurn`). Las dos guardas del mismo apagado
  // global ahora dejan la misma razón en la bitácora.
  it("agente_no_puede_correr (deliver): el interruptor se apaga MIENTRAS el turno redacta", async () => {
    generateMock.mockImplementation(async () => {
      // El interruptor cambia después de abrir el turno, mientras el modelo
      // todavía está redactando: es la carrera que stillEnabled() cierra.
      state.canRun = false;
      return {
        text: "respuesta redactada por el modelo",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await runAgentTurn("conv-1");

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "agente_no_puede_correr",
    });
  });

  it("humano_se_adelanto: un asesor escribe MIENTRAS el turno redacta", async () => {
    generateMock.mockImplementation(async () => {
      state.humanMessages = [{ created_at: new Date().toISOString() }];
      return {
        text: "respuesta redactada por el modelo",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await runAgentTurn("conv-1");

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "human",
      p_reason: "humano_se_adelanto",
    });
  });

  it("entrega_fallida: el mensaje salió pero la bitácora posterior revienta", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "fuera_de_tema",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    state.agentTurnInsertShouldFail = true;

    await expect(runAgentTurn("conv-1")).rejects.toMatchObject({ name: "NonRetryableTurnError" });

    // El mensaje sí salió: esto es justo lo que separa esta salida de las
    // otras nueve, y por lo que no se reintenta (reenviaría el mensaje).
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "entrega_fallida",
    });
  });

  /**
   * T0.3: hasta ahora un rechazo de Meta (`whatsapp_status: "failed"`) no
   * frenaba nada — el turno seguía como si hubiera respondido (`logTurn`
   * "answered", `journey_stage` reseteado), y la conversación quedaba sin
   * dueño en la bitácora aunque el cliente no hubiera recibido el mensaje.
   * Este caso cubre la respuesta del tool loop (la más lejana al momento en
   * que se miraron las guardas de apertura); `agent.test.ts` cubre el mismo
   * mecanismo para el camino de escenario de fase 0.
   *
   * A3 (5/9/2026): sumado a la fila de traspaso, `rejectedByMeta` limpia
   * `journey_stage`/`active_tool` — antes de esto, un rechazo en este camino
   * dejaba la conversación pintada "Herramienta" (o "Clasificando", si no
   * llegó a invocar ninguna) para siempre en el tablero de Atascados.
   */
  it("rechazado_por_meta: la respuesta del tool loop sale rechazada por Meta", async () => {
    const warn = vi.spyOn(log, "warn");
    sendAgentTextMock.mockResolvedValueOnce(outcomeRechazado(131047));

    await runAgentTurn("conv-1");

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
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
  });
});

describe("runAgentTurn — la regla inviolable: registrar el traspaso nunca puede alterar el turno", () => {
  /**
   * Si `record_handoff` fallara y eso frenara el turno, el resultado sería
   * peor que el problema que esta bitácora vino a resolver: hoy el lead
   * queda sin rastro; así quedaría sin rastro Y sin respuesta (ver el
   * comentario de cabecera de handoffs.ts). Se prueba con la salida que
   * lanza —identidad_no_verificable— porque es la que más fácil se rompería
   * si alguien, por error, envolviera `recordHandoff` en un `try/catch` que
   * se comiera el throw en vez de dejarlo pasar.
   */
  it("con record_handoff fallando, el turno lanza EXACTAMENTE el mismo NonRetryableTurnError", async () => {
    state.conversation = baseConversation({ contact: { phone_number: "" } });
    state.recordHandoffShouldFail = true;

    await expect(runAgentTurn("conv-1")).rejects.toMatchObject({
      name: "NonRetryableTurnError",
      conversationId: "conv-1",
    });

    // La RPC sí se intentó —y falló—, pero eso no cambió nada del turno.
    expect(handoffCalls).toHaveLength(1);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /** Mismo principio, del lado de un `return` en vez de un `throw`. */
  it("con record_handoff fallando, un return sigue siendo el mismo return sin enviar nada", async () => {
    state.conversation = baseConversation({ ai_enabled: false });
    state.recordHandoffShouldFail = true;

    await expect(runAgentTurn("conv-1")).resolves.toBeUndefined();

    expect(handoffCalls).toHaveLength(1);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });
});
