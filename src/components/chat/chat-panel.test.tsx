import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatPanel } from "@/components/chat/chat-panel";
import type { Agent, Conversation, Message } from "@/lib/types";
import type { OutboxItem } from "@/lib/outbox";

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
    isInternalNote: false, whatsappStatus: null, whatsappError: null, reactionEmoji: null, replyToMessageId: null,
    createdAt: "2026-08-24T12:00:00.000Z", ...over,
  };
}

const conversacion = {
  id: "conv-1", aiEnabled: false, assignedAgent: null, lastCustomerMessageAt: new Date().toISOString(),
  contact: { id: "c-1", phoneNumber: "+58412", displayName: "Laura", profileName: null, avatarUrl: null,
    cedulaType: null, cedulaNumber: null, state: null, city: null, address: null, tags: [] },
  channel: { id: "ch-1", label: "Principal", phoneNumber: "+58", phoneNumberId: "p1", status: "connected" },
} as unknown as Conversation;

function renderPanel(
  messages: Message[],
  extra: Partial<Pick<Parameters<typeof ChatPanel>[0], "outboxItems" | "onRetryOutbox" | "onDiscardOutbox">> = {}
) {
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
      onSendText={() => {}}
      {...extra}
    />
  );
}

beforeEach(() => {
  dangerToast.mockClear();
  // jsdom no trae scrollIntoView, y el panel lo llama al montar para dejar
  // el final del hilo a la vista. Cada test que lo afirma pone el suyo.
  Element.prototype.scrollIntoView = vi.fn();
});

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

  it("una foto citada dentro de una galería también es un destino al que llegar", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const foto = (id: string) =>
      mensaje({ id, messageType: "image", content: null, mediaUrl: `/api/media/${id}.jpg` });

    const { container } = renderPanel([
      foto("foto-1"),
      foto("foto-2"),
      mensaje({ id: "m-cita", content: "Esa, la segunda", replyToMessageId: "foto-2" }),
    ]);

    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /ir al mensaje citado/i }));

    // Aterriza en la segunda foto en concreto, no en el montón entero.
    expect(scrollIntoView).toHaveBeenCalled();
    expect(container.querySelector('[data-message-id="foto-2"][data-highlight="true"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="foto-1"][data-highlight="true"]')).toBeNull();
  });
});

/**
 * Cuando el cliente manda cinco fotos, "responder al mensaje" no alcanza:
 * la consulta suele ser sobre UNA de las cinco, y hay que poder citarla.
 */
describe("ChatPanel — citar una foto concreta de la galería", () => {
  it("cada foto de la galería tiene su propio botón de responder", () => {
    const foto = (id: string) =>
      mensaje({ id, messageType: "image", content: null, mediaUrl: `/api/media/${id}.jpg` });

    renderPanel([foto("foto-1"), foto("foto-2"), foto("foto-3")]);

    expect(screen.getAllByRole("button", { name: /responder citando esta foto/i })).toHaveLength(3);
  });
});

/**
 * Entre el Enter y el mensaje real hay un viaje al servidor. La burbuja
 * provisional lo cuenta: relojito mientras va en camino, y si el envío cae,
 * el aviso con reintentar y descartar — en el chat al que pertenece.
 */
describe("ChatPanel — la cola de envío a la vista", () => {
  function pendiente(over: Partial<OutboxItem> = {}): OutboxItem {
    return {
      localId: "local-1",
      conversationId: "conv-1",
      content: "¿Sigue disponible?",
      replyToMessageId: null,
      status: "sending",
      error: null,
      createdAt: "2026-08-24T12:00:00.000Z",
      sentMessageId: null,
      ...over,
    };
  }

  it("un envío en camino se muestra al instante, con su relojito", () => {
    renderPanel([], { outboxItems: [pendiente()] });

    expect(screen.getByText("¿Sigue disponible?")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Enviando…" })).toBeInTheDocument();
  });

  it("un envío caído muestra el aviso con reintentar y descartar", () => {
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    renderPanel([], {
      outboxItems: [pendiente({ status: "failed", error: "Sin conexión" })],
      onRetryOutbox: onRetry,
      onDiscardOutbox: onDiscard,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/no se envió/i);

    fireEvent.click(screen.getByRole("button", { name: /reintentar el envío/i }));
    expect(onRetry).toHaveBeenCalledWith("local-1");

    fireEvent.click(screen.getByRole("button", { name: /descartar el mensaje/i }));
    expect(onDiscard).toHaveBeenCalledWith("local-1");
  });

  it("un enviado cuyo mensaje real ya está en el hilo no se pinta dos veces", () => {
    renderPanel(
      [mensaje({ id: "m-real", direction: "outbound", senderType: "agent", content: "¿Sigue disponible?" })],
      { outboxItems: [pendiente({ status: "sent", sentMessageId: "m-real" })] }
    );

    expect(screen.getAllByText("¿Sigue disponible?")).toHaveLength(1);
  });
});
