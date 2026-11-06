/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AvisoFaltaDivisa, MonedaToggle } from "@/components/presupuestos/moneda-toggle";

// 6/11/2026, pedido del cliente: el interruptor «BCV | Divisa» del carrito.
describe("MonedaToggle", () => {
  it("pinta dos radios y marca el valor actual", () => {
    render(<MonedaToggle value="bcv" onChange={vi.fn()} />);
    expect(screen.getByRole("radiogroup", { name: "Moneda del carrito" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "BCV" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Divisa" })).toHaveAttribute("aria-checked", "false");
  });

  it("marca Divisa cuando value es divisa", () => {
    render(<MonedaToggle value="divisa" onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Divisa" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "BCV" })).toHaveAttribute("aria-checked", "false");
  });

  it("elegir la otra opción llama onChange con su valor", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onChange = vi.fn();
    render(<MonedaToggle value="bcv" onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "Divisa" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("divisa");
  });

  it("elegir la opción ya marcada no llama onChange", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onChange = vi.fn();
    render(<MonedaToggle value="bcv" onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "BCV" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled deshabilita los dos", () => {
    render(<MonedaToggle value="bcv" onChange={vi.fn()} disabled />);
    expect(screen.getByRole("radio", { name: "BCV" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Divisa" })).toBeDisabled();
  });
});

describe("AvisoFaltaDivisa", () => {
  it("dice cuántos renglones faltan", () => {
    render(<AvisoFaltaDivisa cantidad={2} />);
    expect(screen.getByText("Falta divisa (2)")).toBeInTheDocument();
  });
});
