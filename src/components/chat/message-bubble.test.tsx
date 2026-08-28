/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AudioContent, MediaContent, MessageBubble } from "@/components/chat/message-bubble";
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
    whatsappError: null,
    reactionEmoji: null,
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

describe("MessageBubble — llegar hasta el mensaje citado", () => {
  it("la burbuja lleva su id encima para poder encontrarla en la conversación", () => {
    const { container } = render(<MessageBubble message={baseMessage({ id: "msg-42", content: "hola" })} />);
    expect(container.querySelector('[data-message-id="msg-42"]')).not.toBeNull();
  });

  it("tocar la cita pide ir hasta el mensaje original", () => {
    const onJumpToQuoted = vi.fn();
    const citado = baseMessage({ id: "msg-viejo", content: "¿Tienen el carburador PZ27?" });

    render(
      <MessageBubble
        message={baseMessage({ id: "msg-nuevo", content: "Sí, tenemos", replyToMessageId: "msg-viejo" })}
        repliedMessage={citado}
        onJumpToQuoted={onJumpToQuoted}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /ir al mensaje citado/i }));

    expect(onJumpToQuoted).toHaveBeenCalledWith("msg-viejo");
  });

  it("sin a dónde saltar, la cita no finge ser un botón", () => {
    render(
      <MessageBubble
        message={baseMessage({ content: "Sí", replyToMessageId: "msg-viejo" })}
        repliedMessage={baseMessage({ id: "msg-viejo", content: "¿Hay?" })}
      />
    );
    expect(screen.queryByRole("button", { name: /ir al mensaje citado/i })).not.toBeInTheDocument();
  });
});

describe("MessageBubble — click derecho sobre el mensaje", () => {
  it("ofrece responder, y responder cita ese mensaje", () => {
    const onReply = vi.fn();
    const message = baseMessage({ id: "msg-7", content: "¿Cuánto sale?" });

    render(<MessageBubble message={message} onReply={onReply} />);
    fireEvent.contextMenu(screen.getByText("¿Cuánto sale?"));
    fireEvent.click(screen.getByRole("menuitem", { name: /responder/i }));

    expect(onReply).toHaveBeenCalledWith(message);
  });

  it("sobre una foto ofrece además copiarla", () => {
    render(
      <MessageBubble
        message={baseMessage({ id: "msg-8", messageType: "image", mediaUrl: "/api/media/foto.jpg" })}
        onReply={vi.fn()}
      />
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /ver la foto/i }));

    expect(screen.getByRole("menuitem", { name: /copiar (la )?imagen/i })).toBeInTheDocument();
  });

  it("sobre un mensaje de solo texto no ofrece copiar imagen", () => {
    render(<MessageBubble message={baseMessage({ content: "solo texto" })} onReply={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText("solo texto"));
    expect(screen.queryByRole("menuitem", { name: /copiar (la )?imagen/i })).not.toBeInTheDocument();
  });
});

describe("MessageBubble — en el teléfono no hay click derecho", () => {
  it("mantener el dedo sobre el mensaje abre el mismo menú", () => {
    vi.useFakeTimers();
    try {
      render(<MessageBubble message={baseMessage({ content: "¿Cuánto sale?" })} onReply={vi.fn()} />);

      const burbuja = screen.getByText("¿Cuánto sale?");
      fireEvent.touchStart(burbuja, { touches: [{ clientX: 40, clientY: 120 }] });
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(screen.getByRole("menuitem", { name: /responder/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("un desplazamiento no abre el menú: el dedo estaba pasando, no eligiendo", () => {
    vi.useFakeTimers();
    try {
      render(<MessageBubble message={baseMessage({ content: "¿Cuánto sale?" })} onReply={vi.fn()} />);

      const burbuja = screen.getByText("¿Cuánto sale?");
      fireEvent.touchStart(burbuja, { touches: [{ clientX: 40, clientY: 120 }] });
      fireEvent.touchMove(burbuja);
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MessageBubble — la reacción del cliente", () => {
  it("se ve pegada al mensaje al que reaccionó", () => {
    render(<MessageBubble message={baseMessage({ content: "Te lo dejo en 45$", reactionEmoji: "👍" })} />);

    const reaccion = screen.getByRole("img", { name: /reaccionó con 👍/i });
    expect(reaccion).toHaveTextContent("👍");
  });

  it("un mensaje sin reacción no muestra nada", () => {
    render(<MessageBubble message={baseMessage({ content: "Te lo dejo en 45$" })} />);
    expect(screen.queryByRole("img", { name: /reaccionó con/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// El triángulo rojo que no explicaba nada
//
// El asesor reintentó cinco veces seguidas contra un contacto cuyo número era
// la cadena '+undefined'. No hizo nada raro: un triángulo rojo a secas sugiere
// exactamente una cosa, y es reintentar.
// ---------------------------------------------------------------------------
describe("MessageBubble — un envío que falló dice por qué", () => {
  const fallido = (whatsappError: string | null) =>
    baseMessage({
      direction: "outbound",
      senderType: "agent",
      messageType: "text",
      content: "Buenas, ¿te llegó el pedido?",
      whatsappStatus: "failed",
      whatsappError,
    });

  it("escribe el motivo debajo del mensaje, no sólo en el tooltip", () => {
    render(<MessageBubble message={fallido("El número no está en WhatsApp.")} />);

    expect(screen.getByText("El número no está en WhatsApp.")).toBeInTheDocument();
  });

  /** Que el motivo esté escrito no quita que el icono lo lleve para quien pase por encima. */
  it("el icono de entrega también carga el motivo", () => {
    render(<MessageBubble message={fallido("El número no está en WhatsApp.")} />);

    expect(
      screen.getByLabelText("No se pudo entregar: El número no está en WhatsApp.")
    ).toBeInTheDocument();
  });

  /** Un fallo sin motivo sigue siendo un fallo: el icono no puede desaparecer. */
  it("sin motivo, el icono conserva su etiqueta de siempre", () => {
    render(<MessageBubble message={fallido(null)} />);

    expect(screen.getByLabelText("No se pudo entregar")).toBeInTheDocument();
  });

  it("un mensaje entregado no muestra ningún motivo", () => {
    render(
      <MessageBubble
        message={baseMessage({
          direction: "outbound",
          senderType: "agent",
          content: "Ya te lo aparto.",
          whatsappStatus: "delivered",
          whatsappError: null,
        })}
      />
    );

    expect(screen.getByLabelText("Recibido")).toBeInTheDocument();
    expect(screen.queryByText(/no está en WhatsApp/)).not.toBeInTheDocument();
  });
});
