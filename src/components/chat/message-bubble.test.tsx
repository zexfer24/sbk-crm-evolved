import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AudioContent, MediaContent } from "@/components/chat/message-bubble";
import type { Message } from "@/lib/types";

const AUDIO_URL = "https://example.com/nota-de-voz.ogg";

function baseMessage(overrides: Partial<Message>): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    direction: "inbound",
    senderType: "customer",
    senderAgent: null,
    messageType: "text",
    content: null,
    templateName: null,
    mediaUrl: null,
    isInternalNote: false,
    whatsappStatus: null,
    replyToMessageId: null,
    createdAt: "2026-08-19T23:39:54.000Z",
    ...overrides,
  };
}

describe("MediaContent con mediaUrl nulo (falló la descarga desde WhatsApp)", () => {
  it.each(["image", "video", "sticker", "audio", "document"] as const)(
    "message_type=%s sin media_url muestra un aviso visible en vez de una burbuja vacía",
    (messageType) => {
      render(<MediaContent message={baseMessage({ messageType, mediaUrl: null })} />);
      expect(screen.getByText(/no se pudo recibir/i)).toBeInTheDocument();
    }
  );

  it("mensaje de texto normal (sin media) no muestra ningún aviso", () => {
    const { container } = render(
      <MediaContent message={baseMessage({ messageType: "text", content: "hola", mediaUrl: null })} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AudioContent", () => {
  it("cuando el códec no es soportado (MEDIA_ERR_SRC_NOT_SUPPORTED) muestra un mensaje específico y no ofrece reintentar", () => {
    render(<AudioContent url={AUDIO_URL} />);
    const audio = document.querySelector("audio") as HTMLAudioElement;

    Object.defineProperty(audio, "error", {
      value: { code: 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */ },
      configurable: true,
    });
    fireEvent.error(audio);

    expect(screen.getByText(/este navegador no puede reproducir este audio/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reintentar/i })).not.toBeInTheDocument();
  });

  it("cuando el error es de red (code 2) muestra el mensaje genérico, ofrece reintentar y al hacer click vuelve a intentar cargar", () => {
    render(<AudioContent url={AUDIO_URL} />);
    const audio = document.querySelector("audio") as HTMLAudioElement;

    Object.defineProperty(audio, "error", {
      value: { code: 2 /* MEDIA_ERR_NETWORK */ },
      configurable: true,
    });
    fireEvent.error(audio);

    expect(screen.getByText("No se pudo cargar el audio.")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: /reintentar/i });
    expect(retryButton).toBeInTheDocument();

    fireEvent.click(retryButton);

    expect(screen.queryByText("No se pudo cargar el audio.")).not.toBeInTheDocument();
    expect(document.querySelector("audio")).toBeInTheDocument();
  });

  it("cuando no hay información de error (error undefined) cae en el comportamiento genérico sin fallar", () => {
    render(<AudioContent url={AUDIO_URL} />);
    const audio = document.querySelector("audio") as HTMLAudioElement;

    fireEvent.error(audio);

    expect(screen.getByText("No se pudo cargar el audio.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reintentar/i })).toBeInTheDocument();
  });
});
