import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Playbook } from "@/lib/types";
import type { Intent } from "@/lib/ai/classify";

// ---------------------------------------------------------------------------
// T10b-3, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (29/9/2026, D2 del operador): `runDelayTurn` es el turno de Seba
// por DEMORA -- el cliente lleva minutos sin que una persona le escriba, y la
// IA puede estar pausada o el chat tener asesor. Corre fuera de la cola, con
// el lock de la conversación, y se salta a propósito `ai_enabled` y
// `humanHasWritten`.
//
// Este archivo ejercita `agent.ts` DE VERDAD (`runTurnPhases` con `modo:
// "demora"`), con el SDK de IA, Meta y el proveedor fingidos -- el mismo
// arnés que `agent.test.ts`, recortado a lo que el turno por demora toca. Los
// relojes son SIEMPRE fechas fijas (`vi.setSystemTime`): nada depende de la
// hora a la que corra la suite.
//
// El fake de Supabase registra operador + columna + valor de cada filtro y
// APLICA los filtros de verdad (regla de CLAUDE.md, revisión del 20/9/2026:
// un fake que se traga el operador deja pasar un `.gte` por un `.gt`). Una
// tabla que el turno por demora no debería tocar -- `conversation_delay_
// episodes` (la reclama el cron), `conversation_handoffs` (la leen
// `escalationOpen` y la gracia de `humanHasWritten`) -- lanza al consultarse.
// ---------------------------------------------------------------------------

/** Martes 29/9/2026, 11:00 en Caracas (UTC-4): la tienda está ABIERTA (L-V 8:00-18:00). */
const NOW_ABIERTO = new Date("2026-09-29T15:00:00Z");
/** Martes 29/9/2026, 19:30 en Caracas: CERRADA; abre el miércoles a las 8:00 am. */
const NOW_CERRADO = new Date("2026-09-29T23:30:00Z");

const MINUTO = 60_000;

interface AgentMessageRow {
  created_at: string;
  direction: string;
  is_internal_note: boolean;
}

interface FakeState {
  canRun: boolean;
  canRunError: { message: string } | null;
  conversation: Record<string, unknown> | null;
  /** Descendente (lo más nuevo primero), como lo devuelve la consulta real. */
  history: { sender_type: string; content: string | null; is_internal_note: boolean; message_type?: string; created_at?: string; id?: string }[];
  /** Mensajes con `sender_type = 'agent'` (asesores humanos). */
  agentMessages: AgentMessageRow[];
  enabledToolKeys: string[];
  lockAcquired: boolean;
  noteInsertError: { message: string } | null;
}

const state: FakeState = {
  canRun: true,
  canRunError: null,
  conversation: null,
  history: [],
  agentMessages: [],
  enabledToolKeys: [],
  lockAcquired: true,
  noteInsertError: null,
};

/** Cada UPDATE sobre `conversations` (valores). Nada del turno por demora puede tocar `ai_enabled` ni `welcome_sent_at`. */
const conversationUpdates: Record<string, unknown>[] = [];
const messageInserts: Record<string, unknown>[] = [];
const agentTurnInserts: Record<string, unknown>[] = [];
const handoffCalls: Record<string, unknown>[] = [];
/** Filtros de cada consulta de "¿escribió un asesor después de...?" (columnas `id`). */
const asesorQueryFilters: { op: string; col: string; val: unknown }[][] = [];
/** Consultas de `messages` que NO deberían existir en modo demora (`humanHasWritten` pide `created_at`). */
const consultasProhibidas: string[] = [];

type Filter = { op: string; col: string; val: unknown };

function applyFilters(rows: AgentMessageRow[], filters: Filter[]): AgentMessageRow[] {
  return rows.filter((row) =>
    filters.every((f) => {
      if (f.col === "conversation_id") return true;
      if (f.col === "sender_type") return f.op === "eq" && f.val === "agent";
      if (f.col === "direction") return f.op === "eq" && row.direction === f.val;
      if (f.col === "is_internal_note") return f.op === "eq" && row.is_internal_note === f.val;
      if (f.col === "created_at") {
        const t = Date.parse(row.created_at);
        const ref = Date.parse(String(f.val));
        if (f.op === "gt") return t > ref;
        if (f.op === "gte") return t >= ref;
        return false;
      }
      return true;
    })
  );
}

