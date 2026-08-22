import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { Agent, Conversation, Tag } from "@/lib/types";
import { InboxSidebar } from "@/components/inbox/inbox-sidebar";

const TAG_VIP: Tag = { id: "t-vip", label: "VIP", color: "accent" };
const TAG_MOROSO: Tag = { id: "t-moroso", label: "Moroso", color: "danger" };
const ALL_TAGS = [TAG_VIP, TAG_MOROSO];

function agent(id: string, role: Agent["role"]): Agent {
  return { id, displayName: id, fullName: null, avatarUrl: null, role, isActive: true };
}

const ANA = agent("ana", "agent");
const JEFA = agent("jefa", "admin");

function conversation(over: {
  id: string;
  unreadCount?: number;
  assignedAgent?: Agent | null;
  tags?: Tag[];
}): Conversation {
  return {
    id: over.id,
    contact: {
      id: `c-${over.id}`,
      phoneNumber: "+58 412 000 0000",
      displayName: over.id,
      profileName: null,
      avatarUrl: null,
      cedulaType: null,
      cedulaNumber: null,
      state: null,
      city: null,
      address: null,
      tags: over.tags ?? [],
    },
    unreadCount: over.unreadCount ?? 0,
    assignedAgent: over.assignedAgent ?? null,
    aiEnabled: true,
    lastMessageAt: "2026-08-22T10:00:00Z",
    lastMessagePreview: "hola",
    lastMessageDirection: "inbound",
    lastMessageStatus: null,
  } as unknown as Conversation;
}

const CONVERSATIONS = [
  conversation({ id: "sin-duena", unreadCount: 2, tags: [TAG_VIP] }),
  conversation({ id: "de-ana", assignedAgent: ANA, tags: [TAG_MOROSO] }),
  conversation({ id: "de-ana-sin-leer", assignedAgent: ANA, unreadCount: 1 }),
];

function renderSidebar(currentAgent: Agent) {
  return render(
    <InboxSidebar
      conversations={CONVERSATIONS}
      selectedId={null}
      onSelect={() => {}}
      currentAgent={currentAgent}
      allTags={ALL_TAGS}
      bcvRate={null}
    />
  );
}

/** Los nombres visibles de las conversaciones que quedaron en la lista. */
function visibleIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".crm-thread-name")).map(
    (el) => el.textContent ?? ""
  );
}

/**
 * SlidingPills duplica la fila de botones para animar el recorte de la
 * píldora activa, así que cada etiqueta aparece dos veces en el DOM. Lo que
 * importa acá es si está o no, no cuántas copias hay.
 */
function pillLabels(): string[] {
  const filtros = screen.getByRole("group", { name: "Filtrar conversaciones" });
  const vistos = new Set<string>();
  for (const button of within(filtros).getAllByRole("button", { hidden: true })) {
    if (button.textContent) vistos.add(button.textContent);
  }
  return [...vistos];
}

describe("InboxSidebar — qué filtros ve cada rol", () => {
  it("al administrador le ofrece los cortes de toda la bandeja", () => {
    renderSidebar(JEFA);
    expect(pillLabels()).toEqual(["Todos", "Sin leer", "Sin asignar", "Asignados"]);
  });

  it("al asesor solo le ofrece lo suyo, sin los cortes de administración", () => {
    renderSidebar(ANA);
    expect(pillLabels()).toEqual(["Todos", "Míos", "Míos sin leer"]);
  });
});

describe("InboxSidebar — filtrar por etiqueta", () => {
  it("solo ofrece las etiquetas que alguna conversación está usando", () => {
    const { container } = render(
      <InboxSidebar
        conversations={[conversation({ id: "sola", tags: [TAG_VIP] })]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );

    const barra = container.querySelector(".crm-tag-filter") as HTMLElement;
    expect(within(barra).getByText("VIP")).toBeTruthy();
    expect(within(barra).queryByText("Moroso")).toBeNull();
  });

  it("al tocar una etiqueta deja solo las conversaciones que la llevan", () => {
    const { container } = renderSidebar(JEFA);
    const barra = container.querySelector(".crm-tag-filter") as HTMLElement;

    fireEvent.click(within(barra).getByText("VIP"));

    expect(visibleIds(container)).toEqual(["sin-duena"]);
  });

  it("tocar de nuevo la etiqueta activa quita el filtro", () => {
    const { container } = renderSidebar(JEFA);
    const barra = container.querySelector(".crm-tag-filter") as HTMLElement;

    fireEvent.click(within(barra).getByText("VIP"));
    fireEvent.click(within(barra).getByText("VIP"));

    expect(visibleIds(container)).toHaveLength(3);
  });
});

describe("InboxSidebar — orden", () => {
  it("el botón de orden alterna entre más recientes y más viejos", () => {
    renderSidebar(JEFA);

    // Arranca en "más recientes": el botón ofrece cambiar a lo viejo.
    const botón = screen.getByRole("button", { name: "Ordenar: Más viejos primero" });
    fireEvent.click(botón);

    expect(screen.getByRole("button", { name: "Ordenar: Más recientes primero" })).toBeTruthy();
  });
});
