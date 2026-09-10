/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Agent, BoardConversation } from "@/lib/types";
import { DashboardView } from "@/components/dashboard/dashboard-view";

// ---------------------------------------------------------------------------
// T2, corrida "Los números del día" (10/9/2026): `DashboardView` conecta el
// corte "habló hoy" (`useInboxDay`, real acá abajo — solo se mockea el reloj
// del que depende) al Recorrido y suma "Total de leads". Estas pruebas
// cubren la pantalla completa, no la fórmula (`buildJourney`/`matchesDay`,
// ya probadas en `dashboard.test.ts`/`inbox-filters.test.ts`) ni la tarjeta
// (`journey-board.test.tsx`).
// ---------------------------------------------------------------------------

/** Mismo sustituto no-op que usa `journey-board.test.tsx`: jsdom no trae ResizeObserver. */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createFakeSupabase() {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  };
  return {
    supabase: {
      channel: () => channel,
      removeChannel: () => {},
      auth: { signOut: vi.fn() },
    },
  };
}

let fake: ReturnType<typeof createFakeSupabase>;

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => fake.supabase,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// `AppRail` (montado de verdad por `DashboardView`, sin mock) trae el aviso
// de asignación (`AssignmentNotifier`), que pide `fetchCurrentAgent` al
// montarse — mismo motivo que en `crm-shell.test.tsx`. El resto de `data.ts`
// no hace falta acá: `useLiveConversations` va mockeado entero (ver abajo),
// así que el `fetcher` real de `DashboardView` —que sí las importa— nunca
// llega a invocarlas.
vi.mock("@/lib/data", () => ({
  fetchCurrentAgent: vi.fn().mockResolvedValue(null),
  fetchDashboardConversations: vi.fn(),
  fetchBoardConversationRow: vi.fn(),
  fetchTodayActivity: vi.fn(),
}));

vi.mock("@/lib/dashboard-data", () => ({
  fetchLeadTotal: vi.fn(),
}));

// El tablero solo necesita ver la lista con la que arranca: el refresco en
// tiempo real ya lo prueba `use-live-conversations.test.ts` (si existe) o el
// contrato del propio hook; acá alcanza con devolver `initialConversations`
// tal cual llegan.
vi.mock("@/lib/use-live-conversations", () => ({
  useLiveConversations: (_supabase: unknown, initialConversations: unknown) => ({
    conversations: initialConversations,
    setConversations: vi.fn(),
    refreshConversations: vi.fn(),
  }),
}));

