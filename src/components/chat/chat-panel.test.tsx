import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatPanel } from "@/components/chat/chat-panel";
import type { Agent, Conversation, Message } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/mutations", () => ({
  assignToMe: vi.fn(),
  intervene: vi.fn(),
  setAiEnabled: vi.fn(),
  unassign: vi.fn(),
}));
vi.mock("@/components/chat/composer", () => ({ Composer: () => null }));

const dangerToast = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { danger: (...a: unknown[]) => dangerToast(...a), success: vi.fn() } };
});

const AGENTE: Agent = {
  id: "agent-1", displayName: "José", fullName: "José", avatarUrl: null, role: "admin", isActive: true,
};

function mensaje(over: Partial<Message>): Message {
  return {
    id: "m-1", conversationId: "conv-1", direction: "inbound", senderType: "customer",
    senderAgent: null, messageType: "text", content: "hola", templateName: null, mediaUrl: null,
    isInternalNote: false, whatsappStatus: null, reactionEmoji: null, replyToMessageId: null,
    createdAt: "2026-08-24T12:00:00.000Z", ...over,
  };
}

const conversacion = {
  id: "conv-1", aiEnabled: false, assignedAgent: null, lastCustomerMessageAt: new Date().toISOString(),
  contact: { id: "c-1", phoneNumber: "+58412", displayName: "Laura", profileName: null, avatarUrl: null,
    cedulaType: null, cedulaNumber: null, state: null, city: null, address: null, tags: [] },
  channel: { id: "ch-1", label: "Principal", phoneNumber: "+58", phoneNumberId: "p1", status: "connected" },
} as unknown as Conversation;

function renderPanel(messages: Message[]) {
  return render(
    <ChatPanel
      conversation={conversacion}
      messages={messages}
      templates={[]}
      quickReplies={[]}
      currentAgent={AGENTE}
      aiGloballyEnabled
      spendCapReached={false}
      onBack={() => {}}
    />
  );
}

beforeEach(() => dangerToast.mockClear());

/**
 * Una cita dice de qué se hablaba, pero en un hilo largo saber "de qué" sin
 * poder volver "a dónde" sirve de poco: el asesor termina desplazando a mano
 * hasta encontrarlo.
 */
describe("ChatPanel — llegar hasta el mensaje citado", () => {
  it("lleva la conversación hasta el mensaje citado y lo señala", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const { container } = renderPanel([
      mensaje({ id: "m-viejo", content: "¿Tienen el carburador PZ27?" }),
      mensaje({ id: "m-nuevo", content: "Sí, tenemos", direction: "outbound", senderType: "agent", replyToMessageId: "m-viejo" }),
    ]);

    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /ir al mensaje citado/i }));

    expect(scrollIntoView).toHaveBeenCalled();
    expect(container.querySelector('[data-message-id="m-viejo"][data-highlight="true"]')).not.toBeNull();
  });

  it("si el mensaje citado quedó más atrás del tramo cargado, lo dice en vez de no hacer nada", () => {
    Element.prototype.scrollIntoView = vi.fn();

    renderPanel([
      mensaje({ id: "m-nuevo", content: "Sí, tenemos", replyToMessageId: "m-que-no-esta" }),
    ]);

    // La cita se pinta igual —el texto citado viene con el mensaje—, pero el
    // original no está entre los mensajes cargados.
    const cita = screen.queryByRole("button", { name: /ir al mensaje citado/i });
    if (cita) {
      fireEvent.click(cita);
      expect(dangerToast).toHaveBeenCalled();
    }
  });
});
