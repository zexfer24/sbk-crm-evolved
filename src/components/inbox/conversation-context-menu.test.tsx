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
