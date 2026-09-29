/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StockPill } from "@/components/context-panel/stock-pill";

/**
 * T9, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
 * esperando" (29/9/2026, 3.5): la existencia deja de ser un texto gris suelto
 * y pasa a ser una pastilla que se lee de un vistazo — verde con la cantidad,
 * roja si no queda nada. El color NUNCA es el único aviso: el texto dice lo
 * mismo ("12 en stock" / "Agotado"). Los colores son tokens de `theme.css`
 * (contraste AA medido en pantalla, ver Playwright del reporte); jsdom no los
 * calcula, así que acá se fija el CONTENIDO y el estado que el CSS pinta.
 */
describe("StockPill", () => {
  it("con existencia dice cuántas hay y se marca como disponible", () => {
    render(<StockPill quantity={12} />);

    const pill = screen.getByText("12 en stock");
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveAttribute("data-stock", "in");
  });

  it("con cero dice «Agotado», no «en stock», y se marca como agotado", () => {
    render(<StockPill quantity={0} />);

    const pill = screen.getByText("Agotado");
    expect(pill).toHaveAttribute("data-stock", "out");
    expect(screen.queryByText(/en stock/i)).not.toBeInTheDocument();
  });

  it("una existencia negativa (Saint puede reportarla) también es agotado", () => {
    render(<StockPill quantity={-3} />);

    expect(screen.getByText("Agotado")).toHaveAttribute("data-stock", "out");
    expect(screen.queryByText(/-3/)).not.toBeInTheDocument();
  });

  it("con una sola unidad no se rompe: «1 en stock»", () => {
    render(<StockPill quantity={1} />);

    expect(screen.getByText("1 en stock")).toHaveAttribute("data-stock", "in");
  });
});