function createFakeSupabase() {
  return {
    rpc(fn: string, params?: Record<string, unknown>) {
      if (fn === "agent_can_run") {
        if (state.canRunError) return Promise.resolve({ data: null, error: state.canRunError });
        return Promise.resolve({ data: state.canRun, error: null });
      }
      if (fn === "ai_turn_lock_acquire") return Promise.resolve({ data: state.lockAcquired, error: null });
      if (fn === "ai_turn_lock_renew") return Promise.resolve({ data: true, error: null });
      if (fn === "ai_turn_lock_release") return Promise.resolve({ data: true, error: null });
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
            eq: () => ({ maybeSingle: async () => ({ data: { business_hours: undefined }, error: null }) }),
          }),
        };
      }

      if (table === "conversations") {
        return {
          select: (columns: string) => {
            // `shouldCedeDraft` (cesión de borrador) relee solo esta columna:
            // el turno por demora NO cede -- si llegara acá, el test lo delata.
            if (columns === "last_customer_message_at") {
              consultasProhibidas.push("conversations.last_customer_message_at (cesión de borrador)");
            }
            return { eq: () => ({ maybeSingle: async () => ({ data: state.conversation, error: null }) }) };
          },
          update: (values: Record<string, unknown>) => ({
            eq: () => {
              conversationUpdates.push(values);
              const resultado = { data: null, error: null };
              return {
                is: () => ({
                  select: async () => {
                    consultasProhibidas.push("conversations.update(...).is(...) (reclamo de presentación)");
                    return { data: [{ id: "conv-1" }], error: null };
                  },
                }),
                then: (resolve: (value: typeof resultado) => void) => resolve(resultado),
              };
            },
          }),
        };
      }

      if (table === "messages") {
        return {
          insert: (row: Record<string, unknown>) => {
            messageInserts.push(row);
            return Promise.resolve({ data: null, error: state.noteInsertError });
          },
          select: (columns: string) => {
            const filters: Filter[] = [];
            const q = {
              eq: (col: string, val: unknown) => {
                filters.push({ op: "eq", col, val });
                return q;
              },
              gt: (col: string, val: unknown) => {
                filters.push({ op: "gt", col, val });
                return q;
              },
              gte: (col: string, val: unknown) => {
                filters.push({ op: "gte", col, val });
                return q;
              },
              order: () => q,
              limit: () => q,
              maybeSingle: async () => ({
                data: columns === "whatsapp_message_id" ? { whatsapp_message_id: "wamid.ULTIMO" } : null,
                error: null,
              }),
              then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
                try {
                  if (columns.startsWith("sender_type, content")) {
                    return resolve({ data: state.history, error: null });
                  }
                  if (columns === "created_at") {
                    // `humanHasWritten` (human-handled.ts): la gracia de 30 min.
                    consultasProhibidas.push("messages.created_at (humanHasWritten)");
                    return resolve({ data: [], error: null });
                  }
                  if (columns === "id") {
                    asesorQueryFilters.push([...filters]);
                    const rows = applyFilters(state.agentMessages, filters);
                    return resolve({ data: rows.map((_, i) => ({ id: `agent-msg-${i}` })), error: null });
                  }
                  return resolve({ data: [], error: null });
                } catch (err) {
                  return reject(err);
                }
              },
            };
            return q;
          },
        };
      }

      if (table === "agent_tools") {
        return {
          select: () => ({
            eq: async () => ({ data: state.enabledToolKeys.map((key) => ({ key })), error: null }),
          }),
        };
      }

      if (table === "agent_turns") {
        return {
          insert: (row: Record<string, unknown>) => {
            agentTurnInserts.push(row);
            return { select: () => ({ single: async () => ({ data: { id: "agent-turn-1" }, error: null }) }) };
          },
        };
      }

      if (table === "agent_turn_calls") {
        return { insert: () => Promise.resolve({ data: null, error: null }) };
      }

      throw new Error(`Fake Supabase: tabla no soportada en modo demora: ${table}`);
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createFakeSupabase() }));

const redisStore = new Map<string, string>();
vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    get: async (key: string) => redisStore.get(key) ?? null,
    set: async (key: string, value: string) => {
      redisStore.set(key, value);
      return "OK" as const;
    },
    incr: async () => 1,
    expire: async () => 1,
    del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
  }),
}));

const matchPlaybookMock = vi.fn();
const fetchActivePlaybooksMock = vi.fn(async () => [] as Playbook[]);
const playbookSentRecentlyMock = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => false);
vi.mock("@/lib/ai/playbooks", () => ({
  matchPlaybook: (...args: unknown[]) => matchPlaybookMock(...args),
  fetchActivePlaybooks: () => fetchActivePlaybooksMock(),
  playbookSentRecently: (...args: unknown[]) => playbookSentRecentlyMock(...args),
  ZERO_USAGE: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
}));

vi.mock("@/lib/ai/lessons", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/lessons")>()),
  fetchTurnLessons: async () => ({ global: [], chat: [] }),
}));
vi.mock("@/lib/ai/catalog-links", () => ({ fetchTurnCatalogLinks: async () => [] }));

