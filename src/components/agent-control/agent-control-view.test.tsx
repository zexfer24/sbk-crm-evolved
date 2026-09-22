/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentControlView } from "@/components/agent-control/agent-control-view";
import type { Agent, AgentSettings, AgentTurn, Conversation } from "@/lib/types";

/**
 * El interruptor global es el único botón del CRM que le escribe a clientes
 * reales sin revisión previa, y ya se encendió por error una vez: en el
 * minuto que tardó en notarse salieron dos respuestas automáticas a un
 * cliente de verdad. Estos tests fijan el reparto: encender pregunta primero
 * —diciendo a cuántas conversaciones activas puede escribir—, apagar no.
 */

// Los paneles vecinos no pintan nada en estos tests; lo que se prueba vive
// en el propio view (el interruptor y su diálogo).
vi.mock("@/components/agent-control/agent-roster-panel", () => ({ AgentsRosterPanel: () => null }));
vi.mock("@/components/agent-control/agent-tools-panel", () => ({ AgentToolsPanel: () => null }));
vi.mock("@/components/agent-control/knowledge-panel", () => ({ KnowledgePanel: () => null }));
vi.mock("@/components/agent-control/lessons-panel", () => ({ LessonsPanel: () => null }));
vi.mock("@/components/agent-control/playbooks-panel", () => ({ PlaybooksPanel: () => null }));
vi.mock("@/components/agent-control/spend-cap-panel", () => ({ SpendCapPanel: () => null }));
vi.mock("@/components/agent-control/business-hours-panel", () => ({ BusinessHoursPanel: () => null }));
vi.mock("@/components/agent-control/token-usage-chart", () => ({ TokenUsageChart: () => null }));
vi.mock("@/components/sliding-pills", () => ({ SlidingPills: () => null }));
vi.mock("@/components/app-rail", () => ({ AppRail: () => null, AppTopNav: () => null }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const channel = {
      on: () => channel,
      subscribe: () => channel,
    };
    return { channel: () => channel, removeChannel: () => {} };
  },
}));

const fetchBacklogCountsMock = vi.fn(async () => ({ inWindow: 117, outOfWindow: 174 }));
/**
 * T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026): el
 * describe de telemetría, más abajo, sobrescribe la resolución para probar
 * la tabla "Por fase"; el resto de los tests de este archivo se apoyan en su
 * default (`[]`).
 */
const fetchTurnCallsByPhaseMock = vi.fn(async () => [] as unknown[]);

vi.mock("@/lib/data", () => ({
  fetchAgentSettings: vi.fn(async () => ({ aiGloballyEnabled: true, dailySpendCapUsd: null, spentTodayUsd: 0 })),
  fetchBacklogCounts: () => fetchBacklogCountsMock(),
  fetchAgentSuggestions: vi.fn(async () => []),
  fetchAgentTools: vi.fn(async () => []),
  fetchAgentTurns: vi.fn(async () => []),
  fetchAgentMetrics: vi.fn(async () => []),
  fetchAllAgents: vi.fn(async () => []),
  fetchCatalogLinks: vi.fn(async () => []),
  fetchKnowledgeCategories: vi.fn(async () => []),
  fetchKnowledgeEntries: vi.fn(async () => []),
  fetchLessons: vi.fn(async () => []),
  fetchModelPricing: vi.fn(async () => []),
  fetchPlaybooks: vi.fn(async () => []),
  fetchTokenUsageSummary: vi.fn(async () => ({
    totalTokens: 0,
    totalUsd: 0,
    hasUnpricedModels: false,
    byDay: [],
    byModel: [],
    totalCachedInputTokens: 0,
    totalReasoningTokens: 0,
  })),
  fetchUnmatchedTurns: vi.fn(async () => []),
  // T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026): la
  // vista pide esto en su propio ciclo de refresco (no viaja como prop
  // `initial*` desde `page.tsx` — ver el docblock de la lectura en
  // agent-control-view.tsx). `[]` de fábrica; el describe de telemetría más
  // abajo sobrescribe la resolución para probar la tabla "Por fase".
  fetchTurnCallsByPhase: () => fetchTurnCallsByPhaseMock(),
}));

const setAiGloballyEnabledMock = vi.fn(async (...args: unknown[]) => {
  void args;
});

vi.mock("@/lib/mutations", () => ({
  createAgentSuggestion: vi.fn(async () => {}),
  createCatalogLink: vi.fn(async () => {}),
  deleteCatalogLink: vi.fn(async () => {}),
  intervene: vi.fn(async () => {}),
  markSuggestionReviewed: vi.fn(async () => {}),
  setAgentActive: vi.fn(async () => {}),
  setAgentToolEnabled: vi.fn(async () => {}),
  setAiEnabled: vi.fn(async () => {}),
  setAiGloballyEnabled: (...args: unknown[]) => setAiGloballyEnabledMock(...args),
  setCatalogLinkActive: vi.fn(async () => {}),
  setDailySpendCap: vi.fn(async () => {}),
  updateBusinessHours: vi.fn(async () => {}),
  updateCatalogLink: vi.fn(async () => {}),
  updateModelPricing: vi.fn(async () => {}),
}));

