import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MediaGroup } from "@/components/chat/media-group";
import type { Message, MessageType } from "@/lib/types";

let reloj = 0;

function media(over: Partial<Message> & { messageType?: MessageType } = {}): Message {
  reloj += 1000;
  return {
    id: `m-${reloj}`,
    conversationId: "conv-1",
    direction: "inbound",
    senderType: "customer",
    senderAgent: null,
    messageType: "image",
    content: null,
    templateName: null,
    mediaUrl: `/api/media/foto-${reloj}.jpg`,
    isInternalNote: false,
    whatsappStatus: null,
    whatsappError: null,
    reactionEmoji: null,
    replyToMessageId: null,
    createdAt: "2026-08-24T12:00:00.000Z",
    ...over,
  };
}

describe("MediaGroup — cuántas fotos mandó el cliente", () => {
  it("dice el total en fotos, no en 'archivos', cuando todas son fotos", () => {
    render(<MediaGroup messages={[media(), media(), media()]} />);
    expect(screen.getByText(/3 fotos/)).toBeInTheDocument();
  });

  it("cuenta las que todavía están bajando dentro del total", () => {
    render(<MediaGroup messages={[media(), media({ mediaUrl: null }), media({ mediaUrl: null })]} />);
    expect(screen.getByText(/3 fotos/)).toBeInTheDocument();
  });

  it("avisa cuántas vienen en camino en vez de darlas por perdidas", () => {
    render(<MediaGroup messages={[media(), media({ mediaUrl: null }), media({ mediaUrl: null })]} />);
    expect(screen.getByText(/2 en camino/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/no se pudo cargar/i)).not.toBeInTheDocument();
  });

  it("con fotos y videos mezclados habla de archivos", () => {
    render(<MediaGroup messages={[media(), media({ messageType: "video" })]} />);
    expect(screen.getByText(/2 archivos/)).toBeInTheDocument();
  });

  it("cuando son todos videos lo dice", () => {
    render(<MediaGroup messages={[media({ messageType: "video" }), media({ messageType: "video" })]} />);
    expect(screen.getByText(/2 videos/)).toBeInTheDocument();
  });
});

/**
 * Cuando el cliente manda varias fotos, la galería reemplaza a las burbujas
 * sueltas. Si el menú solo viviera en la burbuja, copiar una foto dejaría de
 * funcionar justo en el caso más común: el de varias fotos.
 */
describe("MediaGroup — click derecho sobre una foto de la galería", () => {
  it("ofrece copiar esa foto", () => {
    render(<MediaGroup messages={[media(), media()]} />);

    const fotos = screen.getAllByRole("button", { name: /ver la foto/i });
    fireEvent.contextMenu(fotos[1]);

    expect(screen.getByRole("menuitem", { name: /copiar (la )?imagen/i })).toBeInTheDocument();
  });

  it("no ofrece menú sobre una foto que todavía está bajando", () => {
    render(<MediaGroup messages={[media(), media({ mediaUrl: null })]} />);

    fireEvent.contextMenu(screen.getByLabelText("Archivo en camino"));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

/**
 * Responder a "las cinco fotos" no alcanza: la consulta del cliente suele ser
 * sobre UNA, y la cita tiene que apuntar a esa. El menú de cada miniatura
 * responde citando esa foto en concreto, no la primera del montón.
 */
describe("MediaGroup — citar una foto concreta", () => {
  it("el menú de la segunda foto cita a la segunda, no a la primera", () => {
    const onReply = vi.fn();
    const fotos = [media(), media(), media()];
    render(<MediaGroup messages={fotos} onReply={onReply} />);

    const thumbs = screen.getAllByRole("button", { name: /ver la foto/i });
    fireEvent.contextMenu(thumbs[1]);
    fireEvent.click(screen.getByRole("menuitem", { name: /responder/i }));

    expect(onReply).toHaveBeenCalledWith(fotos[1]);
  });

  it("cada foto lleva su data-message-id, para que una cita pueda aterrizar en ella", () => {
    const fotos = [media(), media()];
    const { container } = render(<MediaGroup messages={fotos} />);

    for (const foto of fotos) {
      expect(container.querySelector(`[data-message-id="${foto.id}"]`)).not.toBeNull();
    }
  });
});
