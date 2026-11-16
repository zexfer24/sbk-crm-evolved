/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MediaReading } from "@/components/chat/media-reading";
import type { MessageReading } from "@/lib/types";

describe("MediaReading — Ver más / Ver menos", () => {
  // jsdom no calcula layout: se definen las medidas a mano y se restauran.
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const originalClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

  function medidas(scroll: number, client: number) {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scroll });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => client });
  }

  afterEach(() => {
    for (const [prop, desc] of [
      ["scrollHeight", originalScroll],
      ["clientHeight", originalClient],
    ] as const) {
      if (desc) Object.defineProperty(HTMLElement.prototype, prop, desc);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  });

  const audio: MessageReading = {
    kind: "audio",
    status: "ok",
    text: "Una transcripción larga de una nota de voz",
    fields: null,
    createdAt: "2026-11-16T15:00:00.000Z",
  };

  const imagen: MessageReading = {
    kind: "image",
    status: "ok",
    text: "Un casco negro mate",
    fields: {
      tipo: "producto",
      es_comprobante_pago: false,
      texto_visible: "LS2 FF320",
      producto_visible: null,
      marca_visible: null,
      modelo_moto_visible: null,
      medida_visible: null,
      comprobante: null,
      orden_cashea: null,
    } as unknown as MessageReading["fields"],
    createdAt: "2026-11-16T15:00:00.000Z",
  };

  it("un texto recortado se abre y se vuelve a cerrar", async () => {
    medidas(200, 100);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { container } = render(<MediaReading reading={audio} ahoraMs={Date.parse(audio.createdAt)} />);
    const parrafo = container.querySelector(".crm-reading-text") as HTMLElement;

    const boton = screen.getByRole("button", { name: "Ver más" });
    expect(boton).toHaveAttribute("aria-expanded", "false");
    expect(parrafo).not.toHaveAttribute("data-abierto", "true");

    await user.click(boton);
    expect(parrafo).toHaveAttribute("data-abierto", "true");
    const menos = screen.getByRole("button", { name: "Ver menos" });
    expect(menos).toHaveAttribute("aria-expanded", "true");

    await user.click(menos);
    expect(parrafo).not.toHaveAttribute("data-abierto", "true");
    expect(screen.getByRole("button", { name: "Ver más" })).toHaveAttribute("aria-expanded", "false");
  });

  it("un texto que cabe no muestra ningún botón", () => {
    medidas(100, 100);
    render(<MediaReading reading={audio} ahoraMs={Date.parse(audio.createdAt)} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("descripción y texto visible tienen cada uno su botón, independientes", async () => {
    medidas(200, 100);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { container } = render(<MediaReading reading={imagen} ahoraMs={Date.parse(imagen.createdAt)} />);
    const parrafos = container.querySelectorAll(".crm-reading-text");
    expect(parrafos).toHaveLength(2);
    const botones = screen.getAllByRole("button", { name: "Ver más" });
    expect(botones).toHaveLength(2);

    await user.click(botones[0]);
    expect(parrafos[0]).toHaveAttribute("data-abierto", "true");
    expect(parrafos[1]).not.toHaveAttribute("data-abierto", "true");
  });
});

describe("MediaReading — Leyendo… expira solo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T15:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pendiente = (segundos: number): MessageReading => ({
    kind: "audio",
    status: "pendiente",
    text: null,
    fields: null,
    createdAt: new Date(Date.now() - segundos * 1000).toISOString(),
  });

  it("una pendiente de 110 s deja de mostrarse al avanzar 11 s", async () => {
    render(<MediaReading reading={pendiente(110)} />);
    expect(screen.getByText("Leyendo…")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(11_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("Leyendo…")).not.toBeInTheDocument();
  });

  it("una pendiente de 110 s sigue visible a los 5 s", async () => {
    render(<MediaReading reading={pendiente(110)} />);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(screen.getByText("Leyendo…")).toBeInTheDocument();
  });
});
