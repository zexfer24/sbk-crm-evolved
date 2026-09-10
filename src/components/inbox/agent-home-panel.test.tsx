/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentHomePanel } from "@/components/inbox/agent-home-panel";
import type { Agent, AgentSettings } from "@/lib/types";
import type { AgentDaySummary, AiAssignment } from "@/lib/agent-day-data";
import type { InboxCounts } from "@/lib/data";
import { formatTime12h } from "@/lib/format";

/**
 * T4 ("Los números del día", 10/9/2026) reescribe este archivo: el panel
 * deja de ser solo los cinco números de la bandeja compartida (Pendientes /
 * Esperando +24 h / Tuyas / Sin dueño / Esperando asesor, fijados el
 * 30/8/2026 y el 5/9/2026) y pasa a hablarle al asesor de SU día — "Tu día",
 * "Tus chats", "La IA te pasó hoy" y una línea compacta de equipo que
 * conserva el KPI "Sin dueño". Los casos que siguen siendo verdad (el saludo
 * por nombre, "Sin dueño" solo se tiñe con algo suelto) se conservan
 * adaptados a la forma nueva.
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

const counts: InboxCounts = {
  pending: 31,
  pendingStale: 0,
  mine: 9,
  unread: 0,
  mineUnread: 2,
  unassigned: 0,
  escalated: 4,
};

const agentDay: AgentDaySummary = {
  asignadas: 7,
  respondidas: 12,
  ventas: 3,
  montoUsd: 412,
};

const aiAssignments: AiAssignment[] = [
  {
    handoffId: "handoff-1",
    conversationId: "conv-1",
    contactName: "Carlos Pérez",
    createdAt: "2026-09-10T14:42:00.000Z",
  },
  {
    handoffId: "handoff-2",
    conversationId: "conv-2",
    contactName: "María Rojas",
    createdAt: "2026-09-10T12:03:00.000Z",
  },
];

describe("AgentHomePanel", () => {
  it("pinta las cuatro tarjetas de 'Tu día' y las dos de 'Tus chats'", () => {
    render(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={counts}
        agentSettings={agentSettings}
        agentDay={agentDay}
        aiAssignments={[]}
      />
    );

    expect(screen.getByText("Tu día")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Asignadas hoy")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Respondidas hoy")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Ventas hoy")).toBeInTheDocument();
    expect(screen.getByText("$ 412,00")).toBeInTheDocument();
    expect(screen.getByText("Vendido hoy")).toBeInTheDocument();

    expect(screen.getByText("Tus chats")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("Tuyas")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Tuyas sin leer")).toBeInTheDocument();
  });

  /**
   * `agentDay: null` es el RPC fallido o todavía sin resolver — nunca se
   * pinta un cero ahí: un cero es una afirmación ("no asignaron nada hoy") y
   * confundirlo con "todavía no cargó" le mentiría al asesor sobre su
   * propio día.
   */
  it("con agentDay en null las cuatro tarjetas de 'Tu día' pintan guión, no cero", () => {
    render(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={counts}
        agentSettings={agentSettings}
        agentDay={null}
        aiAssignments={[]}
      />
    );

    const dashes = screen.getAllByText("—");
    expect(dashes).toHaveLength(4);
    expect(screen.queryByText("$ —")).not.toBeInTheDocument();
  });

  it("'Tuyas sin leer' lleva data-alerta solo cuando hay algo sin leer", () => {
    const { rerender, container } = render(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={{ ...counts, mineUnread: 0 }}
        agentSettings={agentSettings}
        agentDay={agentDay}
        aiAssignments={[]}
      />
    );

    expect(container.querySelector('.crm-agent-stat[data-alerta="true"]')).toBeNull();

    rerender(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={{ ...counts, mineUnread: 3 }}
        agentSettings={agentSettings}
        agentDay={agentDay}
        aiAssignments={[]}
      />
    );

    expect(container.querySelector('.crm-agent-stat[data-alerta="true"]')).not.toBeNull();
  });

  it("la lista 'La IA te pasó hoy' pinta nombre, hora y enlaza al hilo", () => {
    render(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={counts}
        agentSettings={agentSettings}
        agentDay={agentDay}
        aiAssignments={aiAssignments}
      />
    );

    expect(screen.getByText("La IA te pasó hoy · 2")).toBeInTheDocument();
    expect(screen.getByText("Carlos Pérez")).toBeInTheDocument();
    expect(screen.getByText("María Rojas")).toBeInTheDocument();
    // La hora se calcula con la misma función que usa el componente
    // (`formatTime12h`) en vez de escribir la hora a mano: fijarla a mano
    // haría el test depender de la zona horaria de quien lo corre.
    expect(screen.getByText(formatTime12h(aiAssignments[0].createdAt))).toBeInTheDocument();

    const link = screen.getByText("Carlos Pérez").closest("a");
    expect(link).toHaveAttribute("href", "/inbox?conversation=conv-1");
  });

  it("con la lista de la IA vacía pinta 'Todavía nada hoy'", () => {
    render(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={counts}
        agentSettings={agentSettings}
        agentDay={agentDay}
        aiAssignments={[]}
      />
    );

    expect(screen.getByText("La IA te pasó hoy · 0")).toBeInTheDocument();
    expect(screen.getByText("Todavía nada hoy")).toBeInTheDocument();
  });

  /**
   * La línea de equipo conserva "Sin dueño" —el KPI de la reforma "ningún
   * lead invisible"— tal como lo hacía la tarjeta que reemplaza: teñido solo
   * cuando hay algo suelto, igual en cero que sus vecinos.
   */
  it("la línea de equipo dice 'Sin dueño 0' y se tiñe solo con leads sueltos", () => {
    const { container, rerender } = render(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={{ ...counts, unassigned: 0 }}
        agentSettings={agentSettings}
        agentDay={agentDay}
        aiAssignments={[]}
      />
    );

    const team = container.querySelector(".crm-agent-team");
    expect(team?.textContent).toContain("Sin dueño 0");
    expect(team?.querySelector('[data-alerta="true"]')).toBeNull();

    rerender(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={{ ...counts, unassigned: 5 }}
        agentSettings={agentSettings}
        agentDay={agentDay}
        aiAssignments={[]}
      />
    );

    const teamAfter = container.querySelector(".crm-agent-team");
    expect(teamAfter?.textContent).toContain("Sin dueño 5");
    expect(teamAfter?.querySelector('[data-alerta="true"]')).not.toBeNull();
  });

  it("la línea de equipo nombra Pendientes y Esperando asesor", () => {
    const { container } = render(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={counts}
        agentSettings={agentSettings}
        agentDay={agentDay}
        aiAssignments={[]}
      />
    );

    const team = container.querySelector(".crm-agent-team");
    expect(team?.textContent).toContain("Pendientes 31");
    expect(team?.textContent).toContain("Esperando asesor 4");
  });

  it("saluda al asesor por su nombre", () => {
    render(
      <AgentHomePanel
        currentAgent={currentAgent}
        counts={counts}
        agentSettings={agentSettings}
        agentDay={agentDay}
        aiAssignments={[]}
      />
    );

    expect(screen.getByText("Hola, Ana")).toBeInTheDocument();
  });
});
