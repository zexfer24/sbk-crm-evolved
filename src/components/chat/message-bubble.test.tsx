import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AudioContent } from "@/components/chat/message-bubble";

const AUDIO_URL = "https://example.com/nota-de-voz.ogg";

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
