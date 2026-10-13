/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CASHEA, bsDeCents, calcularCashea, formatBs, formatUsd } from "@/lib/cashea";
import { CasheaResumen } from "@/components/cashea/cashea-resumen";

// $218,00 N4 sin bajada, 6 cuotas: inicial $54,50 y financiado $163,50, que en
// 6 cuotas deja seis cuotas exactas de $27,25 (sin nota de "la última").
const plan = calcularCashea({ montoCents: 21800, nivel: 4, cuotas: 6, bajada: false });

// El valor (dd) de una fila, buscándola por su etiqueta (dt).
function valorDe(etiqueta: string): HTMLElement {
  const dt = screen.getByText(etiqueta, { selector: "dt" });
  return dt.nextElementSibling as HTMLElement;
}

describe("CasheaResumen", () => {
  it("muestra inicial, cada cuota y monto financiado, con los textos de la calculadora", () => {
    render(<CasheaResumen plan={plan} mostrarBs={false} />);
    expect(valorDe("Inicial")).toHaveTextContent("$54,50 (25 %)");
    expect(valorDe("Inicial")).toHaveAttribute("data-testid", "cashea-inicial");
    expect(valorDe("Cada cuota")).toHaveTextContent("$27,25");
    expect(valorDe("Monto financiado")).toHaveTextContent("$163,50");
  });

  it("con mostrarBs y tasa suma los bolívares de inicial y cuota, y no los del financiado", () => {
    render(<CasheaResumen plan={plan} bcvRate={100} />);
    const bs = (cents: number) => formatBs(bsDeCents(cents, 100)!);
    expect(within(valorDe("Inicial")).getByText(bs(plan.inicialCents))).toBeInTheDocument();
    expect(within(valorDe("Cada cuota")).getByText(bs(plan.cuotaCents))).toBeInTheDocument();
    expect(valorDe("Monto financiado").textContent).toBe(formatUsd(plan.financiadoCents));
    expect(screen.getByText("Bs. 5.450,00")).toBeInTheDocument();
    expect(screen.getByText("Bs. 2.725,00")).toBeInTheDocument();
  });

  it("sin tasa no aparece ninguna parte en bolívares", () => {
    const { container } = render(<CasheaResumen plan={plan} bcvRate={0} />);
    expect(container.textContent).not.toContain("Bs.");
    expect(valorDe("Inicial")).toHaveTextContent("$54,50");
  });

  it("mostrarBs={false} no pinta bolívares aunque haya tasa", () => {
    const { container } = render(<CasheaResumen plan={plan} bcvRate={100} mostrarBs={false} />);
    expect(container.textContent).not.toContain("Bs.");
  });

  it("la nota de cadencia solo sale si se pide, con los días de CASHEA", () => {
    const { container, unmount } = render(<CasheaResumen plan={plan} mostrarBs={false} />);
    expect(container.textContent).not.toContain("sin intereses");
    unmount();
    render(<CasheaResumen plan={plan} mostrarBs={false} notaCadencia />);
    // El carrito tiene que decir CUÁNTAS cuotas (pedido del operador): va en la misma nota.
    expect(
      screen.getByText(`${plan.cuotas} cuotas, cada ${CASHEA.DIAS_ENTRE_CUOTAS} días, sin intereses`),
    ).toBeInTheDocument();
  });

  it("la nota de la última cuota aparece solo cuando difiere de la base", () => {
    const iguales = calcularCashea({ montoCents: 12000, nivel: 6, cuotas: 3, bajada: false });
    expect(iguales.montosCuotasCents[2]).toBe(iguales.cuotaCents);
    const { unmount } = render(<CasheaResumen plan={iguales} mostrarBs={false} />);
    expect(screen.queryByText(/la última/)).not.toBeInTheDocument();
    unmount();

    const distintas = calcularCashea({ montoCents: 11800, nivel: 4, cuotas: 6, bajada: true });
    const ultima = distintas.montosCuotasCents[5];
    expect(ultima).not.toBe(distintas.cuotaCents);
    render(<CasheaResumen plan={distintas} mostrarBs={false} />);
    expect(valorDe("Cada cuota")).toHaveTextContent(`${formatUsd(distintas.cuotaCents)} · la última, ${formatUsd(ultima)}`);
  });

  it("los hijos se suman como una fila más dentro del mismo bloque", () => {
    render(
      <CasheaResumen plan={plan} mostrarBs={false}>
        <div>
          <dt>Monto total</dt>
          <dd>{formatUsd(plan.montoCents)}</dd>
        </div>
      </CasheaResumen>,
    );
    expect(valorDe("Monto total")).toHaveTextContent("$218,00");
  });
});
