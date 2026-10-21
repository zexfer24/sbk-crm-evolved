/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpcionesCopiaCasillas } from "@/components/presupuestos/opciones-copia";
import { OPCIONES_COPIA_INICIALES, type OpcionesCopia } from "@/lib/copia-carrito";

// 21/10/2026, "Presupuestos y mensajes rápidos" (T3): las casillas de «qué
// incluir al copiar», compartidas por el carrito de /inventario y el del chat.

function crearUsuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

function montar(over: { opciones?: OpcionesCopia; mostrarCashea?: boolean } = {}) {
  const onChange = vi.fn();
  render(
    <OpcionesCopiaCasillas
      opciones={over.opciones ?? { ...OPCIONES_COPIA_INICIALES }}
      onChange={onChange}
      mostrarCashea={over.mostrarCashea ?? false}
      idPrefix="carrito"
    />,
  );
  return { onChange };
}

describe("OpcionesCopiaCasillas", () => {
  it("es un grupo con la leyenda «Qué incluir al copiar»", () => {
    montar();
    expect(screen.getByRole("group", { name: "Qué incluir al copiar" })).toBeTruthy();
  });

  it("«Nombre» está siempre marcada y no se puede cambiar", () => {
    montar();
    const nombre = screen.getByRole("checkbox", { name: "Nombre" });
    expect(nombre).toBeChecked();
    expect(nombre).toBeDisabled();
  });

  it("una casilla por campo, en el orden pedido y con id prefijo-clave", () => {
    montar();
    const etiquetas = screen.getAllByRole("checkbox").map((c) => c.closest("label")?.textContent?.trim());
    expect(etiquetas).toEqual(["Nombre", "Código", "Cantidad", "Precio unitario", "Subtotal", "Total $", "Total Bs"]);
    expect(screen.getByRole("checkbox", { name: "Código" }).id).toBe("carrito-codigo");
    expect(screen.getByRole("checkbox", { name: "Precio unitario" }).id).toBe("carrito-precioUnitario");
    expect(screen.getByRole("checkbox", { name: "Total Bs" }).id).toBe("carrito-totalBs");
  });

  it("«Plan Cashea» solo aparece con mostrarCashea (el carrito del chat no la tiene)", () => {
    const { unmount } = render(
      <OpcionesCopiaCasillas
        opciones={{ ...OPCIONES_COPIA_INICIALES }}
        onChange={vi.fn()}
        mostrarCashea={false}
        idPrefix="chat"
      />,
    );
    expect(screen.queryByRole("checkbox", { name: "Plan Cashea" })).toBeNull();
    unmount();

    montar({ mostrarCashea: true });
    const plan = screen.getByRole("checkbox", { name: "Plan Cashea" });
    expect(plan.id).toBe("carrito-planCashea");
    expect(plan).toBeChecked();
  });

  it("refleja las opciones recibidas", () => {
    montar({ opciones: { ...OPCIONES_COPIA_INICIALES, codigo: false, totalBs: false } });
    expect(screen.getByRole("checkbox", { name: "Código" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Total Bs" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Subtotal" })).toBeChecked();
  });

  it("al tocar una casilla llama a onChange con una copia nueva y solo esa clave cambiada", async () => {
    const user = crearUsuario();
    const opciones = { ...OPCIONES_COPIA_INICIALES };
    const { onChange } = montar({ opciones });

    await user.click(screen.getByRole("checkbox", { name: "Subtotal" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const nueva = onChange.mock.calls[0][0] as OpcionesCopia;
    expect(nueva).toEqual({ ...OPCIONES_COPIA_INICIALES, subtotal: false });
    expect(nueva).not.toBe(opciones);
    expect(opciones.subtotal).toBe(true);
  });

  it("volver a marcar una casilla apagada la enciende", async () => {
    const user = crearUsuario();
    const { onChange } = montar({ opciones: { ...OPCIONES_COPIA_INICIALES, planCashea: false }, mostrarCashea: true });

    await user.click(screen.getByRole("checkbox", { name: "Plan Cashea" }));

    expect(onChange).toHaveBeenCalledWith({ ...OPCIONES_COPIA_INICIALES, planCashea: true });
  });
});
