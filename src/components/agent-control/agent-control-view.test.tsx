/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ComponentProps } from "react";
import { AgentControlView } from "@/components/agent-control/agent-control-view";
import { ConfigWriteDeniedError } from "@/lib/config-write";
import type { Area, SebaV2Config } from "@/lib/seba-v2-config";
import type { Agent, AgentSettings, AgentTurn, Conversation, ModelUsageSummary } from "@/lib/types";

/**
 * El interruptor global es el único botón del CRM que le escribe a clientes
 * reales sin revisión previa, y ya se encendió por error una vez: en el
 * minuto que tardó en notarse salieron dos respuestas automáticas a un
 * cliente de verdad. Estos tests fijan el reparto: encender pregunta primero
 * —diciendo a cuántas conversaciones activas puede escribir—, apagar no.
 */

// Los paneles vecinos no pintan nada en estos tests; lo que se prueba vive
// en el propio view (el interruptor y su diálogo).
// Entrega 2 de Seba v2 (16/11/2026): el roster y los tres paneles nuevos son
// stubs que EXPONEN sus props (como `pills`), para probar el cableado de la
// vista sin pintar los paneles, que tienen sus propios tests.
const stubs = vi.hoisted(() => ({
  roster: null as null | {
    areasByAgent: Record<string, string[]> | null;
    savingAreasAgentIds: ReadonlySet<string>;
    onToggleArea: (agent: { id: string; displayName: string }, area: string, on: boolean) => void;
  },
  seba: null as null | {
    config: { modo: string; shadowDailyCapUsd: number; shadowSamplePct: number } | null;
    canEdit: boolean;
    onModeChange: (modo: string) => Promise<void>;
    onSaveLimits: (limits: { capUsd: number; samplePct: number }) => Promise<void>;
  },
  welcome: null as null | {
    config: { welcomeText: string; welcomeFollowups: string[] } | null;
    canEdit: boolean;
    onSave: (draft: { welcomeText: string; followups: string[] }) => Promise<void>;
  },
  pagos: null as null | {
    methods: unknown[];
    cashea: { datosText: string; minimoUsd: number; seisCuotasDesdeUsd: number } | null;
    canEdit: boolean;
    onCreate: (draft: unknown, sortOrder: number) => Promise<void>;
    onUpdate: (key: string, draft: unknown) => Promise<void>;
    onDelete: (key: string) => Promise<void>;
    onToggleActive: (key: string, isActive: boolean) => Promise<void>;
    onSaveCashea: (settings: { datosText: string; minimoUsd: number; seisCuotasDesdeUsd: number }) => Promise<void>;
  },
}));
vi.mock("@/components/agent-control/agent-roster-panel", () => ({
  AgentsRosterPanel: (props: NonNullable<typeof stubs.roster>) => {
    stubs.roster = props;
    return null;
  },
}));
vi.mock("@/components/agent-control/seba-v2-panel", () => ({
  SebaV2Panel: (props: NonNullable<typeof stubs.seba>) => {
    stubs.seba = props;
    return <div data-testid="panel-seba-v2" />;
  },
}));
vi.mock("@/components/agent-control/welcome-panel", () => ({
  WelcomePanel: (props: NonNullable<typeof stubs.welcome>) => {
    stubs.welcome = props;
    return <div data-testid="panel-bienvenida" />;
  },
}));
vi.mock("@/components/agent-control/payment-methods-panel", () => ({
  PaymentMethodsPanel: (props: NonNullable<typeof stubs.pagos>) => {
    stubs.pagos = props;
    return <div data-testid="panel-pagos" />;
  },
}));
// `toast` real pinta en un Toast.Provider que estos tests no montan: se espía.
const toastDangerMock = vi.hoisted(() => vi.fn());
vi.mock("@heroui/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...original,
    toast: Object.assign(vi.fn(), { danger: toastDangerMock, info: vi.fn(), warning: vi.fn(), success: vi.fn() }),
  };
});
vi.mock("@/components/agent-control/agent-tools-panel", () => ({ AgentToolsPanel: () => null }));
vi.mock("@/components/agent-control/knowledge-panel", () => ({ KnowledgePanel: () => null }));
vi.mock("@/components/agent-control/lessons-panel", () => ({ LessonsPanel: () => null }));
vi.mock("@/components/agent-control/playbooks-panel", () => ({ PlaybooksPanel: () => null }));
vi.mock("@/components/agent-control/spend-cap-panel", () => ({ SpendCapPanel: () => null }));
vi.mock("@/components/agent-control/business-hours-panel", () => ({ BusinessHoursPanel: () => null }));
vi.mock("@/components/agent-control/token-usage-chart", () => ({ TokenUsageChart: () => null }));
// T9 de A2 (30/9/2026): SlidingPills captura sus props para poder probar la
// pestaña «Búsquedas» (su contador y que al elegirla se pinta el panel).
const pills = vi.hoisted(() => ({
  items: [] as { value: string; label: string; count?: number }[],
  onChange: (() => {}) as (value: string) => void,
}));
vi.mock("@/components/sliding-pills", () => ({
  SlidingPills: (props: { items: { value: string; label: string; count?: number }[]; onChange: (value: string) => void }) => {
    pills.items = props.items;
    pills.onChange = props.onChange;
    return null;
  },
}));
// El panel de Búsquedas tiene su propio test; acá solo interesa que la vista lo monte y le suba el refreshToken.
vi.mock("@/components/agent-control/catalog-searches-panel", () => ({
  CatalogSearchesPanel: (props: { refreshToken: number }) => <div data-testid="panel-busquedas" data-token={props.refreshToken} />,
}));
// Entrega 3 de Seba v2 (17/11/2026): el panel «Sombra» tiene su propio test; acá solo interesa
// quién ve la pestaña y qué le pasa la vista.
vi.mock("@/components/agent-control/shadow-panel", () => ({
  ShadowPanel: (props: { dailyCapUsd: number | null; currentAgent: { id: string } }) => (
    <div data-testid="panel-sombra" data-tope={String(props.dailyCapUsd)} data-agente={props.currentAgent.id} />
  ),
}));
vi.mock("@/components/app-rail", () => ({ AppRail: () => null, AppTopNav: () => null }));
// T6, "Ronda del cliente" (30/9/2026): el panel «Equipo» tiene su propio
// test; acá solo interesa que la vista lo monte para un admin y le pase los agentes.
vi.mock("@/components/agent-control/team-panel", () => ({
  TeamPanel: (props: { agents: { displayName: string }[]; onAgentRenamed: (id: string, name: string) => void }) => (
    <div data-testid="panel-equipo">
      {props.agents.map((a) => a.displayName).join(",")}
      <button type="button" onClick={() => props.onAgentRenamed("agent-1", "Supervisora Renombrada")}>
        renombrar
      </button>
    </div>
  ),
}));

