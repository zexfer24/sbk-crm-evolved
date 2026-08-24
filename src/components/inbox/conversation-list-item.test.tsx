import { describe, expect, it } from "vitest";
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

function renderItem(overrides: Partial<Conversation> = {}) {
  return render(
    <ConversationListItem
      conversation={buildConversation(overrides)}
      isSelected={false}
      onSelect={() => {}}
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
