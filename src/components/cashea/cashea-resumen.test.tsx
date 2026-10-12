/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CASHEA, bsDeCents, calcularCashea, formatBs, formatUsd } from "@/lib/cashea";
import { CasheaResumen } from "@/components/cashea/cashea-resumen";

// $218,00 N4 sin bajada, 6 cuotas: inicial $54,50 y financiado $163,50, que en
// 6 cuotas deja seis cuotas exactas de $27,25 (sin nota de "la última").
const plan = calcularCashea({ montoCents: 21800, nivel: 4, cuotas: 6, bajada: false });

describe("CasheaResumen", () => {
  it("muestra inicial, cuotas y financiado con dólares y bolívares", () => {
    render(<CasheaResumen plan={plan} bcvRate={100} />);
    const bs = (cents: number) => formatBs(bsDeCents(cents, 100)!);

    expect(screen.getByText("Inicial (25%)")).toBeInTheDocument();
    expect(screen.getByText(`${formatUsd(plan.inicialCents)} · ${bs(plan.inicialCents)}`)).toBeInTheDocument();

    expect(screen.getByText("Cuotas")).toBeInTheDocument();
    expect(
      screen.getByText(`6 cuotas de ${formatUsd(plan.cuotaCents)} · ${bs(plan.cuotaCents)}`),
    ).toBeInTheDocument();

    expect(screen.getByText("Financiado")).toBeInTheDocument();
    expect(screen.getByText(formatUsd(plan.financiadoCents))).toBeInTheDocument();
  });

  it("textos exactos del caso de referencia", () => {
    render(<CasheaResumen plan={plan} bcvRate={100} />);
    expect(screen.getByText("$54,50 · Bs. 5.450,00")).toBeInTheDocument();
    expect(screen.getByText("6 cuotas de $27,25 · Bs. 2.725,00")).toBeInTheDocument();
    expect(screen.getByText("$163,50")).toBeInTheDocument();
  });

  it("siempre dice cada cuántos días y que no hay intereses, con los días de CASHEA", () => {
    render(<CasheaResumen plan={plan} bcvRate={100} />);
    expect(screen.getByText(new RegExp(`cada ${CASHEA.DIAS_ENTRE_CUOTAS} días, sin intereses`))).toBeInTheDocument();
  });

  it("sin tasa no aparece ninguna parte en bolívares", () => {
    const { container } = render(<CasheaResumen plan={plan} bcvRate={0} />);
    expect(container.textContent).not.toContain("Bs.");
    expect(screen.getByText("$54,50")).toBeInTheDocument();
    expect(screen.getByText("6 cuotas de $27,25")).toBeInTheDocument();
  });

  it("la nota de la última cuota aparece solo cuando difiere de la base", () => {
    const iguales = calcularCashea({ montoCents: 12000, nivel: 6, cuotas: 3, bajada: false });
    expect(iguales.montosCuotasCents[2]).toBe(iguales.cuotaCents);
    const { unmount } = render(<CasheaResumen plan={iguales} bcvRate={100} />);
    expect(screen.queryByText(/la última de/)).not.toBeInTheDocument();
    unmount();

    const distintas = calcularCashea({ montoCents: 11800, nivel: 4, cuotas: 6, bajada: true });
    const ultima = distintas.montosCuotasCents[5];
    expect(ultima).not.toBe(distintas.cuotaCents);
    render(<CasheaResumen plan={distintas} bcvRate={100} />);
    expect(screen.getByText(new RegExp(`la última de ${formatUsd(ultima).replace("$", "\\$")}`))).toBeInTheDocument();
  });
});
