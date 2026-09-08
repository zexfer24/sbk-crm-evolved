/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmojiStickerPopover } from "@/components/chat/emoji-sticker-popover";
import type { Agent, Conversation, Sticker } from "@/lib/types";

/**
 * T3b, "Seis frentes del buzón" (8/9/2026). Ver el mismo criterio en
 * `composer.test.tsx`: `emoji-picker-react` va mockeado a un botón mínimo, no
 * se reprueba la librería acá.
 */

const fetchStickersMock = vi.fn();
const sendStickerMessageMock = vi.fn();
const deleteStickerMock = vi.fn();

vi.mock("@/lib/stickers-data", () => ({
  fetchStickers: (...args: unknown[]) => fetchStickersMock(...args),
}));

vi.mock("@/lib/mutations", () => ({
  sendStickerMessage: (...args: unknown[]) => sendStickerMessageMock(...args),
  deleteSticker: (...args: unknown[]) => deleteStickerMock(...args),
  createSticker: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ fakeClient: true }) }));

vi.mock("emoji-picker-react", () => ({
  default: (props: { onEmojiClick: (data: { emoji: string }) => void }) => (
    <button type="button" onClick={() => props.onEmojiClick({ emoji: "🙂" })}>
      Elegir emoji de prueba
    </button>
  ),
}));

const dangerToast = vi.fn();
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { ...real.toast, danger: (...a: unknown[]) => dangerToast(...a), success: vi.fn() } };
});

