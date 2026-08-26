import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentControlView } from "@/components/agent-control/agent-control-view";
import type { Agent, AgentSettings, Conversation } from "@/lib/types";

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
vi.mock("@/components/agent-control/playbooks-panel", () => ({ PlaybooksPanel: () => null }));
vi.mock("@/components/agent-control/spend-cap-panel", () => ({ SpendCapPanel: () => null }));
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

vi.mock("@/lib/data", () => ({
  fetchAgentSettings: vi.fn(async () => ({ aiGloballyEnabled: true, dailySpendCapUsd: null, spentTodayUsd: 0 })),
  fetchBacklogCounts: () => fetchBacklogCountsMock(),
  fetchAgentSuggestions: vi.fn(async () => []),
  fetchAgentTools: vi.fn(async () => []),
  fetchAgentTurns: vi.fn(async () => []),
  fetchAgentMetrics: vi.fn(async () => []),
  fetchAllAgents: vi.fn(async () => []),
  fetchKnowledgeCategories: vi.fn(async () => []),
  fetchKnowledgeEntries: vi.fn(async () => []),
  fetchModelPricing: vi.fn(async () => []),
  fetchPlaybooks: vi.fn(async () => []),
  fetchTokenUsageSummary: vi.fn(async () => ({ totalTokens: 0, totalUsd: 0, hasUnpricedModels: false, byDay: [], byModel: [] })),
  fetchUnmatchedTurns: vi.fn(async () => []),
}));

const setAiGloballyEnabledMock = vi.fn(async (...args: unknown[]) => {
  void args;
});

vi.mock("@/lib/mutations", () => ({
  createAgentSuggestion: vi.fn(async () => {}),
  intervene: vi.fn(async () => {}),
  markSuggestionReviewed: vi.fn(async () => {}),
  setAgentActive: vi.fn(async () => {}),
  setAgentToolEnabled: vi.fn(async () => {}),
  setAiEnabled: vi.fn(async () => {}),
  setAiGloballyEnabled: (...args: unknown[]) => setAiGloballyEnabledMock(...args),
  setDailySpendCap: vi.fn(async () => {}),
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
    lastMessageAt: "2026-08-25T15:00:00.000Z",
    lastMessagePreview: null,
    lastMessageDirection: null,
    lastMessageStatus: null,
    createdAt: "2026-08-25T15:00:00.000Z",
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
  };
}

function montar(settings: AgentSettings) {
  render(
    <AgentControlView
      currentAgent={currentAgent}
      initialConversations={[liveConversation("conv-1"), liveConversation("conv-2")]}
      initialTurns={[]}
      initialTags={[]}
      initialSettings={settings}
      initialAgents={[currentAgent]}
      initialTokenUsage={{ totalTokens: 0, totalUsd: 0, hasUnpricedModels: false, byDay: [], byModel: [] }}
      initialPricing={[]}
      initialSuggestions={[]}
      initialAgentMetrics={[]}
      initialPlaybooks={[]}
      initialUnmatchedTurns={[]}
      initialQuickReplies={[]}
      initialAgentTools={[]}
      initialKnowledgeCategories={[]}
      initialKnowledgeEntries={[]}
      modelLabel="modelo-de-prueba"
    />
  );
}

const apagada: AgentSettings = { aiGloballyEnabled: false, dailySpendCapUsd: null, spentTodayUsd: 0 };
const encendida: AgentSettings = { aiGloballyEnabled: true, dailySpendCapUsd: null, spentTodayUsd: 0 };

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
