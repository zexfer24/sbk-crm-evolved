import { describe, expect, it } from "vitest";
import { formatWindowRemaining } from "./window-countdown-format";

describe("formatWindowRemaining", () => {
  it.each([
    // [horas restantes, horas esperadas, minutos esperados, motivo]
    [23 + 59 / 60 + 40 / 3600, 24, 0, "23h 59m 40s redondea a 24h 0m, nunca 23h 60m (C2, 5/9/2026)"],
    [0, 0, 0, "sin tiempo restante"],
    [20 / 3600, 0, 0, "20s restantes redondean a 0h 0m"],
    [24, 24, 0, "borde exacto de 24h"],
    [1.5, 1, 30, "media hora se ve entera"],
    [29 / 3600, 0, 0, "29s restantes redondean hacia abajo a 0 minutos"],
    [31 / 3600, 0, 1, "31s restantes redondean hacia arriba a 1 minuto"],
  ])("con %f horas restantes -> %ih %im (%s)", (hoursRemaining, expectedHours, expectedMinutes) => {
    expect(formatWindowRemaining(hoursRemaining)).toEqual({ hours: expectedHours, minutes: expectedMinutes });
  });
});
