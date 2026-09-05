/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChannelHealthPanel } from "@/components/agent-control/channel-health-panel";
import type { WhatsappChannelHealth } from "@/lib/types";

function health(patch: Partial<WhatsappChannelHealth> = {}): WhatsappChannelHealth {
  return {
    id: "chan-1",
    label: "Principal",
    qualityRating: null,
    messagingLimit: null,
    accountRestrictions: null,
    healthUpdatedAt: null,
    ...patch,
  };
}

describe("ChannelHealthPanel", () => {
  /**
   * T3.4: hasta que no llegue el primer webhook de calidad/cuenta, la
   * tarjeta dice "sin datos" en vez de fingir un estado — ni siquiera con el
   * canal ya creado (health no es null, solo sus campos lo son).
   */
  it("sin ningún webhook todavía, muestra 'sin datos' en calidad, límite y fecha", () => {
    render(<ChannelHealthPanel health={health()} />);

    expect(screen.getByText("Sin datos todavía")).toBeInTheDocument();
    const badges = screen.getAllByText("Sin datos");
    expect(badges.length).toBeGreaterThan(0);
  });

  it("null (ningún canal creado) se comporta igual que sin datos", () => {
    render(<ChannelHealthPanel health={null} />);

    expect(screen.getByText("Sin datos todavía")).toBeInTheDocument();
  });

  it("calidad RED se pinta como 'Degradada' con el límite traducido", () => {
    render(
      <ChannelHealthPanel
        health={health({
          qualityRating: "RED",
          messagingLimit: "TIER_1K",
          healthUpdatedAt: "2026-09-05T12:00:00.000Z",
        })}
      />
    );

    expect(screen.getByText("Degradada")).toBeInTheDocument();
    expect(screen.getByText("1.000 conversaciones/día")).toBeInTheDocument();
    expect(screen.queryByText("Sin datos todavía")).not.toBeInTheDocument();
  });

  it("una restricción de cuenta muestra el aviso", () => {
    render(
      <ChannelHealthPanel
        health={health({
          healthUpdatedAt: "2026-09-05T12:00:00.000Z",
          accountRestrictions: {
            ban_info: null,
            restriction_info: [{ restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING" }],
          },
        })}
      />
    );

    expect(screen.getByText(/Meta reportó una restricción de cuenta/)).toBeInTheDocument();
  });

  it("sin restricciones, no muestra el aviso", () => {
    render(
      <ChannelHealthPanel
        health={health({ healthUpdatedAt: "2026-09-05T12:00:00.000Z", qualityRating: "GREEN" })}
      />
    );

    expect(screen.queryByText(/restricción de cuenta/)).not.toBeInTheDocument();
    expect(screen.getByText("Buena")).toBeInTheDocument();
  });
});
