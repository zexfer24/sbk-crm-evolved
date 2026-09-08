/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MessageContextMenu } from "@/components/chat/message-context-menu";
import type { Agent, Message } from "@/lib/types";

/**
 * T3a ("Seis frentes del buzón", 9/9/2026): "Guardar sticker" en el menú
 * contextual del mensaje. Solo se ofrece con `messageType === "sticker"`,
 * `mediaUrl` presente y un `agent` conocido — sin cualquiera de los tres no
 * hay a quién atribuirle el guardado ni qué archivo copiar.
 */

const saveStickerFromMessageMock = vi.fn();
vi.mock("@/lib/mutations", () => ({
  saveStickerFromMessage: (...args: unknown[]) => saveStickerFromMessageMock(...args),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ fakeClient: true }) }));

const successToast = vi.fn();
const dangerToast = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: (...a: unknown[]) => successToast(...a), danger: (...a: unknown[]) => dangerToast(...a) } };
});

const AGENT: Agent = {
  id: "agent-1",
  displayName: "Ana",
  fullName: "Ana Torres",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function stickerMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-sticker-1",
    conversationId: "conv-1",
    direction: "inbound",
    senderType: "customer",
    senderAgent: null,
    messageType: "sticker",
    content: null,
    templateName: null,
    mediaUrl: "/api/media/inbound/conv-1/sticker.webp",
    isInternalNote: false,
    whatsappStatus: null,
    whatsappError: null,
    whatsappErrorCode: null,
    reactionEmoji: null,
    replyToMessageId: null,
    payload: null,
    createdAt: "2026-09-09T11:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  saveStickerFromMessageMock.mockReset();
  successToast.mockReset();
  dangerToast.mockReset();
});

describe("MessageContextMenu — Guardar sticker", () => {
  it("con un sticker y un agente conocido, ofrece la opción", () => {
    render(
      <MessageContextMenu position={{ x: 0, y: 0 }} message={stickerMessage()} onClose={vi.fn()} agent={AGENT} />
    );
    expect(screen.getByRole("menuitem", { name: /guardar sticker/i })).toBeInTheDocument();
  });

  it("sin agent no ofrece la opción, aunque el mensaje sea un sticker", () => {
    render(<MessageContextMenu position={{ x: 0, y: 0 }} message={stickerMessage()} onClose={vi.fn()} />);
    expect(screen.queryByRole("menuitem", { name: /guardar sticker/i })).not.toBeInTheDocument();
  });

  it("sobre un mensaje que no es sticker no ofrece la opción", () => {
    render(
      <MessageContextMenu
        position={{ x: 0, y: 0 }}
        message={stickerMessage({ messageType: "image" })}
        onClose={vi.fn()}
        agent={AGENT}
      />
    );
    expect(screen.queryByRole("menuitem", { name: /guardar sticker/i })).not.toBeInTheDocument();
  });

  it("sin mediaUrl (todavía bajando) no ofrece la opción", () => {
    render(
      <MessageContextMenu
        position={{ x: 0, y: 0 }}
        message={stickerMessage({ mediaUrl: null })}
        onClose={vi.fn()}
        agent={AGENT}
      />
    );
    expect(screen.queryByRole("menuitem", { name: /guardar sticker/i })).not.toBeInTheDocument();
  });

  it("al hacer clic llama a la mutación con el mensaje y el agente, y avisa con un toast", async () => {
    saveStickerFromMessageMock.mockResolvedValue({
      id: "sticker-1",
      url: "/api/media/stickers/sticker-1.webp",
      name: null,
      animated: false,
      createdBy: AGENT.id,
      createdAt: "2026-09-09T11:00:01.000Z",
    });
    const onClose = vi.fn();
    const message = stickerMessage();

    render(<MessageContextMenu position={{ x: 0, y: 0 }} message={message} onClose={onClose} agent={AGENT} />);
    fireEvent.click(screen.getByRole("menuitem", { name: /guardar sticker/i }));

    await waitFor(() => expect(successToast).toHaveBeenCalledWith("Sticker guardado"));
    expect(saveStickerFromMessageMock).toHaveBeenCalledWith(expect.objectContaining({ fakeClient: true }), message, AGENT);
    expect(onClose).toHaveBeenCalled();
  });

  it("si la mutación falla, avisa con un toast de error y deja el menú abierto", async () => {
    saveStickerFromMessageMock.mockRejectedValue(new Error("sin permiso"));
    const onClose = vi.fn();

    render(
      <MessageContextMenu position={{ x: 0, y: 0 }} message={stickerMessage()} onClose={onClose} agent={AGENT} />
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /guardar sticker/i }));

    await waitFor(() => expect(dangerToast).toHaveBeenCalledWith("No se pudo guardar el sticker."));
    expect(onClose).not.toHaveBeenCalled();
  });
});