// T9 de A2: se guardan los handlers de `postgres_changes` por tabla para poder
// emitir un INSERT de `agent_turns` como lo haría Realtime.
const realtime = vi.hoisted(() => ({ handlers: {} as Record<string, () => void> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const channel = {
      on: (_type: string, filter: { table?: string }, cb: () => void) => {
        if (filter.table) realtime.handlers[filter.table] = cb;
        return channel;
      },
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
/** T9 de A2: el contador de «Búsquedas de hoy» de la pestaña. */
const fetchSearchSummaryMock = vi.fn(async (supabase: unknown, desde: string) => {
  void supabase;
  void desde;
  return { busquedas: 7 } as { busquedas: number } | null;
});

const fetchPaymentMethodsMock = vi.fn(async () => [] as unknown[]);
const fetchSebaV2ConfigMock = vi.fn(async () => null as unknown);
const fetchAgentAreasMock = vi.fn(async () => null as unknown);

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
  fetchSearchSummary: (supabase: unknown, desde: string) => fetchSearchSummaryMock(supabase, desde),
  // Entrega 2 de Seba v2 (16/11/2026).
  fetchPaymentMethods: () => fetchPaymentMethodsMock(),
  fetchSebaV2Config: () => fetchSebaV2ConfigMock(),
  fetchAgentAreas: () => fetchAgentAreasMock(),
}));

const setAiGloballyEnabledMock = vi.fn(async (...args: unknown[]) => {
  void args;
});
const setDemoraActivaMock = vi.fn(async (...args: unknown[]) => {
  void args;
  return null as string | null;
});

const setSebaV2ModeMock = vi.fn(async (...args: unknown[]) => {
  void args;
});
const createPaymentMethodMock = vi.fn(async (...args: unknown[]) => {
  void args;
});
const setAgentAreasMock = vi.fn(async (...args: unknown[]) => {
  void args;
});

vi.mock("@/lib/mutations", () => ({
  setSebaV2Mode: (...args: unknown[]) => setSebaV2ModeMock(...args),
  createPaymentMethod: (...args: unknown[]) => createPaymentMethodMock(...args),
  setAgentAreas: (...args: unknown[]) => setAgentAreasMock(...args),
  updateShadowLimits: vi.fn(async () => {}),
  updateWelcomeTexts: vi.fn(async () => {}),
  updateCasheaSettings: vi.fn(async () => {}),
  updatePaymentMethod: vi.fn(async () => {}),
  setPaymentMethodActive: vi.fn(async () => {}),
  deletePaymentMethod: vi.fn(async () => {}),
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
  setDemoraActiva: (...args: unknown[]) => setDemoraActivaMock(...args),
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

const TODAS_LAS_AREAS: Area[] = ["pagos", "ventas", "envios", "reclamos"];
const SEBA_V2_CONFIG: SebaV2Config = {
  modo: "apagado",
  shadowDailyCapUsd: 2,
  shadowSamplePct: 100,
  welcomeText: "Hola, soy Seba.",
  welcomeFollowups: ["¿Qué buscas?", "¿Para qué moto?"],
  casheaDatosText: "Datos de Cashea",
  casheaMinimoUsd: 25,
  casheaSeisCuotasDesdeUsd: 200,
};

function montar(
  settings: AgentSettings,
  turns: AgentTurn[] = [],
  tokenUsageOverrides: Partial<{
    totalCachedInputTokens: number;
    totalReasoningTokens: number;
    byModel: ModelUsageSummary[];
  }> = {},
  /** T7 (28/9/2026): el rol de quien mira; por defecto, la supervisora de siempre. */
  agent: Agent = currentAgent,
  /** Props nuevas de la Entrega 2 de Seba v2; los defaults son una base ya migrada. */
  extras: Partial<ComponentProps<typeof AgentControlView>> = {}
) {
  render(
    <AgentControlView
      currentAgent={agent}
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
      initialPaymentMethods={[]}
      initialSebaV2Config={SEBA_V2_CONFIG}
      initialAgentAreas={{ [currentAgent.id]: [...TODAS_LAS_AREAS] }}
      modelLabel="modelo-de-prueba"
      {...extras}
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
  setDemoraActivaMock.mockClear();
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
 * Cierre de A2 (30/9/2026): a 390 px la tira de pestañas ensanchaba la página
 * entera (scrollWidth 989). La tira va dentro de un carril que scrollea
 * (`.ac-tabs-scroll`); la regla de CSS la fija `agent-control-css.test.ts`, acá
 * solo que la vista lo monte.
 */
describe("AgentControlView — la tira de pestañas va en un carril que scrollea", () => {
  it("la vista monta el carril `.ac-tabs-scroll` (SlidingPills va simulado en este archivo, así que no se ve su tablist)", () => {
    montar(encendida, []);

    expect(document.querySelector(".ac-tabs-scroll")).not.toBeNull();
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

/**
 * T7, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
 * esperando" (28/9/2026). El interruptor global y las tarifas por modelo no
 * tenían puerta de rol: un asesor corriente los veía activos, pulsaba, la
 * base ignoraba el UPDATE sin error (RLS `agent_settings_update` /
 * `model_pricing_*`) y la pantalla mostraba el cambio como hecho.
 */
describe("AgentControlView — puertas de rol de la configuración (T7)", () => {
  const asesor: Agent = { ...currentAgent, id: "agent-9", displayName: "Asesor", role: "agent" };
  const modelo: ModelUsageSummary = { model: "openai/gpt-x", totalTokens: 100, inputTokens: 60, outputTokens: 40, usdCost: 1 };

  it("un asesor corriente ve el interruptor global deshabilitado y el motivo", () => {
    montar(encendida, [], {}, asesor);

    expect(screen.getByRole("button", { name: "Interruptor global de la IA" })).toBeDisabled();
    expect(screen.getByText(/Solo un supervisor o admin puede cambiarlo/)).toBeInTheDocument();
  });

  it("un supervisor lo ve habilitado", () => {
    montar(encendida);

    expect(screen.getByRole("button", { name: "Interruptor global de la IA" })).toBeEnabled();
  });

  it("un asesor corriente no ve inputs ni botón para las tarifas, sí el aviso", () => {
    montar(encendida, [], { byModel: [modelo] }, asesor);

    expect(screen.getByText("openai/gpt-x")).toBeInTheDocument();
    expect(screen.queryByLabelText(/\$\/1M input/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar" })).not.toBeInTheDocument();
    expect(screen.getByText(/Solo un supervisor o admin puede cambiar las tarifas/)).toBeInTheDocument();
  });

  it("un supervisor sí ve los inputs y el botón de tarifas", () => {
    montar(encendida, [], { byModel: [modelo] });

    expect(screen.getByLabelText(/\$\/1M input/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guardar" })).toBeInTheDocument();
  });
});

/**
 * T10b-5, plan "Seba encuentra…" (29/9/2026): el interruptor "Reasignar si el
 * asesor tarda" vive en Control IA con la misma puerta de rol de T7 —el
 * cron de demora le escribe a clientes reales y le quita casos a asesores—.
 */
describe("AgentControlView — interruptor de la demora del asesor (T10b-5)", () => {
  const asesor: Agent = { ...currentAgent, id: "agent-9", displayName: "Asesor", role: "agent" };

  it("un asesor corriente lo ve deshabilitado", () => {
    montar(encendida, [], {}, asesor);

    expect(screen.getByRole("switch", { name: "Reasignar si el asesor tarda" })).toBeDisabled();
  });

  it("un supervisor lo enciende: llama a setDemoraActiva(supabase, agente, true) y queda encendido", async () => {
    setDemoraActivaMock.mockResolvedValueOnce("2026-09-29T15:30:00.000Z");
    montar(encendida);

    fireEvent.click(screen.getByRole("switch", { name: "Reasignar si el asesor tarda" }));

    expect(setDemoraActivaMock).toHaveBeenCalledWith(expect.anything(), currentAgent, true);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Reasignar si el asesor tarda" })).toHaveAttribute("aria-checked", "true")
    );
    expect(screen.getByText(/Encendida desde/)).toBeInTheDocument();
  });
});

describe("AgentControlView — pestaña «Búsquedas» (T9 de A2, 30/9/2026)", () => {
  beforeEach(() => {
    fetchSearchSummaryMock.mockClear();
    fetchSearchSummaryMock.mockResolvedValue({ busquedas: 7 });
    pills.items = [];
  });

  it("la pestaña va al lado de «Lecciones» y su contador es el de las búsquedas de HOY", async () => {
    montar(encendida);

    await waitFor(() => expect(pills.items.find((item) => item.value === "busquedas")?.count).toBe(7));

    const values = pills.items.map((item) => item.value);
    expect(values.indexOf("busquedas")).toBe(values.indexOf("lecciones") + 1);
    expect(pills.items.find((item) => item.value === "busquedas")?.label).toBe("Búsquedas");
    // El contador pide «hoy»: una fecha ISO de la medianoche de Caracas, no un período largo.
    const desde = fetchSearchSummaryMock.mock.calls[0][1] as string;
    expect(Date.now() - new Date(desde).getTime()).toBeLessThan(24 * 60 * 60 * 1000 + 1000);
  });

  it("si el resumen falla (p. ej. migración sin aplicar) la pestaña queda sin contador, no rota", async () => {
    fetchSearchSummaryMock.mockRejectedValue({ code: "PGRST202" });
    montar(encendida);

    await waitFor(() => expect(fetchSearchSummaryMock).toHaveBeenCalled());
    const item = pills.items.find((entry) => entry.value === "busquedas");
    expect(item).toBeDefined();
    expect(item?.count).toBeUndefined();
  });

  it("al elegir la pestaña se monta el panel, y un INSERT de agent_turns por Realtime le sube el refreshToken", async () => {
    montar(encendida);
    await waitFor(() => expect(pills.items.some((item) => item.value === "busquedas")).toBe(true));
    expect(screen.queryByTestId("panel-busquedas")).not.toBeInTheDocument();

    act(() => pills.onChange("busquedas"));
    const panel = await screen.findByTestId("panel-busquedas");
    const antes = Number(panel.getAttribute("data-token"));

    realtime.handlers["agent_turns"]();

    await vi.waitFor(() => expect(Number(screen.getByTestId("panel-busquedas").getAttribute("data-token"))).toBeGreaterThan(antes), {
      timeout: 5000,
    });
    // Y el contador de hoy se vuelve a pedir en el mismo refresco.
    expect(fetchSearchSummaryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("AgentControlView — pestaña «Equipo» (T6, Ronda del cliente, 30/9/2026)", () => {
  beforeEach(() => {
    pills.items = [];
  });

  it("no existe para un supervisor", async () => {
    montar(encendida);
    await waitFor(() => expect(pills.items.length).toBeGreaterThan(0));
    expect(pills.items.some((item) => item.value === "equipo")).toBe(false);
    expect(screen.queryByTestId("panel-equipo")).not.toBeInTheDocument();
  });

  it("existe para un admin, al final de la tira, y monta el panel con los agentes", async () => {
    montar(encendida, [], {}, { ...currentAgent, role: "admin" });
    await waitFor(() => expect(pills.items.some((item) => item.value === "equipo")).toBe(true));
    expect(pills.items.at(-1)?.value).toBe("equipo");
    expect(pills.items.find((item) => item.value === "equipo")?.label).toBe("Equipo");

    act(() => pills.onChange("equipo"));
    const panel = await screen.findByTestId("panel-equipo");
    expect(panel).toHaveTextContent("Supervisora");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Equipo");
  });

  it("al renombrar a alguien, la vista refleja el nombre nuevo sin recargar", async () => {
    montar(encendida, [], {}, { ...currentAgent, role: "admin" });
    await waitFor(() => expect(pills.items.some((item) => item.value === "equipo")).toBe(true));
    act(() => pills.onChange("equipo"));
    const panel = await screen.findByTestId("panel-equipo");

    fireEvent.click(screen.getByRole("button", { name: "renombrar" }));
    await waitFor(() => expect(panel).toHaveTextContent("Supervisora Renombrada"));
  });
});

/**
 * Entrega 2 de Seba v2 (16/11/2026): pestaña «Seba v2» y áreas por asesor.
 * Los callbacks que la vista le pasa a los paneles tienen que LANZAR si la
 * escritura falla: los paneles atrapan el error y muestran el toast, y un
 * callback que se lo traga haría creer que se guardó.
 */
describe("AgentControlView — pestaña «Seba v2» (Entrega 2, 16/11/2026)", () => {
  beforeEach(() => {
    pills.items = [];
    stubs.roster = null;
    stubs.seba = null;
    stubs.welcome = null;
    stubs.pagos = null;
    setSebaV2ModeMock.mockReset();
    setSebaV2ModeMock.mockResolvedValue(undefined);
    createPaymentMethodMock.mockReset();
    createPaymentMethodMock.mockResolvedValue(undefined);
    setAgentAreasMock.mockReset();
    setAgentAreasMock.mockResolvedValue(undefined);
    fetchPaymentMethodsMock.mockClear();
    toastDangerMock.mockClear();
  });

  async function abrirSeba(agent: Agent = currentAgent, extras: Partial<ComponentProps<typeof AgentControlView>> = {}) {
    montar(encendida, [], {}, agent, extras);
    await waitFor(() => expect(pills.items.length).toBeGreaterThan(0));
    act(() => pills.onChange("seba"));
    await screen.findByTestId("panel-seba-v2");
  }

  it.each(["agent", "supervisor", "admin"] as const)(
    "la pestaña existe para el rol %s y es la segunda, justo después de «Control de IA»",
    async (role) => {
      montar(encendida, [], {}, { ...currentAgent, role });
      await waitFor(() => expect(pills.items.length).toBeGreaterThan(0));

      expect(pills.items[0].value).toBe("ia");
      expect(pills.items[1].value).toBe("seba");
      expect(pills.items[1].label).toBe("Seba v2");
      expect(pills.items[1].count).toBeUndefined();
    }
  );

  it("al abrirla monta los tres paneles en orden, con canEdit true para un supervisor", async () => {
    await abrirSeba();

    const [seba, bienvenida, pagos] = ["panel-seba-v2", "panel-bienvenida", "panel-pagos"].map((id) =>
      screen.getByTestId(id)
    );
    expect(seba.compareDocumentPosition(bienvenida) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bienvenida.compareDocumentPosition(pagos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stubs.seba?.canEdit).toBe(true);
    expect(stubs.welcome?.canEdit).toBe(true);
    expect(stubs.pagos?.canEdit).toBe(true);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Seba v2");
  });

  it("para un asesor los tres paneles reciben canEdit false", async () => {
    await abrirSeba({ ...currentAgent, role: "agent" });

    expect(stubs.seba?.canEdit).toBe(false);
    expect(stubs.welcome?.canEdit).toBe(false);
    expect(stubs.pagos?.canEdit).toBe(false);
  });

  it("cambiar el modo llama setSebaV2Mode con el asesor actual y el panel recibe el modo nuevo", async () => {
    await abrirSeba();
    expect(stubs.seba?.config?.modo).toBe("apagado");

    await act(async () => {
      await stubs.seba?.onModeChange("sombra");
    });

    expect(setSebaV2ModeMock).toHaveBeenCalledWith(expect.anything(), currentAgent, "sombra");
    expect(stubs.seba?.config?.modo).toBe("sombra");
  });

  it("si setSebaV2Mode rechaza, el callback RECHAZA (no se traga el error) y el modo no cambia", async () => {
    setSebaV2ModeMock.mockRejectedValue(new ConfigWriteDeniedError("Solo un supervisor o administrador puede cambiar esto."));
    await abrirSeba();

    let error: unknown = null;
    await act(async () => {
      await stubs.seba?.onModeChange("sombra").catch((e: unknown) => {
        error = e;
      });
    });

    expect(error).toBeInstanceOf(ConfigWriteDeniedError);
    expect(stubs.seba?.config?.modo).toBe("apagado");
  });

  it("crear una forma de pago llama createPaymentMethod y después vuelve a pedir la lista", async () => {
    await abrirSeba();
    fetchPaymentMethodsMock.mockClear();
    const nueva = [{ key: "zelle", label: "Zelle" }];
    fetchPaymentMethodsMock.mockResolvedValueOnce(nueva);
    const draft = { key: "zelle", label: "Zelle" };

    await act(async () => {
      await stubs.pagos?.onCreate(draft, 3);
    });

    expect(createPaymentMethodMock).toHaveBeenCalledWith(expect.anything(), currentAgent, draft, 3);
    expect(fetchPaymentMethodsMock).toHaveBeenCalledTimes(1);
    expect(stubs.pagos?.methods).toEqual(nueva);
  });

  it("si createPaymentMethod rechaza, el callback rechaza y NO se vuelve a pedir la lista", async () => {
    createPaymentMethodMock.mockRejectedValue(new Error("rls"));
    await abrirSeba();
    fetchPaymentMethodsMock.mockClear();

    let error: unknown = null;
    await act(async () => {
      await stubs.pagos?.onCreate({ key: "x" }, 1).catch((e: unknown) => {
        error = e;
      });
    });

    expect(error).toBeInstanceOf(Error);
    expect(fetchPaymentMethodsMock).not.toHaveBeenCalled();
  });

  it("sin la migración (initialSebaV2Config null) los paneles reciben config y cashea en null", async () => {
    await abrirSeba(currentAgent, { initialSebaV2Config: null });

    expect(stubs.seba?.config).toBeNull();
    expect(stubs.welcome?.config).toBeNull();
    expect(stubs.pagos?.cashea).toBeNull();
  });

  it("con la configuración cargada, cashea sale de los tres campos de Cashea", async () => {
    await abrirSeba();

    expect(stubs.pagos?.cashea).toEqual({ datosText: "Datos de Cashea", minimoUsd: 25, seisCuotasDesdeUsd: 200 });
  });

  it("un refresco que falla en alguna de las tres lecturas deja el estado anterior, no lo vacía", async () => {
    await abrirSeba();
    fetchSebaV2ConfigMock.mockRejectedValueOnce(new Error("timeout"));
    fetchPaymentMethodsMock.mockResolvedValueOnce([{ key: "zelle" }]);

    realtime.handlers["agent_settings"]();

    // La lectura de formas de pago que sí resolvió se aplica; la de la configuración, que falló, no borra la anterior.
    await vi.waitFor(() => expect(stubs.pagos?.methods).toEqual([{ key: "zelle" }]), { timeout: 5000 });
    expect(stubs.seba?.config?.modo).toBe("apagado");
  });

  it("un re-render de la vista que no cambia la configuración conserva la IDENTIDAD de cashea (R1/C8, 16/11/2026)", async () => {
    await abrirSeba();
    const antes = stubs.pagos?.cashea;
    expect(antes).not.toBeNull();

    // La lectura de la configuración falla (queda el estado anterior) pero la
    // de formas de pago sí resuelve: la vista se vuelve a pintar sin tocar sebaV2Config.
    fetchSebaV2ConfigMock.mockRejectedValueOnce(new Error("timeout"));
    fetchPaymentMethodsMock.mockResolvedValueOnce([{ key: "zelle" }]);
    realtime.handlers["agent_settings"]();
    await vi.waitFor(() => expect(stubs.pagos?.methods).toEqual([{ key: "zelle" }]), { timeout: 5000 });

    expect(stubs.pagos?.cashea).toBe(antes);
  });
});

describe("AgentControlView — áreas por asesor (Entrega 2, 16/11/2026)", () => {
  beforeEach(() => {
    pills.items = [];
    stubs.roster = null;
    setAgentAreasMock.mockReset();
    setAgentAreasMock.mockResolvedValue(undefined);
    toastDangerMock.mockClear();
  });

  async function abrirAgentes(extras: Partial<ComponentProps<typeof AgentControlView>> = {}) {
    montar(encendida, [], {}, currentAgent, extras);
    await waitFor(() => expect(pills.items.length).toBeGreaterThan(0));
    act(() => pills.onChange("agentes"));
    await waitFor(() => expect(stubs.roster).not.toBeNull());
  }

  it("desmarcar «Pagos» guarda las tres áreas que quedan, en el orden de siempre", async () => {
    await abrirAgentes();

    await act(async () => {
      stubs.roster?.onToggleArea(currentAgent, "pagos", false);
    });

    expect(setAgentAreasMock).toHaveBeenCalledWith(expect.anything(), "agent-1", ["ventas", "envios", "reclamos"]);
    expect(stubs.roster?.areasByAgent?.["agent-1"]).toEqual(["ventas", "envios", "reclamos"]);
    expect(stubs.roster?.savingAreasAgentIds.size).toBe(0);
  });

  it("si la base rechaza (ConfigWriteDeniedError) el toast dice por qué y las áreas vuelven a las cuatro", async () => {
    setAgentAreasMock.mockRejectedValue(new ConfigWriteDeniedError("Solo un supervisor o administrador puede cambiar esto."));
    await abrirAgentes();

    await act(async () => {
      stubs.roster?.onToggleArea(currentAgent, "pagos", false);
    });

    await waitFor(() =>
      expect(toastDangerMock).toHaveBeenCalledWith("Solo un supervisor o administrador puede cambiar esto.")
    );
    expect(stubs.roster?.areasByAgent?.["agent-1"]).toEqual(["pagos", "ventas", "envios", "reclamos"]);
    expect(stubs.roster?.savingAreasAgentIds.size).toBe(0);
  });

  it("sin lectura de áreas (null) alternar no escribe nada", async () => {
    await abrirAgentes({ initialAgentAreas: null });

    await act(async () => {
      stubs.roster?.onToggleArea(currentAgent, "pagos", false);
    });

    expect(setAgentAreasMock).not.toHaveBeenCalled();
    expect(stubs.roster?.areasByAgent).toBeNull();
  });

  it("el candado de guardado es por asesor: terminar con uno no libera las casillas del otro (R1/C7, 16/11/2026)", async () => {
    const beto = { ...currentAgent, id: "agent-2", displayName: "Beto" };
    const pendientes = new Map<string, () => void>();
    setAgentAreasMock.mockImplementation(
      (_supabase: unknown, agentId: unknown) =>
        new Promise<void>((resolver) => {
          pendientes.set(agentId as string, resolver);
        })
    );
    await abrirAgentes({
      initialAgentAreas: { "agent-1": [...TODAS_LAS_AREAS], "agent-2": [...TODAS_LAS_AREAS] },
    });

    act(() => {
      stubs.roster?.onToggleArea(currentAgent, "pagos", false);
    });
    act(() => {
      stubs.roster?.onToggleArea(beto, "ventas", false);
    });
    expect(stubs.roster?.savingAreasAgentIds.has("agent-1")).toBe(true);
    expect(stubs.roster?.savingAreasAgentIds.has("agent-2")).toBe(true);

    await act(async () => {
      pendientes.get("agent-1")?.();
    });
    expect(stubs.roster?.savingAreasAgentIds.has("agent-1")).toBe(false);
    expect(stubs.roster?.savingAreasAgentIds.has("agent-2")).toBe(true);
    // Cada asesor conserva SU cambio: uno no pisa al otro.
    expect(stubs.roster?.areasByAgent?.["agent-1"]).toEqual(["ventas", "envios", "reclamos"]);
    expect(stubs.roster?.areasByAgent?.["agent-2"]).toEqual(["pagos", "envios", "reclamos"]);

    await act(async () => {
      pendientes.get("agent-2")?.();
    });
    expect(stubs.roster?.savingAreasAgentIds.size).toBe(0);
  });

  it("dos cambios seguidos sobre el MISMO asesor, antes de repintar, no se pisan (R1/C7, 16/11/2026)", async () => {
    await abrirAgentes();

    await act(async () => {
      stubs.roster?.onToggleArea(currentAgent, "pagos", false);
      stubs.roster?.onToggleArea(currentAgent, "ventas", false);
    });

    expect(setAgentAreasMock).toHaveBeenNthCalledWith(1, expect.anything(), "agent-1", ["ventas", "envios", "reclamos"]);
    expect(setAgentAreasMock).toHaveBeenNthCalledWith(2, expect.anything(), "agent-1", ["envios", "reclamos"]);
    expect(stubs.roster?.areasByAgent?.["agent-1"]).toEqual(["envios", "reclamos"]);
  });
});

/**
 * Entrega 3 de Seba v2 (17/11/2026): la pestaña «Sombra» es solo de supervisor y
 * admin. Los borradores los lee únicamente quien pasa la RLS de
 * `agent_shadow_drafts`; a un asesor ni se le ofrece la pestaña.
 */
describe("AgentControlView — pestaña «Sombra» (entrega 3, 17/11/2026)", () => {
  beforeEach(() => {
    pills.items = [];
  });

  it("un asesor NO ve la pestaña", async () => {
    montar(encendida, [], {}, { ...currentAgent, role: "agent" });
    await waitFor(() => expect(pills.items.length).toBeGreaterThan(0));

    expect(pills.items.some((item) => item.value === "sombra")).toBe(false);
    expect(screen.queryByTestId("panel-sombra")).not.toBeInTheDocument();
  });

  it.each(["supervisor", "admin"] as const)("un %s la ve, justo después de «Seba v2»", async (role) => {
    montar(encendida, [], {}, { ...currentAgent, role });
    await waitFor(() => expect(pills.items.length).toBeGreaterThan(0));

    const values = pills.items.map((item) => item.value);
    expect(values.indexOf("sombra")).toBe(values.indexOf("seba") + 1);
    expect(pills.items.find((item) => item.value === "sombra")?.label).toBe("Sombra");
  });

  it("al elegirla monta el panel con el agente y el tope diario de la configuración, y el título cambia", async () => {
    montar(encendida);
    await waitFor(() => expect(pills.items.some((item) => item.value === "sombra")).toBe(true));
    expect(screen.queryByTestId("panel-sombra")).not.toBeInTheDocument();

    act(() => pills.onChange("sombra"));

    const panel = await screen.findByTestId("panel-sombra");
    expect(panel).toHaveAttribute("data-tope", "2");
    expect(panel).toHaveAttribute("data-agente", currentAgent.id);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sombra de Seba v2");
  });

  it("sin la configuración de Seba v2 (migración sin aplicar) el tope llega null, no 0", async () => {
    montar(encendida, [], {}, currentAgent, { initialSebaV2Config: null });
    await waitFor(() => expect(pills.items.some((item) => item.value === "sombra")).toBe(true));

    act(() => pills.onChange("sombra"));

    expect(await screen.findByTestId("panel-sombra")).toHaveAttribute("data-tope", "null");
  });
});
