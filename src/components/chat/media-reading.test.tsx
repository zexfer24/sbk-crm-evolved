/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MediaReading } from "@/components/chat/media-reading";
import type { MessageReading } from "@/lib/types";

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