const OUTCOME = {
  whatsapp_message_id: null,
  whatsapp_status: null as "sent" | "failed" | null,
  whatsapp_error_code: null as number | null,
  whatsapp_error_detail: null as string | null,
  origenDelFallo: null as "meta" | "red" | null,
};
const sendPlaybookReplyMock = vi.fn<(...args: unknown[]) => Promise<typeof OUTCOME>>(async () => OUTCOME);
const sendAgentTextMock = vi.fn<(...args: unknown[]) => Promise<typeof OUTCOME>>(async () => OUTCOME);
vi.mock("@/lib/ai/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/send")>()),
  sendPlaybookReply: (...args: unknown[]) => sendPlaybookReplyMock(...args),
  sendAgentText: (...args: unknown[]) => sendAgentTextMock(...args),
}));

const classifyIntentMock = vi.fn<(...args: unknown[]) => Promise<{ intent: Intent; usage: unknown }>>(async () => ({
  intent: "otro",
  usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
}));
vi.mock("@/lib/ai/classify", () => ({ classifyIntent: (...args: unknown[]) => classifyIntentMock(...args) }));

/** La escalada real: si el turno por demora la llamara por CUALQUIER camino, estos tests se ponen rojos. */
const escalateConversationMock = vi.fn(async () => ({ escalated: true, assignedAgentName: "María" }));
vi.mock("@/lib/ai/escalate", () => ({
  escalateConversation: (...args: unknown[]) => escalateConversationMock(...(args as [])),
  RECLAMO_CATEGORIES: ["Envío", "Pago", "Producto", "Atención", "Garantía"],
}));

const generateMock = vi.fn<() => Promise<{ text: string; usage: unknown; steps: unknown[] }>>(async () => ({
  text: "Claro, las pastillas para esa moto están en el sistema.",
  usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
  steps: [{}],
}));
const agentOptions: { instructions: string; tools: Record<string, unknown> }[] = [];
const generateTextMock = vi.fn<(args: Record<string, unknown>) => Promise<{ text: string; usage: unknown }>>(
  async () => ({ text: "texto reescrito limpio", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } })
);
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

vi.mock("@/lib/ai/model", () => ({
  getAgentModel: () => ({ model: "modelo-falso" }),
  currentAgentModelLabel: () => "fake/modelo",
}));

const buildEscalateToolMock = vi.fn<(...args: unknown[]) => object>(() => ({}));
const buildCatalogToolMock = vi.fn<(deps: unknown, outcome: Record<string, unknown>) => object>(() => ({}));
vi.mock("@/lib/ai/tools", () => ({
  buildCatalogTool: (deps: unknown, outcome: Record<string, unknown>) => buildCatalogToolMock(deps, outcome),
  buildEscalateTool: (...args: unknown[]) => buildEscalateToolMock(...args),
  buildOrderHistoryTool: () => ({}),
}));
vi.mock("@/lib/ai/knowledge", () => ({ buildKnowledgeTool: () => ({}) }));
vi.mock("@/lib/whatsapp/meta-client", () => ({ sendTypingIndicator: vi.fn().mockResolvedValue(undefined) }));

import { runDelayTurn } from "@/lib/ai/delay-turn";
import { cacheablePrefix } from "@/lib/ai/prompt";
import { revealsIdentity } from "@/lib/ai/identity-guard";
import {
  TEXTO_CONFIRMAR_INVENTARIO,
  TEXTO_ESPERA_DEMORA,
  TEXTO_PRECIO_A_CONFIRMAR,
  sebaGreeting,
  textoEsperaDemora,
} from "@/lib/ai/seba";
import { businessStatus } from "@/lib/business-hours";
import { log } from "@/lib/log";

function playbook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "pb-1",
    name: "Ubicación",
    triggerDescription: "el cliente pregunta dónde queda la tienda",
    responseText: "Estamos en la avenida principal, frente a la plaza.",
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    isActive: true,
    cedeAlInventario: false,
    disponibleEnEspera: true,
    tags: [],
    ...overrides,
  };
}

const PREGUNTA = "¿Tienen pastillas de freno para la Bera SBR?";

/** ISO de `minutos` antes de `now`. */
function hace(minutos: number, now: Date): string {
  return new Date(now.getTime() - minutos * MINUTO).toISOString();
}

/** Arma el chat de prueba: IA PAUSADA y sin asesor (el caso de D2), el cliente escribió hace 12 min. */
function armarChat(now: Date, overrides: Record<string, unknown> = {}) {
  const lcma = hace(12, now);
  state.conversation = {
    id: "conv-1",
    contact_id: "contact-1",
    ai_enabled: false,
    assigned_agent_id: null,
    welcome_sent_at: "2026-09-29T14:00:00Z",
    last_customer_message_at: lcma,
    ai_resume_cutoff_at: null,
    deal_status: "none",
    contact: { phone_number: "+584121112233" },
    channel: { phone_number_id: null, status: "demo" },
    ...overrides,
  };
  state.history = [{ sender_type: "customer", content: PREGUNTA, is_internal_note: false, message_type: "text", created_at: lcma, id: "m1" }];
  return lcma;
}

