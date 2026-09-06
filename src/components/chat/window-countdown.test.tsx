/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WindowCountdown } from "@/components/chat/window-countdown";

/**
 * C2, 5/9/2026: el redondeo de horas y minutos se hacía por separado
 * (Math.floor de las horas, Math.round del resto en minutos) y un restante
 * de 23h 59m 40s mostraba "23h 60m" en vez de "24h 0m". Este test fija el
 * caso borde end-to-end, no solo en la función pura de formato.
 */
describe("WindowCountdown — el redondeo no inventa un minuto 60", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("con 23h 59m 40s restantes muestra 24h 0m, nunca 23h 60m", () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    vi.setSystemTime(now);
    // El cliente escribió hace apenas 20 segundos, así que de las 24h de
    // ventana restan 23h 59m 40s.
    const lastCustomerMessageAt = new Date(now.getTime() - 20_000).toISOString();

    render(<WindowCountdown lastCustomerMessageAt={lastCustomerMessageAt} />);

    expect(screen.getByText(/24h 0m/)).toBeInTheDocument();
    expect(screen.queryByText(/23h 60m/)).not.toBeInTheDocument();
  });
});
