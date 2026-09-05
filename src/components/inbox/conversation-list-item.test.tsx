/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Conversation, Tag } from "@/lib/types";
import { ConversationListItem } from "@/components/inbox/conversation-list-item";

const TAGS: Tag[] = [
  { id: "t1", label: "Moroso", color: "danger" },
  { id: "t2", label: "VIP", color: "accent" },
];

function buildConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    contact: {
      id: "contact-1",
      phoneNumber: "+58 412 000 0000",
      displayName: "Laura Fernández",
      profileName: null,
      avatarUrl: null,
      cedulaType: null,
      cedulaNumber: null,
      state: null,
      city: null,
      address: null,
      tags: [],
    },
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: true,
    lastMessageAt: "2026-08-22T10:00:00Z",
    lastMessagePreview: "Buenas, ¿tienen el carburador?",
    lastMessageDirection: "outbound",
    lastMessageStatus: null,
    ...overrides,
  } as unknown as Conversation;
}

function renderItem(overrides: Partial<Conversation> = {}, options: { isPinned?: boolean } = {}) {
  return render(
    <ConversationListItem
      conversation={buildConversation(overrides)}
      isSelected={false}
      onSelect={() => {}}
      isPinned={options.isPinned}
    />
  );
}

describe("ConversationListItem — estado de entrega", () => {
  it("muestra 'Enviado' cuando el mensaje salió pero no llegó", () => {
    renderItem({ lastMessageStatus: "sent" });
    expect(screen.getByLabelText("Enviado")).toBeTruthy();
  });

  it("muestra 'Recibido' cuando llegó al teléfono", () => {
    renderItem({ lastMessageStatus: "delivered" });
    expect(screen.getByLabelText("Recibido")).toBeTruthy();
  });

  it("muestra 'Leído' cuando el cliente lo abrió", () => {
    renderItem({ lastMessageStatus: "read" });
    expect(screen.getByLabelText("Leído")).toBeTruthy();
  });

  it("avisa cuando el mensaje no se pudo entregar", () => {
    renderItem({ lastMessageStatus: "failed" });
    expect(screen.getByLabelText("No se pudo entregar")).toBeTruthy();
  });

  it("no pinta ningún check en un mensaje entrante: el estado sería del cliente", () => {
    renderItem({ lastMessageDirection: "inbound", lastMessageStatus: "read" });
    expect(screen.queryByLabelText("Leído")).toBeNull();
  });

  it("no pinta check cuando el mensaje nunca salió por WhatsApp", () => {
    renderItem({ lastMessageDirection: "outbound", lastMessageStatus: null });
    expect(screen.queryByLabelText("Enviado")).toBeNull();
    expect(screen.queryByLabelText("Recibido")).toBeNull();
  });
});

describe("ConversationListItem — etiquetas y preview", () => {
  it("muestra las etiquetas del contacto con su color", () => {
    const { container } = renderItem({
      contact: { ...buildConversation().contact, tags: TAGS },
    } as Partial<Conversation>);

    expect(screen.getByText("Moroso")).toBeTruthy();
    expect(screen.getByText("VIP")).toBeTruthy();
    expect(container.querySelector('.crm-tag[data-color="danger"]')).toBeTruthy();
    expect(container.querySelector('.crm-tag[data-color="accent"]')).toBeTruthy();
  });

  it("sin etiquetas no deja la fila vacía en el marcado", () => {
    const { container } = renderItem();
    expect(container.querySelector(".crm-thread-tags")).toBeNull();
  });

  it("muestra la preview completa que venga, sin recortarla en el marcado", () => {
    const largo =
      "Con gusto lo reviso. Pásame la cédula del titular de la cuenta de Cashea, por favor, así busco tu pedido y te digo en qué punto va.";
    renderItem({ lastMessagePreview: largo });
    expect(screen.getByText(largo)).toBeTruthy();
  });

  it("avisa cuando la conversación no tiene mensajes", () => {
    renderItem({ lastMessagePreview: null });
    expect(screen.getByText("Sin mensajes todavía")).toBeTruthy();
  });

  it("muestra el contador de no leídos", () => {
    renderItem({ unreadCount: 3 });
    expect(screen.getByText("3")).toBeTruthy();
  });
});

