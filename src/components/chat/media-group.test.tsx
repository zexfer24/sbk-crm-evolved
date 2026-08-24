import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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
