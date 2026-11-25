/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BcvRateChip } from "@/components/inbox/bcv-rate-chip";

// 18/11/2026 6:00 p. m. en Caracas (UTC-4) = 22:00 UTC.
const DESDE = "2026-11-18T22:00:00.000Z";

const BASE = { rate: 791.3248, rateDate: "2026-11-18", isStale: false };

describe("BcvRateChip", () => {
  it("sin alerta queda como siempre: sin data-alerta y con la fecha de la tasa", () => {
    const { container } = render(<BcvRateChip rate={BASE} />);
    const chip = container.querySelector(".crm-bcv")!;

    expect(chip.hasAttribute("data-alerta")).toBe(false);
    expect(chip.querySelector(".crm-bcv-date")?.textContent).toBe("18 nov.");
    expect(chip.getAttribute("title")).toBe("Tasa oficial del BCV vigente desde el 18 nov..");
  });

  it("con alerta null tampoco cambia nada", () => {
    const { container } = render(<BcvRateChip rate={{ ...BASE, alerta: null }} />);
    expect(container.querySelector(".crm-bcv")?.hasAttribute("data-alerta")).toBe(false);
  });

  it("con alerta y fecha: conserva el número, dice desde cuándo y el title trae el último error", () => {
    const { container } = render(
      <BcvRateChip rate={{ ...BASE, alerta: { desde: DESDE, ultimoError: "certificado vencido" } }} />
    );
    const chip = container.querySelector(".crm-bcv")!;

    expect(chip.getAttribute("data-alerta")).toBe("true");
    expect(chip.querySelector(".crm-bcv-rate")?.textContent).toBe("791,32");
    expect(chip.querySelector(".crm-bcv-date")?.textContent).toContain("sin actualizar desde 18 nov.");
    expect(chip.getAttribute("title")).toContain("Tasa BCV sin actualizar desde 18 nov.");
    expect(chip.getAttribute("title")).toContain("Último error: certificado vencido");
    expect(screen.getByLabelText(/Tasa sin actualizar desde 18 nov\./)).toBe(chip);
  });

  it("sin último error el title omite esa parte", () => {
    const { container } = render(<BcvRateChip rate={{ ...BASE, alerta: { desde: DESDE, ultimoError: null } }} />);
    expect(container.querySelector(".crm-bcv")?.getAttribute("title")).not.toContain("Último error");
  });

  it("con alerta y desde null dice solo «sin actualizar»", () => {
    const { container } = render(<BcvRateChip rate={{ ...BASE, alerta: { desde: null, ultimoError: "x" } }} />);
    const chip = container.querySelector(".crm-bcv")!;

    expect(chip.querySelector(".crm-bcv-date")?.textContent).toBe("sin actualizar");
    expect(chip.getAttribute("aria-label")).toBe("Tasa sin actualizar");
  });
});