const AGENT: Agent = {
  id: "agent-1",
  displayName: "Ana",
  fullName: "Ana Torres",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function buildConversation(): Conversation {
  return {
    id: "conv-1",
    contact: {
      id: "contact-1",
      phoneNumber: "+58123456789",
      displayName: "Cliente",
      profileName: "Cliente",
      avatarUrl: null,
      cedulaType: null,
      cedulaNumber: null,
      state: null,
      city: null,
      address: null,
      tags: [],
    },
    channel: { id: "channel-1", label: "Principal", phoneNumber: "+58000000000", phoneNumberId: "p1", status: "connected" },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: false,
    dealStatus: "none",
    dealClosedAt: null,
    dealPaymentProofUrl: null,
    dealAmount: null,
    dealCurrency: null,
    dealVerified: false,
    dealVerifiedAt: null,
    dealVerifiedBy: null,
    dealPaymentMethod: null,
    dealClosedBy: null,
    lastCustomerMessageAt: new Date().toISOString(),
    lastReplyAt: null,
    lastReplySender: null,
    hasReply: false,
    lastMessageAt: new Date().toISOString(),
    lastMessagePreview: null,
    lastMessageDirection: null,
    lastMessageStatus: null,
    createdAt: new Date().toISOString(),
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    referral: null,
  };
}

function buildSticker(over: Partial<Sticker> = {}): Sticker {
  return {
    id: "sticker-1",
    url: "/api/media/stickers/sticker-1.webp",
    name: "Choro",
    animated: false,
    createdBy: "agent-1",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function crearUsuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

function renderPopover(withinWindow = true, onInsertEmoji = vi.fn()) {
  return {
    onInsertEmoji,
    ...render(
      <EmojiStickerPopover
        conversation={buildConversation()}
        withinWindow={withinWindow}
        agent={AGENT}
        onInsertEmoji={onInsertEmoji}
      />
    ),
  };
}

describe("EmojiStickerPopover", () => {
  beforeEach(() => {
    fetchStickersMock.mockReset().mockResolvedValue([]);
    sendStickerMessageMock.mockReset().mockResolvedValue("msg-1");
    deleteStickerMock.mockReset().mockResolvedValue(undefined);
    dangerToast.mockReset();
  });

  it("abre con la pestaña de emojis activa por defecto", async () => {
    const user = crearUsuario();
    renderPopover();

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));

    expect(await screen.findByRole("button", { name: "Elegir emoji de prueba" })).toBeInTheDocument();
    expect(fetchStickersMock).not.toHaveBeenCalled();
  });

  it("elegir un emoji llama a onInsertEmoji con el carácter y cierra el popover", async () => {
    const user = crearUsuario();
    const onInsertEmoji = vi.fn();
    renderPopover(true, onInsertEmoji);

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    await user.click(await screen.findByRole("button", { name: "Elegir emoji de prueba" }));

    expect(onInsertEmoji).toHaveBeenCalledWith("🙂");
    expect(screen.queryByRole("dialog", { name: "Emojis y stickers" })).not.toBeInTheDocument();
  });

  it("Escape cierra el popover", async () => {
    const user = crearUsuario();
    renderPopover();

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    expect(screen.getByRole("dialog", { name: "Emojis y stickers" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Emojis y stickers" })).not.toBeInTheDocument();
  });

  it("clic afuera cierra el popover", async () => {
    const user = crearUsuario();
    render(
      <div>
        <EmojiStickerPopover conversation={buildConversation()} withinWindow agent={AGENT} onInsertEmoji={vi.fn()} />
        <button type="button">Afuera</button>
      </div>
    );

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    expect(screen.getByRole("dialog", { name: "Emojis y stickers" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Afuera" }));

    expect(screen.queryByRole("dialog", { name: "Emojis y stickers" })).not.toBeInTheDocument();
  });

  it("la pestaña de stickers pide fetchStickers al activarse, no al abrir el popover", async () => {
    fetchStickersMock.mockResolvedValue([buildSticker()]);
    const user = crearUsuario();
    renderPopover();

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    expect(fetchStickersMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: "Stickers" }));

    await waitFor(() => expect(fetchStickersMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: 'Enviar sticker "Choro"' })).toBeInTheDocument();
  });

  it("sin stickers guardados, muestra el estado vacío con las dos formas de conseguir uno", async () => {
    const user = crearUsuario();
    renderPopover();

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    await user.click(screen.getByRole("tab", { name: "Stickers" }));

    expect(
      await screen.findByText(/todavía no hay stickers guardados/i)
    ).toBeInTheDocument();
  });

  it("clic en un sticker lo manda y cierra el popover", async () => {
    fetchStickersMock.mockResolvedValue([buildSticker()]);
    const user = crearUsuario();
    renderPopover();

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    await user.click(screen.getByRole("tab", { name: "Stickers" }));
    await user.click(await screen.findByRole("button", { name: 'Enviar sticker "Choro"' }));

    await waitFor(() => expect(sendStickerMessageMock).toHaveBeenCalledWith("conv-1", buildSticker().url));
    expect(screen.queryByRole("dialog", { name: "Emojis y stickers" })).not.toBeInTheDocument();
  });

  it("con la ventana cerrada, no manda el sticker y avisa por qué", async () => {
    fetchStickersMock.mockResolvedValue([buildSticker()]);
    const user = crearUsuario();
    renderPopover(false);

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    await user.click(screen.getByRole("tab", { name: "Stickers" }));

    expect(screen.getByText(/han pasado más de 24 h/i)).toBeInTheDocument();
    const enviar = await screen.findByRole("button", { name: 'Enviar sticker "Choro"' });
    expect(enviar).toBeDisabled();
    expect(sendStickerMessageMock).not.toHaveBeenCalled();
  });

  it("quitar un sticker pide confirmación y, al aceptar, llama a deleteSticker y lo saca de la rejilla", async () => {
    // Capturado en una variable y no llamado de nuevo en la aserción:
    // `buildSticker()` trae `createdAt: new Date().toISOString()`, así que
    // dos llamadas seguidas no son el mismo objeto.
    const stickerDeLaLista = buildSticker();
    fetchStickersMock.mockResolvedValue([stickerDeLaLista]);
    const user = crearUsuario();
    renderPopover();

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    await user.click(screen.getByRole("tab", { name: "Stickers" }));
    await user.click(await screen.findByRole("button", { name: 'Quitar sticker "Choro" de la biblioteca' }));

    expect(deleteStickerMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Quitar" }));

    await waitFor(() =>
      expect(deleteStickerMock).toHaveBeenCalledWith(expect.objectContaining({ fakeClient: true }), stickerDeLaLista)
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: 'Enviar sticker "Choro"' })).not.toBeInTheDocument()
    );
  });

  it("cancelar la confirmación no borra nada", async () => {
    fetchStickersMock.mockResolvedValue([buildSticker()]);
    const user = crearUsuario();
    renderPopover();

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    await user.click(screen.getByRole("tab", { name: "Stickers" }));
    await user.click(await screen.findByRole("button", { name: 'Quitar sticker "Choro" de la biblioteca' }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(deleteStickerMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: 'Enviar sticker "Choro"' })).toBeInTheDocument();
  });

  it("si la RLS rechaza el borrado, avisa que solo el dueño o un supervisor puede quitarlo", async () => {
    fetchStickersMock.mockResolvedValue([buildSticker()]);
    deleteStickerMock.mockRejectedValue(new Error("new row violates row-level security policy"));
    const user = crearUsuario();
    renderPopover();

    await user.click(screen.getByRole("button", { name: "Emojis y stickers" }));
    await user.click(screen.getByRole("tab", { name: "Stickers" }));
    await user.click(await screen.findByRole("button", { name: 'Quitar sticker "Choro" de la biblioteca' }));
    await user.click(screen.getByRole("button", { name: "Quitar" }));

    await waitFor(() =>
      expect(dangerToast).toHaveBeenCalledWith("Solo quien lo guardó o un supervisor puede quitarlo")
    );
    // El sticker sigue en la rejilla: el borrado falló, no hay que fingir que se fue.
    expect(screen.getByRole("button", { name: 'Enviar sticker "Choro"' })).toBeInTheDocument();
  });
});
