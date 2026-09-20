import { describe, expect, it, vi, beforeEach } from "vitest";

// 20/9/2026, "El resguardo antes del push" (T3-b, mínimo explícito): hasta
// esta corrida `agent-control/page.tsx` (el cableado real de
// `readListIfTableExists`, T7 de "Seba sale sin pisar a nadie", 19/9/2026)
// no tenía NINGÚN test propio -- `degradable-reads.test.ts` prueba la
// función en el vacío, pero nada probaba que el SERVER COMPONENT la use, y
// menos que la use exactamente con `fetchLessons`/`fetchCatalogLinks` y con
// NINGUNA otra lectura de las ~19 del `Promise.all`. Envolver la lectura
// equivocada (o dejar `fetchLessons` sin envolver) habría pasado
// desapercibido.
//
// El componente es un Server Component async que arrastra
// `@/lib/supabase/server` (usa `next/headers`) y el módulo pesado
// `@/lib/data`: se mockean todos sus módulos importados y se espía
// `readListIfTableExists` para ver qué promesa entró ahí, identificando cada
// una con un marcador único devuelto por su `fetch*` de origen.

const readListIfTableExistsMock = vi.fn(
  async (promise: Promise<unknown>, _label: string) => promise
);
vi.mock("@/app/agent-control/degradable-reads", () => ({
  readListIfTableExists: (...args: [Promise<unknown>, string]) => readListIfTableExistsMock(...args),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({})),
}));

vi.mock("@/lib/ai/model", () => ({
  currentAgentModelLabel: () => "modelo-fake",
}));

vi.mock("@/components/agent-control/agent-control-view", () => ({
  AgentControlView: () => null,
}));

function marker(name: string) {
  return { __marker: name };
}

vi.mock("@/lib/data", () => ({
  fetchCurrentAgent: vi.fn(async () => ({ id: "agent-1" })),
  fetchBoardConversations: vi.fn(async () => marker("conversations")),
  fetchAgentTurns: vi.fn(async () => marker("turns")),
  fetchAgentSettings: vi.fn(async () => marker("settings")),
  fetchAllAgents: vi.fn(async () => marker("agents")),
  fetchTokenUsageSummary: vi.fn(async () => marker("tokenUsage")),
  fetchModelPricing: vi.fn(async () => marker("pricing")),
  fetchAgentSuggestions: vi.fn(async () => marker("suggestions")),
  fetchAgentMetrics: vi.fn(async () => marker("agentMetrics")),
  fetchPlaybooks: vi.fn(async () => marker("playbooks")),
  fetchUnmatchedTurns: vi.fn(async () => marker("unmatchedTurns")),
  fetchQuickReplies: vi.fn(async () => marker("quickReplies")),
  fetchAgentTools: vi.fn(async () => marker("agentTools")),
  fetchKnowledgeCategories: vi.fn(async () => marker("knowledgeCategories")),
  fetchKnowledgeEntries: vi.fn(async () => marker("knowledgeEntries")),
  fetchLessons: vi.fn(async () => marker("lessons")),
  fetchTags: vi.fn(async () => marker("tags")),
  fetchWhatsappChannelHealth: vi.fn(async () => marker("channelHealth")),
  fetchCatalogLinks: vi.fn(async () => marker("catalogLinks")),
}));

describe("agent-control/page.tsx — cableado de readListIfTableExists", () => {
  beforeEach(() => {
    readListIfTableExistsMock.mockClear();
  });

  it("envuelve EXACTAMENTE fetchLessons y fetchCatalogLinks, y ninguna otra lectura", async () => {
    const { default: AgentControlPage } = await import("./page");
    await AgentControlPage();

    expect(readListIfTableExistsMock).toHaveBeenCalledTimes(2);

    const wrapped = await Promise.all(
      readListIfTableExistsMock.mock.calls.map(([promise]) => promise)
    );
    const names = (wrapped as Array<{ __marker: string }>).map((v) => v.__marker).sort();
    expect(names).toEqual(["catalogLinks", "lessons"]);
  });
});