const currentAgent: Agent = {
  id: "agent-1",
  displayName: "Supervisora",
  fullName: "Supervisora de Prueba",
  avatarUrl: null,
  role: "supervisor",
  isActive: true,
};

/** Una conversación en manos de la IA: sin asesor, abierta, con la IA activa. */
function liveConversation(id: string): Conversation {
  return {
    id,
    contact: {
      id: `contact-${id}`,
      phoneNumber: "+58123456789",
      displayName: "Cliente de Prueba",
      profileName: "Cliente",
      avatarUrl: null,
      cedulaType: null,
      cedulaNumber: null,
      state: null,
      city: null,
      address: null,
      tags: [],
    },
    channel: {
      id: "channel-1",
      label: "Principal",
      phoneNumber: "+58000000000",
      phoneNumberId: "phone-id-1",
      status: "connected",
    },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: true,
    dealStatus: "none",
    dealClosedAt: null,
    dealPaymentProofUrl: null,
    dealAmount: null,
    dealCurrency: null,
    dealVerified: false,
    dealVerifiedAt: null,
    dealVerifiedBy: null,
    dealPaymentMethod: null,
    dealClosedBy: null,
    lastCustomerMessageAt: "2026-08-25T15:00:00.000Z",
    lastReplyAt: null,
    lastReplySender: null,
    hasReply: false,
    lastMessageAt: "2026-08-25T15:00:00.000Z",
    lastMessagePreview: null,
    lastMessageDirection: null,
    lastMessageStatus: null,
    createdAt: "2026-08-25T15:00:00.000Z",
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    referral: null,
  };
}

function montar(
  settings: AgentSettings,
  turns: AgentTurn[] = [],
  tokenUsageOverrides: Partial<{
    totalCachedInputTokens: number;
    totalReasoningTokens: number;
  }> = {}
) {
  render(
    <AgentControlView
      currentAgent={currentAgent}
      initialConversations={[liveConversation("conv-1"), liveConversation("conv-2")]}
      initialTurns={turns}
      initialTags={[]}
      initialSettings={settings}
      initialAgents={[currentAgent]}
      initialTokenUsage={{
        totalTokens: 0,
        totalUsd: 0,
        hasUnpricedModels: false,
        byDay: [],
        byModel: [],
        totalCachedInputTokens: 0,
        totalReasoningTokens: 0,
        ...tokenUsageOverrides,
      }}
      initialPricing={[]}
      initialSuggestions={[]}
      initialAgentMetrics={[]}
      initialPlaybooks={[]}
      initialUnmatchedTurns={[]}
      initialQuickReplies={[]}
      initialAgentTools={[]}
      initialKnowledgeCategories={[]}
      initialKnowledgeEntries={[]}
      initialLessons={[]}
      initialCatalogLinks={[]}
      modelLabel="modelo-de-prueba"
    />
  );
}

const apagada: AgentSettings = { aiGloballyEnabled: false, dailySpendCapUsd: null, spentTodayUsd: 0 };
const encendida: AgentSettings = { aiGloballyEnabled: true, dailySpendCapUsd: null, spentTodayUsd: 0 };

/** Un turno de la bitácora, tal como lo mapea `mapAgentTurn` (data.ts). */
function fakeTurn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: "turn-1",
    conversationId: "conv-1",
    contactName: "Cliente de Prueba",
    intent: "otro",
    action: "answered",
    summary: "Respondió una consulta cualquiera.",
    model: "modelo-de-prueba",
    inputTokens: 20,
    outputTokens: 8,
    totalTokens: 28,
    reasoningTokens: 0,
    // T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026):
    // `null` de fábrica, como un turno de antes de la migración
    // 20260921040000 — los tests que ejercitan estas tres columnas las pisan
    // con `overrides`.
    cachedInputTokens: null,
    steps: null,
    toolsUsed: null,
    playbookId: null,
    customerMessage: "hola",
    createdAt: "2026-09-21T15:00:00.000Z",
    ...overrides,
  };
}

const backlogFetch = vi.fn(async (url: string) =>
  url === "/api/agent/stop"
    ? { ok: true, json: async () => ({ ok: true, discarded: 12 }) }
    : { ok: true, json: async () => ({ ok: true, enqueued: 117 }) }
);