async function correr(now: Date = NOW_ABIERTO, esperaMinutos = 12) {
  return runDelayTurn("conv-1", { episodeAt: new Date(now.getTime() - esperaMinutos * MINUTO), esperaMinutos, now });
}

/** Todo lo que el turno le mandó al cliente por `sendAgentText`, en texto. */
function textosEnviados(): string[] {
  return sendAgentTextMock.mock.calls.map((call) => call[2] as string);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_ABIERTO);
  state.canRun = true;
  state.canRunError = null;
  state.agentMessages = [];
  state.enabledToolKeys = ["buscar_repuesto", "buscar_historial_compras", "consultar_biblioteca"];
  state.lockAcquired = true;
  state.noteInsertError = null;
  conversationUpdates.length = 0;
  messageInserts.length = 0;
  agentTurnInserts.length = 0;
  handoffCalls.length = 0;
  asesorQueryFilters.length = 0;
  consultasProhibidas.length = 0;
  agentOptions.length = 0;
  redisStore.clear();
  vi.clearAllMocks();
  armarChat(NOW_ABIERTO);
  fetchActivePlaybooksMock.mockResolvedValue([]);
  matchPlaybookMock.mockResolvedValue({ playbook: null, usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
  playbookSentRecentlyMock.mockResolvedValue(false);
  classifyIntentMock.mockResolvedValue({ intent: "otro", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } });
  generateMock.mockResolvedValue({
    text: "Claro, las pastillas para esa moto están en el sistema.",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    steps: [{}],
  });
  generateTextMock.mockResolvedValue({
    text: "texto reescrito limpio",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  });
  sendAgentTextMock.mockResolvedValue(OUTCOME);
  sendPlaybookReplyMock.mockResolvedValue(OUTCOME);
  buildCatalogToolMock.mockImplementation(() => ({}));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runDelayTurn — quién puede recibir la respuesta", () => {
  it("responde con la IA PAUSADA (ai_enabled = false) y sin asesor, marcada is_auto_reply", async () => {
    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe("Claro, las pastillas para esa moto están en el sistema.");
    expect(sendAgentTextMock.mock.calls[0][3]).toMatchObject({ isAutoReply: true });
  });

  it("responde con un asesor ASIGNADO que todavía no escribió", async () => {
    armarChat(NOW_ABIERTO, { assigned_agent_id: "agente-1", ai_enabled: true });

    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
    expect(sendAgentTextMock.mock.calls[0][3]).toMatchObject({ isAutoReply: true });
  });

  it("NO cambia ai_enabled ni toca la presentación de la conversación", async () => {
    await correr();

    for (const valores of conversationUpdates) {
      expect(valores).not.toHaveProperty("ai_enabled");
      expect(valores).not.toHaveProperty("welcome_sent_at");
      expect(valores).not.toHaveProperty("assigned_agent_id");
    }
    expect(consultasProhibidas).toEqual([]);
  });

  it("se salta la gracia de humanHasWritten: un asesor que escribió ANTES del mensaje del cliente no lo frena", async () => {
    const lcma = armarChat(NOW_ABIERTO);
    // Un mensaje de asesor un minuto ANTES del mensaje del cliente: con la
    // regla normal ("el asesor se adelantó") la IA no entraría.
    state.agentMessages = [{ created_at: new Date(Date.parse(lcma) - MINUTO).toISOString(), direction: "outbound", is_internal_note: false }];

    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
    expect(consultasProhibidas).toEqual([]);
  });

  it("no lee la marca 'visto hasta': responde aunque un turno anterior ya haya marcado el mensaje como visto", async () => {
    redisStore.set(
      "turno:visto:conv-1",
      JSON.stringify({ hasta: new Date(NOW_ABIERTO.getTime() - 12 * MINUTO).toISOString(), ids: ["m1"] })
    );

    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
    expect(resultado.motivo).not.toBe("sin_mensaje_pendiente");
  });
});

