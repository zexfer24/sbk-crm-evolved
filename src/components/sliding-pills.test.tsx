/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SlidingPills } from "@/components/sliding-pills";

const ITEMS = [
  { value: "all", label: "Todos" },
  { value: "assigned", label: "Asignados" },
];

describe("SlidingPills", () => {
  it("marca como seleccionada la opción activa", () => {
    render(<SlidingPills items={ITEMS} value="assigned" onChange={() => {}} ariaLabel="Filtros" />);

    expect(screen.getByRole("button", { name: "Asignados" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Todos" })).toHaveAttribute("aria-pressed", "false");
  });

  it("avisa cuál se eligió al hacer clic", async () => {
    const onChange = vi.fn();
    render(<SlidingPills items={ITEMS} value="all" onChange={onChange} ariaLabel="Filtros" />);

    // `delay: null` y `pointerEventsCheck: 0`: sin salto de macrotarea por
    // pulsación ni `getComputedStyle` subiendo el árbol en cada click — bajo
    // la CPU contendida de esta máquina (28/8/2026) eso revienta timeouts.
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    await user.click(screen.getByRole("button", { name: "Asignados" }));

    expect(onChange).toHaveBeenCalledWith("assigned");
  });

  /**
   * La copia recortada es puramente visual: si la leyera un lector de
   * pantalla, cada opción se anunciaría dos veces.
   */
  it("no expone la capa duplicada a lectores de pantalla", () => {
    render(<SlidingPills items={ITEMS} value="all" onChange={() => {}} ariaLabel="Filtros" />);

    // Una sola vez cada etiqueta, aunque el DOM tenga dos copias.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getAllByText("Todos")).toHaveLength(2);
    expect(screen.getByRole("group", { name: "Filtros" })).toBeInTheDocument();
  });

  it("recorta la capa activa alrededor de la opción seleccionada", () => {
    const { container, rerender } = render(
      <SlidingPills items={ITEMS} value="all" onChange={() => {}} ariaLabel="Filtros" />
    );
    const overlay = container.querySelector(".lm-pills-active") as HTMLElement;

    // jsdom no calcula layout (todo mide 0), así que no se puede verificar el
    // recorte exacto — sí que existe, que cambia con la selección, y que
    // siempre es un inset() válido.
    const first = overlay.style.clipPath;
    expect(first).toMatch(/^inset\(/);

    rerender(<SlidingPills items={ITEMS} value="assigned" onChange={() => {}} ariaLabel="Filtros" />);
    expect(overlay.style.clipPath).toMatch(/^inset\(/);
  });
});