beforeEach(() => {
  setAiGloballyEnabledMock.mockClear();
  backlogFetch.mockClear();
  fetchBacklogCountsMock.mockClear();
  fetchBacklogCountsMock.mockResolvedValue({ inWindow: 117, outOfWindow: 174 });
  vi.stubGlobal("fetch", backlogFetch);
});

/** Abre el diálogo y espera a que llegue la cuenta del atraso. */
async function abrirConfirmacion() {
  fireEvent.click(screen.getByRole("button", { name: "Interruptor global de la IA" }));
  await screen.findByText(/117/);
}

describe("AgentControlView — encender la IA global pide confirmación", () => {
  /**
   * El número tiene que salir de la base y no del largo de la lista cargada:
   * son cosas distintas. La lista dice a cuántas PODRÍA escribirles cuando el
   * cliente vuelva a escribir; esto dice a cuántas les escribe ahora mismo.
   */
  it("el clic no enciende nada: abre el diálogo y consulta cuántas están esperando", async () => {
    montar(apagada);

    await abrirConfirmacion();

    expect(setAiGloballyEnabledMock).not.toHaveBeenCalled();
    expect(screen.getByText("¿Encender la IA para todo el CRM?")).toBeInTheDocument();
    expect(fetchBacklogCountsMock).toHaveBeenCalled();
    expect(screen.getByText("117")).toBeInTheDocument();
  });

  /** La prueba de que la guarda de la ventana está viva: si esto no se ve, no está filtrando. */
  it("dice cuántas quedan fuera de la ventana de 24 h y que a esas no les escribe", async () => {
    montar(apagada);

    await abrirConfirmacion();

    expect(screen.getByText("174")).toBeInTheDocument();
    expect(screen.getByText(/les escribe\. Pasado ese punto WhatsApp solo acepta una plantilla aprobada/)).toBeInTheDocument();
  });

  /** Encender a ciegas es exactamente lo que ya pasó una vez. */
  it("no deja encender mientras la cuenta no haya llegado", () => {
    let resolver: (value: { inWindow: number; outOfWindow: number }) => void = () => {};
    fetchBacklogCountsMock.mockReturnValue(new Promise((resolve) => { resolver = resolve; }));
    montar(apagada);

    fireEvent.click(screen.getByRole("button", { name: "Interruptor global de la IA" }));

    expect(screen.getByRole("button", { name: /Encender la IA/ })).toBeDisabled();
    resolver({ inWindow: 0, outOfWindow: 0 });
  });

  it("confirmar enciende y dispara el repaso del atraso", async () => {
    montar(apagada);

    await abrirConfirmacion();
    fireEvent.click(screen.getByRole("button", { name: /Encender la IA/ }));

    expect(setAiGloballyEnabledMock).toHaveBeenCalledWith(expect.anything(), currentAgent, true);
    await waitFor(() => expect(backlogFetch).toHaveBeenCalledWith("/api/agent/backlog", { method: "POST" }));
  });

  it("cancelar deja todo como estaba y no repasa nada", async () => {
    montar(apagada);

    await abrirConfirmacion();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(setAiGloballyEnabledMock).not.toHaveBeenCalled();
    expect(backlogFetch).not.toHaveBeenCalled();
  });

  /**
   * 19/9/2026, plan "El precio se lee en bolívares" (T2): el texto viejo
   * ("sin asesor asignado") es falso desde D2 de "Seba atiende el mostrador"
   * (18/9/2026) — la escalada ya no apaga a Seba, sigue respondiendo con un
   * asesor asignado hasta que ESE asesor le escribe de verdad al cliente.
   */
  it("con la IA encendida, el texto dice hasta cuándo responde Seba, no que necesite un chat sin asesor", () => {
    montar(encendida);

    expect(
      screen.getByText("Responde en toda conversación hasta que un asesor le escribe al cliente.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Responde en cualquier conversación sin asesor asignado.")).not.toBeInTheDocument();
  });

  /**
   * Apagar tiene que parar TODO, no sólo escribir el interruptor.
   *
   * Escribiéndolo a secas quedaban vivas la cola llena y los turnos en vuelo,
   * y el dueño veía salir mensajes después de haber apagado. La ruta hace las
   * dos cosas en una sola operación; el componente no puede purgar Redis por
   * su cuenta.
   */
  it("apagar NO pregunta y para también lo que estaba en cola", async () => {
    montar(encendida);

    fireEvent.click(screen.getByRole("button", { name: "Interruptor global de la IA" }));

    await waitFor(() => expect(backlogFetch).toHaveBeenCalledWith("/api/agent/stop", { method: "POST" }));
    expect(screen.queryByText("¿Encender la IA para todo el CRM?")).not.toBeInTheDocument();
    // El interruptor no se escribe por separado: iría por detrás de la purga.
    expect(setAiGloballyEnabledMock).not.toHaveBeenCalled();
    expect(backlogFetch).not.toHaveBeenCalledWith("/api/agent/backlog", { method: "POST" });
  });
});