describe("runDelayTurn — la puerta de envío: solo un asesor DESPUÉS del mensaje del cliente la cierra", () => {
  it("un asesor que escribió después de last_customer_message_at corta el turno: asesor_ya_respondio", async () => {
    const lcma = armarChat(NOW_ABIERTO);
    state.agentMessages = [{ created_at: new Date(Date.parse(lcma) + 3 * MINUTO).toISOString(), direction: "outbound", is_internal_note: false }];

    const resultado = await correr();

    expect(resultado).toEqual({ enviado: false, motivo: "asesor_ya_respondio" });
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(messageInserts).toEqual([]);
  });

  it("pregunta por mensajes REALES de asesor posteriores a lcma (gt, no gte; sin notas internas; salientes)", async () => {
    const lcma = armarChat(NOW_ABIERTO);

    await correr();

    expect(asesorQueryFilters.length).toBeGreaterThan(0);
    const filtros = asesorQueryFilters[0];
    expect(filtros).toContainEqual({ op: "eq", col: "conversation_id", val: "conv-1" });
    expect(filtros).toContainEqual({ op: "eq", col: "sender_type", val: "agent" });
    expect(filtros).toContainEqual({ op: "eq", col: "direction", val: "outbound" });
    expect(filtros).toContainEqual({ op: "eq", col: "is_internal_note", val: false });
    expect(filtros).toContainEqual({ op: "gt", col: "created_at", val: lcma });
  });

  it("una NOTA interna de un asesor no cuenta como respuesta: el turno sigue", async () => {
    const lcma = armarChat(NOW_ABIERTO);
    state.agentMessages = [{ created_at: new Date(Date.parse(lcma) + 3 * MINUTO).toISOString(), direction: "outbound", is_internal_note: true }];

    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
  });

  it("un asesor que escribe MIENTRAS el modelo redacta corta el envío y deja el traspaso humano", async () => {
    const lcma = armarChat(NOW_ABIERTO);
    generateMock.mockImplementationOnce(async () => {
      state.agentMessages = [{ created_at: new Date(Date.parse(lcma) + 5 * MINUTO).toISOString(), direction: "outbound", is_internal_note: false }];
      return { text: "respuesta tardía", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [{}] };
    });

    const resultado = await correr();

    expect(resultado).toEqual({ enviado: false, motivo: "asesor_ya_respondio" });
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(handoffCalls).toContainEqual(expect.objectContaining({ p_reason: "humano_se_adelanto", p_to_kind: "human" }));
  });

  it("fuera de la ventana de 24 h no manda nada: fuera_de_ventana", async () => {
    armarChat(NOW_ABIERTO, { last_customer_message_at: hace(25 * 60, NOW_ABIERTO) });

    const resultado = await correr();

    expect(resultado).toEqual({ enviado: false, motivo: "fuera_de_ventana" });
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  it("si otro turno tiene el lock de la conversación, no lanza: turno_en_curso", async () => {
    state.lockAcquired = false;

    const resultado = await correr();

    expect(resultado).toEqual({ enviado: false, motivo: "turno_en_curso" });
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });
});

describe("runDelayTurn — respeta agent_can_run()", () => {
  it("con el interruptor global apagado (o el tope de gasto) no envía: agente_no_puede_correr", async () => {
    state.canRun = false;

    const resultado = await correr();

    expect(resultado).toEqual({ enviado: false, motivo: "agente_no_puede_correr" });
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
  });

  it("si se apaga MIENTRAS el modelo redacta, el envío se frena igual", async () => {
    generateMock.mockImplementationOnce(async () => {
      state.canRun = false;
      return { text: "respuesta tardía", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [{}] };
    });

    const resultado = await correr();

    expect(resultado).toEqual({ enviado: false, motivo: "agente_no_puede_correr" });
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  it("un ERROR de la RPC (no un false) lanza: es infraestructura, no una decisión", async () => {
    state.canRunError = { message: "connection reset" };

    await expect(correr()).rejects.toThrow(/agent_can_run no consultable/);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  it("no toca el traspaso 'sin dueño' cuando se calla por el interruptor: el dueño no cambió", async () => {
    state.canRun = false;
    armarChat(NOW_ABIERTO, { assigned_agent_id: "agente-1" });

    await correr();

    expect(handoffCalls.filter((h) => h.p_to_kind === "unassigned")).toEqual([]);
  });
});

describe("runDelayTurn — sin escalada en ningún camino (D2)", () => {
  it("no le da al modelo la herramienta de escalar ni la construye", async () => {
    await correr();

    expect(buildEscalateToolMock).not.toHaveBeenCalled();
    expect(agentOptions).toHaveLength(1);
    expect(Object.keys(agentOptions[0].tools)).not.toContain("escalarAAsesor");
    // El resto de las herramientas SÍ le llegan: es un turno de verdad.
    expect(Object.keys(agentOptions[0].tools)).toContain("buscarRepuesto");
  });

  it.each<[Intent]>([["queja"], ["devolucion"]])(
    "una %s no dispara la red de seguridad que escala en código",
    async (intent) => {
      classifyIntentMock.mockResolvedValue({ intent, usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } });
      generateMock.mockResolvedValue({ text: "", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [{}] });

      const resultado = await correr();

      expect(escalateConversationMock).not.toHaveBeenCalled();
      // Sin texto del modelo sale el texto fijo de espera, no la despedida de escalada.
      expect(resultado.enviado).toBe(true);
      expect(textosEnviados()).toEqual([TEXTO_ESPERA_DEMORA]);
    }
  );

  it("un repuesto encontrado con existencia no dispara la red del catálogo (no escala)", async () => {
    classifyIntentMock.mockResolvedValue({ intent: "consulta_disponibilidad", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } });
    buildCatalogToolMock.mockImplementation((_deps, outcome) => {
      outcome.ran = true;
      outcome.conExistencia = true;
      return {};
    });

    const resultado = await correr();

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(resultado.enviado).toBe(true);
    // El texto fijo del cliente sí se anexa: dice que un asesor confirma el inventario.
    expect(textosEnviados()[0]).toContain(TEXTO_CONFIRMAR_INVENTARIO);
  });

  it("la guarda de promesa falsa no escala: el texto sale tal cual", async () => {
    generateMock.mockResolvedValue({
      text: "Un asesor ya tiene tu caso y te escribe pronto.",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      steps: [{}],
    });

    await correr();

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(textosEnviados()).toEqual(["Un asesor ya tiene tu caso y te escribe pronto."]);
  });

  it("la guarda de cifras REEMPLAZA el texto sin escalar, con el texto de espera (no el de 'te paso con un asesor')", async () => {
    generateMock.mockResolvedValue({
      text: "El intercomunicador sale en *108$ BCV*",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      steps: [{}],
    });
    const warn = vi.spyOn(log, "warn");

    await correr();

    expect(warn).toHaveBeenCalledWith("cifra_sin_fuente", expect.objectContaining({ conversationId: "conv-1" }));
    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(textosEnviados()).toEqual([TEXTO_ESPERA_DEMORA]);
    expect(textosEnviados()[0]).not.toBe(TEXTO_PRECIO_A_CONFIRMAR);
  });

  it("la guarda de identidad, si bloquea, no escala: sale el texto de espera", async () => {
    generateMock.mockResolvedValue({
      text: "Soy el asistente automatizado de la tienda.",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      steps: [{}],
    });
    generateTextMock.mockResolvedValue({
      text: "Sigo siendo un asistente automatizado.",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    await correr();

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(textosEnviados()).toEqual([TEXTO_ESPERA_DEMORA]);
  });

  it("dos adjuntos sin texto seguidos no escalan en código: el turno sigue y responde", async () => {
    const lcma = hace(12, NOW_ABIERTO);
    state.history = [
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "image", created_at: lcma, id: "m3" },
      { sender_type: "ai", content: "¿Qué repuesto buscas?", is_internal_note: false, message_type: "text", created_at: hace(20, NOW_ABIERTO), id: "m2" },
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "image", created_at: hace(25, NOW_ABIERTO), id: "m1" },
    ];

    const resultado = await correr();

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(resultado.enviado).toBe(true);
  });
});

describe("runDelayTurn — sin saludo ni presentación de Seba", () => {
  it("un chat que nunca se presentó (welcome_sent_at = null) no recibe el saludo ni sella la presentación", async () => {
    armarChat(NOW_ABIERTO, { welcome_sent_at: null });

    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
    expect(textosEnviados()).toEqual(["Claro, las pastillas para esa moto están en el sistema."]);
    for (const banda of ["mañana", "tarde", "noche"] as const) {
      expect(textosEnviados()).not.toContain(sebaGreeting(banda));
    }
    expect(consultasProhibidas).toEqual([]);
  });

  it("un cliente que solo saluda (hola) no recibe el saludo fijo ni espera la pregunta: se contesta con el modelo", async () => {
    const lcma = hace(12, NOW_ABIERTO);
    state.history = [{ sender_type: "customer", content: "hola", is_internal_note: false, message_type: "text", created_at: lcma, id: "m1" }];

    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});

describe("runDelayTurn — escenarios: solo los marcados disponible_en_espera y que no se repiten", () => {
  it("fase 0 recibe SOLO los escenarios disponibles en espera, sin despedidas ni los que escalan", async () => {
    fetchActivePlaybooksMock.mockResolvedValue([
      playbook({ id: "pb-ubicacion", name: "Ubicación", disponibleEnEspera: true }),
      playbook({ id: "pb-catalogo", name: "Catálogo general", disponibleEnEspera: false }),
      playbook({ id: "pb-gracias", name: "Gracias", responseText: "¡Muchas gracias por preferirnos!", disponibleEnEspera: true }),
      playbook({ id: "pb-escala", name: "Error de comentario", afterSend: "escalate", disponibleEnEspera: true }),
    ]);

    await correr();

    expect(matchPlaybookMock).toHaveBeenCalledTimes(1);
    const candidatos = matchPlaybookMock.mock.calls[0][1] as Playbook[];
    expect(candidatos.map((p) => p.name)).toEqual(["Ubicación"]);
  });

  it("un escenario marcado disponible que calza sale tal cual, como respuesta automática", async () => {
    const ubicacion = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([ubicacion]);
    matchPlaybookMock.mockResolvedValue({ playbook: ubicacion, usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });

    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(sendPlaybookReplyMock.mock.calls[0][4]).toMatchObject({ isAutoReply: true });
    expect(generateMock).not.toHaveBeenCalled();
    expect(escalateConversationMock).not.toHaveBeenCalled();
  });

  it("un escenario NO marcado que el modelo de fase 0 eligiera igual no sale (no llega a los candidatos)", async () => {
    const catalogo = playbook({ id: "pb-catalogo", name: "Catálogo general", disponibleEnEspera: false });
    fetchActivePlaybooksMock.mockResolvedValue([catalogo]);
    // Aunque el mock de fase 0 devolviera el escenario, el turno ni siquiera
    // se lo ofreció: se le pasó una lista vacía.
    matchPlaybookMock.mockImplementation(async (_h: unknown, candidatos: Playbook[]) => ({
      playbook: candidatos[0] ?? null,
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    }));

    await correr();

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(textosEnviados()).toEqual(["Claro, las pastillas para esa moto están en el sistema."]);
  });

  it("no repite un escenario que ya salió en las últimas 6 h: cae al modelo", async () => {
    const ubicacion = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([ubicacion]);
    matchPlaybookMock.mockResolvedValue({ playbook: ubicacion, usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
    playbookSentRecentlyMock.mockResolvedValue(true);

    await correr();

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("no repite el escenario que fue la última respuesta de la conversación (segunda red, sobre el historial)", async () => {
    const ubicacion = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([ubicacion]);
    matchPlaybookMock.mockResolvedValue({ playbook: ubicacion, usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
    // Descendente: lo más nuevo primero. La última respuesta ES el escenario.
    state.history = [
      { sender_type: "customer", content: "¿y dónde queda?", is_internal_note: false, message_type: "text", created_at: hace(12, NOW_ABIERTO), id: "m2" },
      { sender_type: "ai", content: ubicacion.responseText, is_internal_note: false, message_type: "text", created_at: hace(30, NOW_ABIERTO), id: "m1" },
    ];

    await correr();

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});

describe("runDelayTurn — el texto de espera y el horario", () => {
  it("sin texto del modelo manda TEXTO_ESPERA_DEMORA, cálido, corto y sin prometer tiempos", async () => {
    generateMock.mockResolvedValue({ text: "   ", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [{}] });

    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
    expect(textosEnviados()).toEqual([TEXTO_ESPERA_DEMORA]);
    expect(sendAgentTextMock.mock.calls[0][3]).toMatchObject({ isAutoReply: true });
    expect(TEXTO_ESPERA_DEMORA.length).toBeLessThan(160);
    expect(TEXTO_ESPERA_DEMORA).not.toMatch(/\d/);
    expect(TEXTO_ESPERA_DEMORA).not.toMatch(/minuto|hora|segundo|inmediat/i);
  });

  it("fuera de horario, el texto nombra la próxima apertura", async () => {
    vi.setSystemTime(NOW_CERRADO);
    armarChat(NOW_CERRADO);
    generateMock.mockResolvedValue({ text: "", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, steps: [{}] });

    await correr(NOW_CERRADO);

    expect(textosEnviados()).toEqual([
      "Gracias por escribirnos. La tienda está cerrada ahora; un asesor te responde por acá el miércoles a partir de las 8:00 am.",
    ]);
  });

  it("textoEsperaDemora: abierta = el texto base; cerrada sin próxima apertura = 'en cuanto vuelva a abrir'", () => {
    expect(textoEsperaDemora(undefined)).toBe(TEXTO_ESPERA_DEMORA);
    expect(textoEsperaDemora(businessStatus(NOW_ABIERTO))).toBe(TEXTO_ESPERA_DEMORA);
    expect(textoEsperaDemora({ open: false, closesAt: null, nextOpening: null })).toMatch(/en cuanto vuelva a abrir/);
  });

  it("los textos fijos de espera pasan la guarda de identidad", () => {
    for (const texto of [
      TEXTO_ESPERA_DEMORA,
      textoEsperaDemora(businessStatus(NOW_CERRADO)),
      textoEsperaDemora({ open: false, closesAt: null, nextOpening: null }),
    ]) {
      expect(revealsIdentity(texto)).toBeNull();
    }
  });

  it("si el modelo falla (redacción rota), el cliente igual recibe el texto de espera y el turno no lanza", async () => {
    generateMock.mockRejectedValue(new Error("proveedor caído"));

    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
    expect(textosEnviados()).toEqual([TEXTO_ESPERA_DEMORA]);
    expect(escalateConversationMock).not.toHaveBeenCalled();
  });

  it("si la clasificación falla, el turno sigue con la intención neutra", async () => {
    classifyIntentMock.mockRejectedValue(new Error("proveedor caído"));

    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});

describe("runDelayTurn — lo que deja escrito", () => {
  it("una nota interna 'Seba respondió por demora de N min' (N = esperaMinutos) y el log respuesta_por_demora", async () => {
    const info = vi.spyOn(log, "info");

    await correr(NOW_ABIERTO, 12);

    const notas = messageInserts.filter((m) => m.is_internal_note === true);
    expect(notas).toHaveLength(1);
    expect(notas[0]).toMatchObject({
      conversation_id: "conv-1",
      direction: "outbound",
      sender_type: "system",
      message_type: "system_event",
      is_internal_note: true,
      content: "Seba respondió por demora de 12 min",
    });
    expect(info).toHaveBeenCalledWith(
      "respuesta_por_demora",
      expect.objectContaining({ conversationId: "conv-1", esperaMinutos: 12 })
    );
  });

  it("la nota nunca la firma un asesor: no apagaría la IA", async () => {
    await correr();

    for (const fila of messageInserts) expect(fila.sender_type).not.toBe("agent");
  });

  it("si la nota no se puede escribir, el mensaje ya salió y el turno no lanza", async () => {
    state.noteInsertError = { message: "rls" };

    const resultado = await correr();

    expect(resultado.enviado).toBe(true);
  });

  it("deja su fila de bitácora en agent_turns, marcada como respuesta por demora", async () => {
    await correr(NOW_ABIERTO, 12);

    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({ conversation_id: "conv-1", action: "answered", customer_message: PREGUNTA });
    expect(String(agentTurnInserts[0].summary)).toMatch(/demora/i);
  });

  it("un turno que no envía nada no deja nota ni dice que respondió", async () => {
    state.canRun = false;
    const info = vi.spyOn(log, "info");

    await correr();

    expect(messageInserts).toEqual([]);
    expect(info).not.toHaveBeenCalledWith("respuesta_por_demora", expect.anything());
  });

  it("marca 'visto hasta' tras responder, para que el próximo turno normal no repita la respuesta", async () => {
    await correr();

    expect(redisStore.has("turno:visto:conv-1")).toBe(true);
  });

  it("un envío rechazado por Meta no cuenta como enviado y NO deja a la conversación 'sin dueño'", async () => {
    sendAgentTextMock.mockResolvedValue({
      ...OUTCOME,
      whatsapp_status: "failed",
      whatsapp_error_code: 131047,
      whatsapp_error_detail: "ventana cerrada",
      origenDelFallo: "meta",
    });
    armarChat(NOW_ABIERTO, { assigned_agent_id: "agente-1" });

    const resultado = await correr();

    expect(resultado.enviado).toBe(false);
    expect(resultado.motivo).toBe("envio_fallido");
    expect(handoffCalls).toEqual([]);
    expect(messageInserts.filter((m) => m.is_internal_note === true)).toEqual([]);
  });
});

describe("runDelayTurn — el prompt", () => {
  it("el prefijo cacheable no cambia y el sufijo trae los límites de D2 con los minutos", async () => {
    await correr(NOW_ABIERTO, 12);

    const instrucciones = agentOptions[0].instructions;
    expect(instrucciones.startsWith(cacheablePrefix())).toBe(true);
    const sufijo = instrucciones.slice(cacheablePrefix().length);
    expect(sufijo).toMatch(/MODO ESPERA/);
    expect(sufijo).toMatch(/12 min/);
    expect(sufijo).toMatch(/NO escales/);
    expect(sufijo).toMatch(/precio especial/);
    expect(sufijo).not.toMatch(/YA está asignado a un asesor/);
  });

  it("aun con asesor asignado, no le pide al modelo que use escalarAAsesor", async () => {
    armarChat(NOW_ABIERTO, { assigned_agent_id: "agente-1", ai_enabled: true });

    await correr();

    expect(agentOptions[0].instructions).not.toMatch(/usa escalarAAsesor/i);
  });
});

describe("runDelayTurn — casos que no corresponden (nunca lanzan)", () => {
  it("una conversación que no existe: conversacion_inexistente", async () => {
    state.conversation = null;

    const resultado = await correr();

    expect(resultado).toEqual({ enviado: false, motivo: "conversacion_inexistente" });
  });

  it("sin last_customer_message_at no hay a quién responder: sin_mensaje_del_cliente", async () => {
    armarChat(NOW_ABIERTO, { last_customer_message_at: null });

    const resultado = await correr();

    expect(resultado).toEqual({ enviado: false, motivo: "sin_mensaje_del_cliente" });
  });
});
