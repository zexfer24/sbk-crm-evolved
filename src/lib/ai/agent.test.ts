import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Playbook } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fake de Supabase acotado a lo que el orquestador realmente consulta.
// ---------------------------------------------------------------------------
interface FakeState {
  aiGloballyEnabled: boolean;
  conversation: Record<string, unknown> | null;
  history: { sender_type: string; content: string | null; is_internal_note: boolean }[];
}

const state: FakeState = { aiGloballyEnabled: true, conversation: null, history: [] };
const conversationUpdates: Record<string, unknown>[] = [];
const agentTurnInserts: Record<string, unknown>[] = [];

function createFakeSupabase() {
  return {
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
            eq: (_col: string, _id: string) => {
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
              order: () => ({ limit: async () => ({ data: state.history }) }),
            }),
          }),
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
vi.mock("@/lib/ai/playbooks", () => ({
  matchPlaybook: (...args: unknown[]) => matchPlaybookMock(...args),
  fetchActivePlaybooks: () => fetchActivePlaybooksMock(),
}));

type AnyMock = (...args: unknown[]) => Promise<unknown>;

const sendPlaybookReplyMock = vi.fn<AnyMock>(async () => undefined);
const sendAgentTextMock = vi.fn<AnyMock>(async () => undefined);
vi.mock("@/lib/ai/send", () => ({
  sendPlaybookReply: (...args: unknown[]) => sendPlaybookReplyMock(...args),
  sendAgentText: (...args: unknown[]) => sendAgentTextMock(...args),
}));

const classifyIntentMock = vi.fn(async () => ({
  intent: "consulta_disponibilidad" as const,
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

import { runAgentTurn } from "@/lib/ai/agent";

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
    ...overrides,
  };
}

const NO_USAGE = { inputTokens: 3, outputTokens: 1, totalTokens: 4 };

beforeEach(() => {
  state.aiGloballyEnabled = true;
  state.conversation = {
    id: "conv-1",
    contact_id: "contact-1",
    ai_enabled: true,
    assigned_agent_id: null,
    contact: { phone_number: "+584121112233" },
    channel: { phone_number_id: null, status: "demo" },
  };
  state.history = [{ sender_type: "customer", content: "hola quiero accesorios", is_internal_note: false }];
  conversationUpdates.length = 0;
  agentTurnInserts.length = 0;
  vi.clearAllMocks();
  fetchActivePlaybooksMock.mockResolvedValue([]);
  matchPlaybookMock.mockResolvedValue({ playbook: null, usage: NO_USAGE });
  classifyIntentMock.mockResolvedValue({
    intent: "consulta_disponibilidad",
    usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
  });
  generateMock.mockResolvedValue({
    text: "respuesta redactada por el modelo",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
  });
  escalateConversationMock.mockResolvedValue({ escalated: true, assignedAgentName: "María" });
});

describe("runAgentTurn — escenarios predeterminados", () => {
  it("cuando un escenario coincide, responde con él y no llama al modelo redactor", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(sendPlaybookReplyMock.mock.calls[0][2]).toEqual(pb);
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
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
      total_tokens: 4,
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

  it("no reconoce escenarios si la conversación ya tiene un asesor asignado", async () => {
    state.conversation = { ...state.conversation, assigned_agent_id: "agent-9" };
    fetchActivePlaybooksMock.mockResolvedValue([playbook()]);

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });
});
