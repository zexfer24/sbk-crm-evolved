/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

// 21/10/2026, "Presupuestos y mensajes rápidos" (T3): confirmación compartida
// para borrar un presupuesto, borrar todos los propios y reemplazar el carrito.

function crearUsuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

function Montado({
  onConfirmar,
  peligro,
  inicialmenteAbierto = true,
}: {
  onConfirmar: () => void | Promise<void>;
  peligro?: boolean;
  inicialmenteAbierto?: boolean;
}) {
  const [abierto, setAbierto] = useState(inicialmenteAbierto);
  return (
    <ConfirmDialog
      isOpen={abierto}
      onOpenChange={setAbierto}
      titulo="¿Borrar el presupuesto?"
      descripcion={<span>Se borra el de María Pérez.</span>}
      confirmarEtiqueta="Borrar"
      peligro={peligro}
      onConfirmar={onConfirmar}
    />
  );
}

describe("ConfirmDialog", () => {
  it("muestra el título y la descripción", () => {
    render(<Montado onConfirmar={vi.fn()} />);
    expect(screen.getByText("¿Borrar el presupuesto?")).toBeTruthy();
    expect(screen.getByText("Se borra el de María Pérez.")).toBeTruthy();
  });

  it("cerrado de entrada no renderiza el diálogo", () => {
    render(<Montado onConfirmar={vi.fn()} inicialmenteAbierto={false} />);
    expect(screen.queryByText("¿Borrar el presupuesto?")).toBeNull();
  });

  it("el foco inicial va a Cancelar, no al botón que destruye", async () => {
    render(<Montado onConfirmar={vi.fn()} peligro />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancelar" })).toHaveFocus());
  });

  it("Cancelar cierra sin llamar a onConfirmar", async () => {
    const onConfirmar = vi.fn();
    const user = crearUsuario();
    render(<Montado onConfirmar={onConfirmar} />);

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onConfirmar).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("¿Borrar el presupuesto?")).toBeNull());
  });

  it("la etiqueta de cancelar se puede cambiar", () => {
    render(
      <ConfirmDialog
        isOpen
        onOpenChange={vi.fn()}
        titulo="t"
        descripcion="d"
        confirmarEtiqueta="Sí"
        cancelarEtiqueta="Mejor no"
        onConfirmar={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Mejor no" })).toBeTruthy();
  });

  it("Confirmar llama a onConfirmar y, al resolverse, cierra", async () => {
    const onConfirmar = vi.fn().mockResolvedValue(undefined);
    const user = crearUsuario();
    render(<Montado onConfirmar={onConfirmar} />);

    await user.click(screen.getByRole("button", { name: "Borrar" }));

    expect(onConfirmar).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("¿Borrar el presupuesto?")).toBeNull());
  });

  it("mientras corre onConfirmar los dos botones quedan deshabilitados y el de confirmar dice «Borrar…»", async () => {
    let terminar: () => void = () => {};
    const onConfirmar = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          terminar = resolve;
        }),
    );
    const user = crearUsuario();
    render(<Montado onConfirmar={onConfirmar} />);

    await user.click(screen.getByRole("button", { name: "Borrar" }));

    const confirmar = await screen.findByRole("button", { name: "Borrar…" });
    expect(confirmar).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();

    // Un segundo clic no repite la acción.
    await user.click(confirmar);
    expect(onConfirmar).toHaveBeenCalledTimes(1);

    terminar();
    await waitFor(() => expect(screen.queryByText("¿Borrar el presupuesto?")).toBeNull());
  });

  it("si onConfirmar falla, el diálogo sigue abierto y los botones vuelven a estar disponibles", async () => {
    const onConfirmar = vi.fn().mockRejectedValue(new Error("RLS dijo que no"));
    const user = crearUsuario();
    render(<Montado onConfirmar={onConfirmar} />);

    await user.click(screen.getByRole("button", { name: "Borrar" }));

    await waitFor(() => expect(onConfirmar).toHaveBeenCalledTimes(1));
    const confirmar = await screen.findByRole("button", { name: "Borrar" });
    await waitFor(() => expect(confirmar).not.toBeDisabled());
    expect(screen.getByRole("button", { name: "Cancelar" })).not.toBeDisabled();
    expect(screen.getByText("¿Borrar el presupuesto?")).toBeTruthy();
  });

  it("con peligro, el botón de confirmar usa el estilo de acción destructiva", () => {
    render(<Montado onConfirmar={vi.fn()} peligro />);
    expect(screen.getByRole("button", { name: "Borrar" }).className).toMatch(/danger/);
  });

  it("sin peligro, el botón de confirmar no es rojo", () => {
    render(<Montado onConfirmar={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Borrar" }).className).not.toMatch(/danger/);
  });
});
