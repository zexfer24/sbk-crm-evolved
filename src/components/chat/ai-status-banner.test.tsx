/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AiStatusBanner } from "@/components/chat/ai-status-banner";

function renderBanner(over: Partial<Parameters<typeof AiStatusBanner>[0]> = {}) {
  const props = {
    aiEnabled: true,
    aiGloballyEnabled: true,
    spendCapReached: false,
    isIntervening: false,
    onIntervene: vi.fn(),
    onToggleAi: vi.fn(),
    ...over,
  };
  render(<AiStatusBanner {...props} />);
  return props;
}

/**
 * El cartel es la única señal visible de si la IA está contestando. Si dice
 * que responde cuando no responde, el asesor deja de atender un chat creyendo
 * que ya está cubierto — y el cliente se queda esperando.
 */
describe("AiStatusBanner — dice la verdad sobre si la IA responde", () => {
  it("con todo encendido, avisa de que la IA está respondiendo", () => {
    renderBanner();
    expect(screen.getByText(/sigue respondiendo/i)).toBeInTheDocument();
  });

  it("con el interruptor global apagado, no dice que responde", () => {
    renderBanner({ aiGloballyEnabled: false });
    expect(screen.queryByText(/sigue respondiendo/i)).not.toBeInTheDocument();
    expect(screen.getByText(/apagada para todo el crm/i)).toBeInTheDocument();
  });

  it("el interruptor global manda aunque la conversación tenga la IA activada", () => {
    renderBanner({ aiEnabled: true, aiGloballyEnabled: false });
    expect(screen.queryByText(/sigue respondiendo/i)).not.toBeInTheDocument();
  });

  it("con el tope de gasto alcanzado, lo dice en vez de dar a entender que responde", () => {
    renderBanner({ spendCapReached: true });
    expect(screen.queryByText(/sigue respondiendo/i)).not.toBeInTheDocument();
    expect(screen.getByText(/tope de gasto/i)).toBeInTheDocument();
  });

  it("pausada solo en esta conversación, lo distingue del apagado general", () => {
    renderBanner({ aiEnabled: false });
    expect(screen.getByText(/pausada en esta conversación/i)).toBeInTheDocument();
  });

  it("reactivar la conversación con el global apagado avisa de que no alcanza", () => {
    renderBanner({ aiEnabled: false, aiGloballyEnabled: false });
    // Se puede reactivar el hilo, pero el asesor tiene que saber que con eso
    // solo no va a contestar nadie.
    expect(screen.getByText(/apagada para todo el crm/i)).toBeInTheDocument();
  });
});
