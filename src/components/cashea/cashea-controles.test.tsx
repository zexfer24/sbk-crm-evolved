/** @vitest-environment jsdom */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AVISO_SEIS_CUOTAS,
  CASHEA,
  ELECCION_CASHEA_INICIAL,
  NIVELES_CASHEA,
  type EleccionCashea,
} from "@/lib/cashea";
import { CasheaControles } from "@/components/cashea/cashea-controles";

function montar(montoCents: number, eleccion: EleccionCashea = ELECCION_CASHEA_INICIAL) {
  const onChange = vi.fn();
  render(<CasheaControles montoCents={montoCents} eleccion={eleccion} onChange={onChange} />);
  return onChange;
}

describe("CasheaControles", () => {
  it("muestra los seis niveles de N6 a N1 como radios con su porcentaje de inicial", () => {
    montar(20000);
    const grupo = screen.getByRole("radiogroup", { name: "Nivel Cashea" });
    const radios = within(grupo).getAllByRole("radio");
    expect(radios).toHaveLength(NIVELES_CASHEA.length);
    NIVELES_CASHEA.forEach((nivel, i) => {
      const pct = CASHEA.INICIAL_ESTANDAR[nivel];
      expect(radios[i]).toHaveAccessibleName(`N${nivel} · ${pct} %`);
    });
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[1]).toHaveAttribute("aria-checked", "false");
  });

  it("un clic en N4 llama a onChange con el nivel 4 y el resto intacto", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onChange = montar(20000);
    await user.click(screen.getByRole("radio", { name: "N4 · 25 %" }));
    expect(onChange).toHaveBeenCalledWith({ ...ELECCION_CASHEA_INICIAL, nivel: 4 });
  });

  it("con monto de $100 las 6 cuotas están deshabilitadas y se ve el aviso", () => {
    montar(CASHEA.UMBRAL_6_CUOTAS_CENTS);
    expect(screen.getByRole("button", { name: "6 cuotas" })).toBeDisabled();
    expect(screen.getByText(AVISO_SEIS_CUOTAS)).toBeInTheDocument();
  });

  it("con 6 cuotas pedidas y monto de $100 se ve marcado el 3 (las efectivas)", () => {
    montar(CASHEA.UMBRAL_6_CUOTAS_CENTS, { ...ELECCION_CASHEA_INICIAL, cuotas: 6 });
    expect(screen.getByRole("button", { name: "3 cuotas" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "6 cuotas" })).toHaveAttribute("aria-pressed", "false");
  });

  it("no reescribe la elección por su cuenta cuando 6 cuotas no está disponible", () => {
    const onChange = montar(CASHEA.UMBRAL_6_CUOTAS_CENTS, { ...ELECCION_CASHEA_INICIAL, cuotas: 6 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("con $100,01 las 6 cuotas se habilitan, sin aviso, y el clic las elige", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onChange = montar(CASHEA.UMBRAL_6_CUOTAS_CENTS + 1);
    const seis = screen.getByRole("button", { name: "6 cuotas" });
    expect(seis).toBeEnabled();
    expect(screen.queryByText(AVISO_SEIS_CUOTAS)).not.toBeInTheDocument();
    await user.click(seis);
    expect(onChange).toHaveBeenCalledWith({ ...ELECCION_CASHEA_INICIAL, cuotas: 6 });
  });

  it("el interruptor de bajada alterna y los porcentajes pasan a los de la promoción", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });

    function Envoltorio() {
      const [eleccion, setEleccion] = useState<EleccionCashea>(ELECCION_CASHEA_INICIAL);
      return <CasheaControles montoCents={20000} eleccion={eleccion} onChange={setEleccion} />;
    }
    render(<Envoltorio />);

    const interruptor = screen.getByRole("switch", { name: "Bajada de inicial" });
    expect(interruptor).toHaveAttribute("aria-checked", "false");
    expect(interruptor).toHaveAttribute("data-on", "false");
    expect(screen.getByRole("radio", { name: "N4 · 25 %" })).toBeInTheDocument();

    await user.click(interruptor);

    expect(interruptor).toHaveAttribute("aria-checked", "true");
    expect(interruptor).toHaveAttribute("data-on", "true");
    for (const nivel of NIVELES_CASHEA) {
      expect(
        screen.getByRole("radio", { name: `N${nivel} · ${CASHEA.INICIAL_BAJADA[nivel]} %` }),
      ).toBeInTheDocument();
    }
  });
});