describe("un chat apartado a mano se ve sin leer, pero sin inventar mensajes", () => {
  it("resalta el nombre aunque el contador esté en cero", () => {
    renderItem({ unreadCount: 0, manuallyUnread: true });
    expect(screen.getByText("Laura Fernández")).toHaveAttribute("data-unread", "true");
  });

  it("marca el chat sin escribir un número que no corresponde a ningún mensaje", () => {
    renderItem({ unreadCount: 0, manuallyUnread: true });
    expect(screen.getByLabelText("Sin leer")).toBeInTheDocument();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("cuando sí hay mensajes nuevos, el contador manda", () => {
    renderItem({ unreadCount: 3, manuallyUnread: true });
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});

describe("ConversationListItem — píldora de ventana de 24h", () => {
  // `now` fijo con vi.setSystemTime: `useClock` cuantiza el reloj a partir de
  // Date.now(), y al montar el componente `subscribe()` recalcula el
  // snapshot contra la hora falsa antes de la primera pintura.
  const NOW = new Date("2026-09-04T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sin chip cuando la conversación no está esperando respuesta", () => {
    const { container } = renderItem({
      // La respuesta real llegó DESPUÉS del último mensaje del cliente: no espera.
      lastCustomerMessageAt: "2026-09-04T06:00:00.000Z",
      lastReplyAt: "2026-09-04T07:00:00.000Z",
    });
    expect(container.querySelector(".crm-thread-window")).toBeNull();
  });

  it("píldora neutra con margen de sobra (18 h)", () => {
    // Hace 6h que escribió el cliente: quedan 18h de las 24h de la ventana.
    const { container } = renderItem({
      lastCustomerMessageAt: "2026-09-04T06:00:00.000Z",
      lastReplyAt: null,
    });
    const chip = container.querySelector(".crm-thread-window");
    expect(chip).toHaveAttribute("data-urgency", "neutral");
    expect(chip).toHaveTextContent("18 h");
  });

  it("píldora ámbar bajo las 4h (3 h)", () => {
    // Hace 21h que escribió el cliente: quedan 3h antes de que Meta cierre la ventana.
    const { container } = renderItem({
      lastCustomerMessageAt: "2026-09-03T15:00:00.000Z",
      lastReplyAt: null,
    });
    const chip = container.querySelector(".crm-thread-window");
    expect(chip).toHaveAttribute("data-urgency", "warning");
    expect(chip).toHaveTextContent("3 h");
  });

  it("píldora roja cuando la ventana ya cerró", () => {
    // Hace 25h que escribió el cliente: la ventana de 24h ya cerró.
    const { container } = renderItem({
      lastCustomerMessageAt: "2026-09-03T11:00:00.000Z",
      lastReplyAt: null,
    });
    const chip = container.querySelector(".crm-thread-window");
    expect(chip).toHaveAttribute("data-urgency", "danger");
    expect(chip).toHaveTextContent("cerrada");
  });
});

describe("menú contextual de la conversación", () => {
  it("el click derecho pide el menú en vez del menú del navegador", () => {
    let asked = 0;
    render(
      <ConversationListItem
        conversation={buildConversation()}
        isSelected={false}
        onSelect={() => {}}
        onOpenMenu={() => { asked += 1; }}
      />
    );

    fireEvent.contextMenu(screen.getByRole("button"));

    expect(asked).toBe(1);
  });
});

/**
 * T2.2 (5/9/2026): el pin es solo un adorno junto al nombre -- el orden
 * (fijadas primero) lo decide `applyInboxFilters` (inbox-filters.ts), no
 * este componente.
 */
describe("ConversationListItem — indicador de fijada", () => {
  it("no pinta el ícono cuando no está fijada", () => {
    renderItem({}, { isPinned: false });
    expect(screen.queryByLabelText("Fijada")).not.toBeInTheDocument();
  });

  it("pinta el ícono junto al nombre cuando está fijada", () => {
    renderItem({}, { isPinned: true });
    expect(screen.getByLabelText("Fijada")).toBeInTheDocument();
  });
});
