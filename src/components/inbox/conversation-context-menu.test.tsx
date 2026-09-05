/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConversationContextMenu } from "@/components/inbox/conversation-context-menu";

function renderMenu(over: Partial<Parameters<typeof ConversationContextMenu>[0]> = {}) {
  const props = {
    position: { x: 120, y: 80 },
    isUnread: false,
    onMarkUnread: vi.fn(),
    onMarkRead: vi.fn(),
    onClose: vi.fn(),
    isConversationClosed: false,
    onCloseConversation: vi.fn(),
    onReopenConversation: vi.fn(),
    isPinned: false,
    pinLimitReached: false,
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    ...over,
  };
  render(<ConversationContextMenu {...props} />);
  return props;
}

describe("ConversationContextMenu", () => {
  it("ofrece apartar el chat cuando está leído", () => {
    renderMenu({ isUnread: false });
    expect(screen.getByRole("menuitem", { name: /marcar como no leído/i })).toBeInTheDocument();
  });

  it("ofrece lo contrario cuando el chat ya está sin leer", () => {
    renderMenu({ isUnread: true });
    expect(screen.getByRole("menuitem", { name: /marcar como leído/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /marcar como no leído/i })).not.toBeInTheDocument();
  });

  it("ejecuta la acción elegida y se cierra detrás", () => {
    const props = renderMenu({ isUnread: false });

    fireEvent.click(screen.getByRole("menuitem", { name: /marcar como no leído/i }));

    expect(props.onMarkUnread).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("se cierra con Escape sin ejecutar nada", () => {
    const props = renderMenu();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onMarkUnread).not.toHaveBeenCalled();
  });

  it("se cierra al tocar fuera", () => {
    const props = renderMenu();

    fireEvent.pointerDown(document.body);

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("no se cierra al tocar dentro del propio menú", () => {
    const props = renderMenu();

    fireEvent.pointerDown(screen.getByRole("menu"));

    expect(props.onClose).not.toHaveBeenCalled();
  });
});

/**
 * T2.1 (5/9/2026): "Cerrar conversación" cuando está abierta, "Reabrir"
 * cuando ya está cerrada — nunca las dos a la vez.
 */
describe("ConversationContextMenu — cerrar y reabrir", () => {
  it("ofrece cerrar la conversación cuando está abierta", () => {
    renderMenu({ isConversationClosed: false });

    expect(screen.getByRole("menuitem", { name: /cerrar conversación/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /reabrir conversación/i })).not.toBeInTheDocument();
  });

  it("ofrece reabrir en vez de cerrar cuando ya está cerrada", () => {
    renderMenu({ isConversationClosed: true });

    expect(screen.getByRole("menuitem", { name: /reabrir conversación/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /cerrar conversación/i })).not.toBeInTheDocument();
  });

  it("ejecuta cerrar y se cierra detrás", () => {
    const props = renderMenu({ isConversationClosed: false });

    fireEvent.click(screen.getByRole("menuitem", { name: /cerrar conversación/i }));

    expect(props.onCloseConversation).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("ejecuta reabrir y se cierra detrás", () => {
    const props = renderMenu({ isConversationClosed: true });

    fireEvent.click(screen.getByRole("menuitem", { name: /reabrir conversación/i }));

    expect(props.onReopenConversation).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("sin el callback correspondiente, no ofrece ni cerrar ni reabrir", () => {
    renderMenu({ isConversationClosed: false, onCloseConversation: undefined, onReopenConversation: undefined });

    expect(screen.queryByRole("menuitem", { name: /cerrar conversación/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /reabrir conversación/i })).not.toBeInTheDocument();
  });
});

/**
 * T2.2 (5/9/2026): "Fijar"/"Desfijar" (hasta tres chats fijados por asesor,
 * `conversation_pins`). Mismo patrón que cerrar/reabrir: nunca las dos
 * acciones a la vez, y sin el callback correspondiente el menú no la ofrece.
 */
describe("ConversationContextMenu — fijar y desfijar", () => {
  it("ofrece fijar cuando la conversación no está fijada", () => {
    renderMenu({ isPinned: false });

    expect(screen.getByRole("menuitem", { name: /^fijar$/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /desfijar/i })).not.toBeInTheDocument();
  });

  it("ofrece desfijar en vez de fijar cuando ya está fijada", () => {
    renderMenu({ isPinned: true });

    expect(screen.getByRole("menuitem", { name: /desfijar/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^fijar$/i })).not.toBeInTheDocument();
  });

  it("ejecuta fijar y se cierra detrás", () => {
    const props = renderMenu({ isPinned: false });

    fireEvent.click(screen.getByRole("menuitem", { name: /^fijar$/i }));

    expect(props.onPin).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("ejecuta desfijar y se cierra detrás", () => {
    const props = renderMenu({ isPinned: true });

    fireEvent.click(screen.getByRole("menuitem", { name: /desfijar/i }));

    expect(props.onUnpin).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("con el tope de tres alcanzado, 'Fijar' se deshabilita en vez de esconderse", () => {
    renderMenu({ isPinned: false, pinLimitReached: true });

    const item = screen.getByRole("menuitem", { name: /^fijar$/i });
    expect(item).toBeDisabled();
  });

  it("sin el callback correspondiente, no ofrece ni fijar ni desfijar", () => {
    renderMenu({ isPinned: false, onPin: undefined, onUnpin: undefined });

    expect(screen.queryByRole("menuitem", { name: /^fijar$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /desfijar/i })).not.toBeInTheDocument();
  });
});
