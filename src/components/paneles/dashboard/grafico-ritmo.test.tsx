/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { GraficoRitmo } from "./grafico-ritmo";

/**
 * 15/11/2026: el gráfico de ritmo por hora tenía el mismo defecto que
 * `LineaArea` (viewBox fijo de 600 px estirado al contenedor: el texto de los
 * ejes escalaba con el ancho). Ahora el `viewBox` mide lo que el contenedor.
 */
describe("GraficoRitmo", () => {
  const observadores: Array<(entradas: unknown[]) => void> = [];

  class FakeResizeObserver {
    constructor(callback: (entradas: unknown[]) => void) {
      observadores.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  beforeEach(() => {
    observadores.length = 0;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const meta = Array.from({ length: 24 }, (_, h) => (h + 1) * 100);
  const real = Array.from({ length: 11 }, (_, h) => h * 80);
  const dibujar = () =>
    render(<GraficoRitmo real={real} meta={meta} desdeHora={0} hastaHora={23} horaActual={10} ariaLabel="Ritmo del día" />);
  const medir = (ancho: number) =>
    act(() => {
      for (const callback of observadores) callback([{ contentRect: { width: ancho } }]);
    });

  it("el viewBox toma el ancho medido del contenedor", () => {
    const { container } = dibujar();
    medir(390);
    expect(container.querySelector("svg.pn-svg")?.getAttribute("viewBox")).toMatch(/^0 0 390 \d+$/);
  });

  it("a 390 px no se muestran las 24 horas (se encimarían) y a 1440 sí caben más", () => {
    const { container } = dibujar();
    const horas = () => Array.from(container.querySelectorAll(".pd-ritmo__rejilla text")).filter((t) => /^\d\d$/.test(t.textContent ?? ""));
    medir(390);
    const angosto = horas().length;
    expect(angosto).toBeLessThan(24);
    expect(angosto * 24).toBeLessThanOrEqual(390);
    medir(1440);
    expect(horas().length).toBeGreaterThan(angosto);
  });
});