/**
 * T4b, plan "La escalada se hace una vez y la búsqueda responde" (21/9/2026).
 *
 * Motivo: dos turnos reales del 21/9/2026 gastaron ~65.800 tokens de SALIDA
 * contra un mensaje visible al cliente de ~40 — razonamiento interno del
 * modelo sin ningún dato que lo separara de la redacción. El feed "Actividad
 * en vivo" es la lectura directa de `agent_turns` (no la RPC agregada
 * `agent_token_usage`, que no trae esta columna): acá es donde el supervisor
 * puede ver, turno por turno, cuál se fue de rango.
 */
describe("AgentControlView — tokens de razonamiento en el feed (T4b, 21/9/2026)", () => {
  it("muestra el contador de razonamiento cuando el turno lo tuvo", () => {
    montar(encendida, [fakeTurn({ reasoningTokens: 900 })]);

    expect(screen.getByText("Razonamiento: 900")).toBeInTheDocument();
  });

  it("no muestra nada de razonamiento cuando el turno no razonó (0 es el valor normal, no una anomalía)", () => {
    montar(encendida, [fakeTurn({ reasoningTokens: 0 })]);

    expect(screen.queryByText(/Razonamiento/)).not.toBeInTheDocument();
  });
});

/**
 * T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026): la
 * telemetría por llamada que se agrega a "Consumo de tokens" y al feed en
 * vivo — dos totales nuevos, un badge de caché y la línea de pasos/herramientas.
 */
describe("AgentControlView — telemetría por llamada (T4, 21-22/9/2026)", () => {
  it("pinta los dos totales nuevos de 'Consumo de tokens' (caché y razonamiento)", () => {
    montar(encendida, [], { totalCachedInputTokens: 12345, totalReasoningTokens: 678 });

    expect(screen.getByText("12.345")).toBeInTheDocument();
    expect(screen.getByText("tokens de caché")).toBeInTheDocument();
    expect(screen.getByText("678")).toBeInTheDocument();
    expect(screen.getByText("tokens de razonamiento")).toBeInTheDocument();
  });

  it("muestra el badge de caché en el feed cuando el turno cacheó, y lo omite en 0 o null", () => {
    montar(encendida, [
      fakeTurn({ id: "turn-cache", cachedInputTokens: 1600 }),
      fakeTurn({ id: "turn-sin-cache", conversationId: "conv-2", cachedInputTokens: 0 }),
      fakeTurn({ id: "turn-viejo", conversationId: "conv-3", cachedInputTokens: null }),
    ]);

    expect(screen.getByText("Caché: 1.600")).toBeInTheDocument();
    // Solo UN badge de caché: los otros dos turnos (0 y null) no lo pintan.
    expect(screen.getAllByText(/^Caché:/)).toHaveLength(1);
  });

  it("muestra 'N pasos · herramientas' cuando el turno midió pasos, incluida la lista en blanco", () => {
    montar(encendida, [
      fakeTurn({ id: "turn-con-herramientas", steps: 3, toolsUsed: "buscarRepuesto,escalarAAsesor" }),
      fakeTurn({ id: "turn-sin-herramientas", conversationId: "conv-2", steps: 1, toolsUsed: "" }),
    ]);

    expect(screen.getByText("3 pasos · buscarRepuesto,escalarAAsesor")).toBeInTheDocument();
    expect(screen.getByText("1 pasos · (ninguna)")).toBeInTheDocument();
  });

  it("no muestra la línea de pasos en un turno de antes de la migración (steps: null)", () => {
    montar(encendida, [fakeTurn({ steps: null, toolsUsed: null })]);

    expect(screen.queryByText(/pasos ·/)).not.toBeInTheDocument();
  });

  it("pinta la tabla 'Por fase' con las filas que trae fetchTurnCallsByPhase", async () => {
    fetchTurnCallsByPhaseMock.mockResolvedValueOnce([
      {
        phase: "redactar",
        calls: 40,
        inputTokens: 12000,
        outputTokens: 3000,
        cachedInputTokens: 5000,
        reasoningTokens: 900,
        maxOutputTokensMax: 1500,
        toolChoiceNoneCalls: 6,
      },
    ]);

    montar(encendida);

    expect(await screen.findByText("Redactar")).toBeInTheDocument();
    expect(screen.getByText("40 llamadas")).toBeInTheDocument();
    expect(screen.getByText("6 sin herramientas")).toBeInTheDocument();
  });

  it("sin ninguna fila (la migración todavía no corrió, o no hay llamadas), pinta el vacío en vez de nada", () => {
    montar(encendida);

    expect(screen.getByText("Todavía no hay llamadas medidas por fase.")).toBeInTheDocument();
  });
});
