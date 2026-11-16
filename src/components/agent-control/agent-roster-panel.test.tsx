/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AgentsRosterPanel } from "@/components/agent-control/agent-roster-panel";
import type { Agent, BoardConversation } from "@/lib/types";
import type { Area } from "@/lib/seba-v2-config";

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
        areasByAgent={null}
        savingAreasAgentIds={new Set<string>()}
        onToggleArea={vi.fn()}
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
        areasByAgent={null}
        savingAreasAgentIds={new Set<string>()}
        onToggleArea={vi.fn()}
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
        areasByAgent={null}
        savingAreasAgentIds={new Set<string>()}
        onToggleArea={vi.fn()}
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
        areasByAgent={null}
        savingAreasAgentIds={new Set<string>()}
        onToggleArea={vi.fn()}
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
        areasByAgent={null}
        savingAreasAgentIds={new Set<string>()}
        onToggleArea={vi.fn()}
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
        areasByAgent={null}
        savingAreasAgentIds={new Set<string>()}
        onToggleArea={vi.fn()}
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
        areasByAgent={null}
        savingAreasAgentIds={new Set<string>()}
        onToggleArea={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /Sacar a Ana/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Sacar a Beto/ })).toBeEnabled();
  });
});

describe("AgentsRosterPanel — el rol caja no es un asesor", () => {
  // La caja (13/10/2026) solo ve el Inventario: no entra al reparto de
  // escaladas, así que no tiene tarjeta, no cuenta en el total ni en el reparto.
  it("no pinta la tarjeta de una cuenta de caja ni la cuenta en la nota del encabezado", () => {
    const agents: Agent[] = [
      agente("a1", "Ana"),
      { ...agente("c1", "Cajero Principal"), role: "caja" },
    ];

    render(
      <AgentsRosterPanel
        agents={agents}
        conversations={[]}
        metrics={[]}
        togglingAgentId={null}
        canManageAll
        currentAgentId="a1"
        onToggleActive={vi.fn()}
        areasByAgent={null}
        savingAreasAgentIds={new Set<string>()}
        onToggleArea={vi.fn()}
      />
    );

    expect(screen.getByText("Ana")).toBeInTheDocument();
    expect(screen.queryByText("Cajero Principal")).not.toBeInTheDocument();
    expect(screen.getByText(/1 en total · 1 en el reparto/)).toBeInTheDocument();
  });
});

/**
 * Entrega 2 de Seba v2 (16/11/2026): cuatro casillas de área por asesor. Solo
 * un supervisor o admin las cambia (en la base lo impone un trigger): a
 * diferencia del interruptor del reparto, ni el propio asesor puede tocar las
 * suyas. Sin lectura de áreas (falta la migración) no se pinta nada: cuatro
 * casillas vacías parecerían "sin ningún área" cuando es "no sabemos".
 */
describe("AgentsRosterPanel — áreas por asesor", () => {
  const agents = [agente("a1", "Ana"), agente("a2", "Beto")];
  const areas: Record<string, Area[]> = {
    a1: ["pagos", "ventas", "envios", "reclamos"],
    a2: ["ventas"],
  };

  function montar(props: Partial<React.ComponentProps<typeof AgentsRosterPanel>> = {}) {
    const onToggleArea = vi.fn();
    render(
      <AgentsRosterPanel
        agents={agents}
        conversations={[]}
        metrics={[]}
        togglingAgentId={null}
        canManageAll
        currentAgentId="a1"
        onToggleActive={vi.fn()}
        areasByAgent={areas}
        savingAreasAgentIds={new Set<string>()}
        onToggleArea={onToggleArea}
        {...props}
      />
    );
    return { onToggleArea };
  }

  it("pinta las cuatro casillas de cada asesor con el estado de areasByAgent", () => {
    montar();

    const grupos = screen.getAllByRole("group", { name: "Áreas" });
    expect(grupos).toHaveLength(2);

    const deAna = within(grupos[0]).getAllByRole("checkbox");
    expect(deAna.map((c) => (c as HTMLInputElement).checked)).toEqual([true, true, true, true]);

    const deBeto = within(grupos[1]);
    expect(deBeto.getByRole("checkbox", { name: "Pagos: Beto" })).not.toBeChecked();
    expect(deBeto.getByRole("checkbox", { name: "Ventas: Beto" })).toBeChecked();
    expect(deBeto.getByRole("checkbox", { name: "Envíos: Beto" })).not.toBeChecked();
    expect(deBeto.getByRole("checkbox", { name: "Reclamos: Beto" })).not.toBeChecked();
  });

  it("con canManageAll, desmarcar «Pagos» llama onToggleArea(agente, 'pagos', false)", () => {
    const { onToggleArea } = montar();

    fireEvent.click(screen.getByRole("checkbox", { name: "Pagos: Ana" }));

    expect(onToggleArea).toHaveBeenCalledTimes(1);
    expect(onToggleArea).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }), "pagos", false);
  });

  it("sin canManageAll todas las casillas están deshabilitadas, también las del propio asesor", () => {
    montar({ canManageAll: false });

    for (const casilla of screen.getAllByRole("checkbox")) {
      expect(casilla).toBeDisabled();
    }
    expect(screen.getByRole("checkbox", { name: "Pagos: Ana" })).toBeDisabled();
  });

  it("con areasByAgent null no pinta ningún grupo «Áreas»", () => {
    montar({ areasByAgent: null });

    expect(screen.queryByRole("group", { name: "Áreas" })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("un asesor que no viene en areasByAgent no pinta casillas, y los demás sí", () => {
    montar({ areasByAgent: { a2: ["ventas"] } });

    expect(screen.getAllByRole("group", { name: "Áreas" })).toHaveLength(1);
    expect(screen.queryByRole("checkbox", { name: "Pagos: Ana" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Pagos: Beto" })).toBeInTheDocument();
  });

  it("mientras se guardan las áreas de un asesor, sus casillas se deshabilitan y las del otro no", () => {
    montar({ savingAreasAgentIds: new Set(["a2"]) });

    expect(screen.getByRole("checkbox", { name: "Pagos: Beto" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Pagos: Ana" })).toBeEnabled();
  });

  it("un asesor sin ninguna área y canManageAll muestra la pista; sin canManageAll, no", () => {
    montar({ areasByAgent: { a1: [], a2: ["ventas"] } });
    expect(screen.getByText("Sin áreas: Seba no le pasa casos por área.")).toBeInTheDocument();
  });

  it("sin canManageAll no se muestra la pista de «Sin áreas»", () => {
    montar({ areasByAgent: { a1: [], a2: ["ventas"] }, canManageAll: false });
    expect(screen.queryByText("Sin áreas: Seba no le pasa casos por área.")).not.toBeInTheDocument();
  });
});
