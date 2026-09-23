/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AiStatusBanner } from "@/components/chat/ai-status-banner";

function renderBanner(over: Partial<Parameters<typeof AiStatusBanner>[0]> = {}) {
  const props = {
    aiEnabled: true,
    aiGloballyEnabled: true,
    spendCapReached: false,
    waitingForHuman: false,
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

/**
 * T4, "Seba atiende el mostrador" (18/9/2026, D2/D3, requisito 6 del
 * cliente): con la escalada sin apagar la IA, un chat asignado puede seguir
 * respondiendo — pero el texto tiene que distinguirlo de "respuesta
 * automática indefinida" en un chat sin dueño, porque acá se apaga sola en
 * cuanto el asesor escribe su primer mensaje.
 */
describe("AiStatusBanner — waitingForHuman (chat ya asignado, IA encendida)", () => {
  it("con asesor asignado e IA encendida, dice que Seba solo contesta con un escenario armado mientras el asesor no escriba", () => {
    renderBanner({ waitingForHuman: true });
    expect(screen.getByText(/solo contesta con un escenario armado mientras el asesor no escriba/i)).toBeInTheDocument();
    expect(screen.getByText(/se apaga con tu primer mensaje/i)).toBeInTheDocument();
    expect(screen.queryByText(/^La IA sigue respondiendo automáticamente$/)).not.toBeInTheDocument();
  });

  it("sin asesor asignado, sigue con el texto genérico de siempre", () => {
    renderBanner({ waitingForHuman: false });
    expect(screen.getByText(/sigue respondiendo automáticamente/i)).toBeInTheDocument();
    expect(screen.queryByText(/solo contesta con un escenario armado/i)).not.toBeInTheDocument();
  });

  it("waitingForHuman no manda si la IA está pausada en este chat", () => {
    renderBanner({ aiEnabled: false, waitingForHuman: true });
    expect(screen.getByText(/pausada en esta conversación/i)).toBeInTheDocument();
    expect(screen.queryByText(/solo contesta con un escenario armado/i)).not.toBeInTheDocument();
  });

  it("waitingForHuman no manda si el interruptor global está apagado", () => {
    renderBanner({ aiGloballyEnabled: false, waitingForHuman: true });
    expect(screen.getByText(/apagada para todo el crm/i)).toBeInTheDocument();
    expect(screen.queryByText(/solo contesta con un escenario armado/i)).not.toBeInTheDocument();
  });
});
