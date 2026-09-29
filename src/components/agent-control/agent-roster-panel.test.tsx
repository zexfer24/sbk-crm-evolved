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
        canManageAll
        currentAgentId="a1"
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
        canManageAll
        currentAgentId="a1"
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
        canManageAll
        currentAgentId="a1"
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
        canManageAll
        currentAgentId="a1"
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
        canManageAll
        currentAgentId="a1"
        onToggleActive={vi.fn()}
      />
    );

    const enlace = screen.getByText("1 sin asignar");
    expect(enlace).toHaveAttribute("href", "/inbox");
  });
});

/**
 * T7, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
 * esperando" (28/9/2026). El interruptor del reparto no tenía puerta de rol:
 * un asesor podía pulsar el de otro y la base ignoraba el UPDATE sin error
 * (`agents_update_self` solo deja tocar la fila propia; el resto es de
 * supervisor/admin). Un asesor corriente conserva el suyo.
 */
describe("AgentsRosterPanel — el reparto solo lo cambia quien puede", () => {
  const agents = [agente("a1", "Ana"), agente("a2", "Beto")];

  function botonesDeReparto() {
    return screen.getAllByRole("button", { name: /reparto|Sacar a|Devolver a/ });
  }

  it("un asesor corriente puede cambiar su propia fila y no la de otro", () => {
    render(
      <AgentsRosterPanel
        agents={agents}
        conversations={[]}
        metrics={[]}
        togglingAgentId={null}
        canManageAll={false}
        currentAgentId="a1"
        onToggleActive={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /Sacar a Ana/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Sacar a Beto/ })).toBeDisabled();
    expect(botonesDeReparto()).toHaveLength(2);
  });

  it("un supervisor puede cambiar cualquier fila", () => {
    render(
      <AgentsRosterPanel
        agents={agents}
        conversations={[]}
        metrics={[]}
        togglingAgentId={null}
        canManageAll
        currentAgentId="a1"
        onToggleActive={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /Sacar a Ana/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Sacar a Beto/ })).toBeEnabled();
  });
});
