/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentHomePanel } from "@/components/inbox/agent-home-panel";
import type { Agent, AgentSettings } from "@/lib/types";

/**
 * El panel pinta los tres números con el mismo vocabulario que las píldoras
 * y las secciones de la bandeja: "Pendientes" / "Esperando +24 h" / "Tuyas".
 * Reemplaza a la forma vieja ("Sin leer" / "Tuyas" / "Sin asignar"), que
 * este archivo fijaba como resguardo antes de la reforma del 28/8/2026 (T6).
 */

const currentAgent: Agent = {
  id: "agent-1",
  displayName: "Ana",
  fullName: "Ana Pérez",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

const agentSettings: AgentSettings = {
  aiGloballyEnabled: true,
  dailySpendCapUsd: null,
  spentTodayUsd: 0,
};

describe("AgentHomePanel", () => {
  it("pinta los tres números con el vocabulario de las píldoras", () => {
    render(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={{ pending: 4, pendingStale: 3, mine: 2 }}
        agentSettings={agentSettings}
      />
    );

    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Pendientes")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Esperando +24 h")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Tuyas")).toBeInTheDocument();
  });

  it("saluda al asesor por su nombre", () => {
    render(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={{ pending: 0, pendingStale: 0, mine: 0 }}
        agentSettings={agentSettings}
      />
    );

    expect(screen.getByText("Hola, Ana")).toBeInTheDocument();
  });
});
