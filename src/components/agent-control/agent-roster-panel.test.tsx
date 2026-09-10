/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentsRosterPanel } from "@/components/agent-control/agent-roster-panel";
import type { Agent, BoardConversation } from "@/lib/types";

/**
 * La tarjeta "Sin asignar" listaba TODOS los chats abiertos sin asesor, uno
 * por uno, sin paginar. En producción, con cientos de leads abiertos,
 * ocupaba la página entera y tapaba la navegación. El operador la retiró el
 * 10/9/2026 ("Los números del día"): esa cola ya vive paginada en la
 * píldora "Sin dueño" de la bandeja. Estos tests fijan que solo el NÚMERO
 * sobrevive, no la lista.
 */

function agente(id: string, displayName: string): Agent {
  return { id, displayName, fullName: displayName, avatarUrl: null, role: "agent", isActive: true };
}

function conversacion(id: string, patch: Partial<BoardConversation> = {}): BoardConversation {
  return {
    id,
    contact: {
      id: `contact-${id}`,
      phoneNumber: `+58${id}`,
      displayName: `Cliente ${id}`,
      profileName: null,
    },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: true,
    dealStatus: "none",
    dealVerified: false,
    lastCustomerMessageAt: "2026-09-10T10:00:00.000Z",
    lastMessageAt: "2026-09-10T10:00:00.000Z",
    lastReplyAt: null,
    lastReplySender: null,
    hasReply: false,
    createdAt: "2026-09-10T10:00:00.000Z",
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    ...patch,
  };
}

describe("AgentsRosterPanel — la caja Sin asignar ya no se pinta", () => {
  it("no queda ningún nodo [data-unassigned] ni una tarjeta llamada 'Sin asignar'", () => {
    const agents = [agente("a1", "Ana"), agente("a2", "Beto")];
    const sinAsignar = Array.from({ length: 40 }, (_, i) => conversacion(`u${i}`));

    const { container } = render(
      <AgentsRosterPanel
        agents={agents}
        conversations={sinAsignar}
        metrics={[]}
        togglingAgentId={null}
        onToggleActive={vi.fn()}
      />
    );

    expect(container.querySelector("[data-unassigned]")).toBeNull();
    expect(screen.queryByText("Sin asignar")).not.toBeInTheDocument();
  });

  it("ninguno de los 40 nombres de contacto sin asesor se pinta", () => {
    const agents = [agente("a1", "Ana")];
    const sinAsignar = Array.from({ length: 40 }, (_, i) => conversacion(`u${i}`));

    render(
      <AgentsRosterPanel
        agents={agents}
        conversations={sinAsignar}
        metrics={[]}
        togglingAgentId={null}
        onToggleActive={vi.fn()}
      />
    );

    sinAsignar.forEach((c) => {
      expect(screen.queryByText(c.contact.displayName as string)).not.toBeInTheDocument();
    });
  });

  it("la nota del encabezado dice '40 sin asignar'", () => {
    const agents = [agente("a1", "Ana")];
    const sinAsignar = Array.from({ length: 40 }, (_, i) => conversacion(`u${i}`));

    render(
      <AgentsRosterPanel
        agents={agents}
        conversations={sinAsignar}
        metrics={[]}
        togglingAgentId={null}
        onToggleActive={vi.fn()}
      />
    );

    expect(screen.getByText("40 sin asignar")).toBeInTheDocument();
  });

  it("un asesor con 7 chats asignados muestra cinco nombres y '+2 más'", () => {
    const agents = [agente("a1", "Ana")];
    const asignados = Array.from({ length: 7 }, (_, i) => conversacion(`c${i}`, { assignedAgent: { id: "a1", displayName: "Ana" } }));

    render(
      <AgentsRosterPanel
        agents={agents}
        conversations={asignados}
        metrics={[]}
        togglingAgentId={null}
        onToggleActive={vi.fn()}
      />
    );

    asignados.slice(0, 5).forEach((c) => {
      expect(screen.getByText(c.contact.displayName as string)).toBeInTheDocument();
    });
    asignados.slice(5).forEach((c) => {
      expect(screen.queryByText(c.contact.displayName as string)).not.toBeInTheDocument();
    });
    expect(screen.getByText("+2 más")).toBeInTheDocument();
  });

  it("el enlace de 'sin asignar' apunta a la bandeja", () => {
    const agents = [agente("a1", "Ana")];
    const sinAsignar = [conversacion("u1")];

    render(
      <AgentsRosterPanel
        agents={agents}
        conversations={sinAsignar}
        metrics={[]}
        togglingAgentId={null}
        onToggleActive={vi.fn()}
      />
    );

    const enlace = screen.getByText("1 sin asignar");
    expect(enlace).toHaveAttribute("href", "/inbox");
  });
});