// `useClock()` cuantiza al minuto y arranca su propio `setInterval` — acá
// basta con que devuelva la hora fijada por `vi.setSystemTime` en cada
// llamada, sin temporizador propio que sobreviva al test. `useInboxDay`
// (real, sin mockear) importa este MISMO módulo, así que el `dayStart` que
// calcula sale de la misma hora fijada — es la garantía que pide el
// comentario de `useInboxDay`: una sola fuente para el corte del día.
vi.mock("@/lib/use-clock", () => ({
  useClock: () => Date.now(),
}));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  fake = createFakeSupabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const AGENT: Agent = {
  id: "ag-1",
  displayName: "Pedro",
  fullName: "Pedro Pérez",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

/** Mismo fixture mínimo que `dashboard.test.ts`/`journey-board.test.tsx` (misma forma de `BoardConversation`). */
function conversacion(over: Partial<BoardConversation> = {}): BoardConversation {
  return {
    id: "conv-1",
    contact: { id: "contact-1", phoneNumber: "+580000000011", displayName: "Cliente", profileName: null },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: true,
    dealStatus: "none",
    dealVerified: false,
    lastCustomerMessageAt: null,
    lastMessageAt: null,
    lastReplyAt: null,
    lastReplySender: null,
    hasReply: false,
    createdAt: "2026-09-10T15:00:00.000Z",
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    ...over,
  };
}

function renderView(overrides: Partial<Parameters<typeof DashboardView>[0]> = {}) {
  return render(
    <DashboardView
      currentAgent={AGENT}
      agents={[AGENT]}
      initialConversations={[]}
      initialTicketTags={new Map()}
      initialActivity={[]}
      initialLeadTotal={0}
      timeZone="America/Caracas"
      {...overrides}
    />
  );
}

/** El valor numérico del pulso que acompaña a `label` (p. ej. "Con la IA"). */
function pulseValue(container: HTMLElement, label: string): string | null {
  const items = Array.from(container.querySelectorAll(".dash-pulse-item"));
  const item = items.find((el) => el.querySelector(".dash-pulse-label")?.textContent === label);
  return item?.querySelector(".dash-pulse-value")?.textContent ?? null;
}

function pulseCaption(container: HTMLElement, label: string): string | null {
  const items = Array.from(container.querySelectorAll(".dash-pulse-item"));
  const item = items.find((el) => el.querySelector(".dash-pulse-label")?.textContent === label);
  return item?.querySelector(".dash-pulse-caption")?.textContent ?? null;
}

describe("DashboardView", () => {
  // Tarde de Caracas del 10/9/2026 (America/Caracas = UTC-4): mismo patrón
  // que `dashboard.test.ts` ("HOY" en `describe("buildJourney con dayStart")`).
  const HOY = "2026-09-10T19:00:00.000Z";
  const AYER = "2026-09-09T20:00:00.000Z";

  it('(a) con dos conversaciones de hoy y una de ayer, "Con la IA" cuenta solo las de hoy y la de ayer no aparece en ninguna columna', () => {
    vi.setSystemTime(new Date(HOY));

    const hoy1 = conversacion({
      id: "hoy-1",
      contact: { id: "c-hoy-1", phoneNumber: "+580000000001", displayName: "Hoy Uno", profileName: null },
      lastCustomerMessageAt: HOY,
      lastMessageAt: HOY,
      createdAt: HOY,
    });
    const hoy2 = conversacion({
      id: "hoy-2",
      contact: { id: "c-hoy-2", phoneNumber: "+580000000002", displayName: "Hoy Dos", profileName: null },
      lastCustomerMessageAt: HOY,
      lastMessageAt: HOY,
      createdAt: HOY,
    });
    const ayer = conversacion({
      id: "ayer-1",
      contact: { id: "c-ayer", phoneNumber: "+580000000003", displayName: "Ayer Cliente", profileName: null },
      lastCustomerMessageAt: AYER,
      lastMessageAt: AYER,
      createdAt: AYER,
    });

    const { container } = renderView({ initialConversations: [hoy1, hoy2, ayer] });

    expect(pulseValue(container, "Con la IA")).toBe("2");
    expect(screen.queryByText("Ayer Cliente")).not.toBeInTheDocument();
    expect(screen.getByText("Hoy Uno")).toBeInTheDocument();
    expect(screen.getByText("Hoy Dos")).toBeInTheDocument();
  });

  it('(b) "Total de leads" pinta el initialLeadTotal con la marca "acumulado"', () => {
    vi.setSystemTime(new Date(HOY));

    const { container } = renderView({ initialLeadTotal: 813 });

    expect(pulseValue(container, "Total de leads")).toBe("813");
    expect(pulseCaption(container, "Total de leads")).toBe("acumulado");
  });

  it("(c) la carga por asesor (título del avatar) cuenta solo casos con actividad hoy", () => {
    vi.setSystemTime(new Date(HOY));

    const casoHoy = conversacion({
      id: "caso-hoy",
      assignedAgent: { id: AGENT.id, displayName: AGENT.displayName },
      lastCustomerMessageAt: HOY,
      lastMessageAt: HOY,
      createdAt: HOY,
    });
    const casoAyer = conversacion({
      id: "caso-ayer",
      assignedAgent: { id: AGENT.id, displayName: AGENT.displayName },
      lastCustomerMessageAt: AYER,
      lastMessageAt: AYER,
      createdAt: AYER,
    });

    const { container } = renderView({ initialConversations: [casoHoy, casoAyer] });

    const stack = container.querySelector(".dash-avatar-stack");
    expect(stack?.getAttribute("title")).toBe(`${AGENT.displayName}: 1 casos abiertos`);
  });
});
