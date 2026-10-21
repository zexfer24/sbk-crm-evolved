/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GuardarPresupuestoModal } from "@/components/presupuestos/guardar-presupuesto-modal";

// 21/10/2026, "Presupuestos y mensajes rápidos" (T3): el modal que pide
// nombre, apellido y nota antes de guardar un carrito como presupuesto.

function crearUsuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

type Props = Parameters<typeof GuardarPresupuestoModal>[0];

function montar(over: Partial<Props> = {}) {
  const props: Props = {
    isOpen: true,
    onOpenChange: vi.fn(),
    inicial: { nombre: "María", apellido: "Pérez", nota: "" },
    puedeGuardarCambios: false,
    onGuardar: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  const vista = render(<GuardarPresupuestoModal {...props} />);
  return { props, ...vista };
}

describe("GuardarPresupuestoModal — campos", () => {
  it("pinta Nombre, Apellido y Nota (opcional) con los ids acordados y el valor inicial", () => {
    montar({ inicial: { nombre: "María", apellido: "Pérez", nota: "Para el sábado" } });

    const nombre = screen.getByLabelText("Nombre") as HTMLInputElement;
    const apellido = screen.getByLabelText("Apellido") as HTMLInputElement;
    const nota = screen.getByLabelText("Nota (opcional)") as HTMLTextAreaElement;
    expect(nombre.id).toBe("presupuesto-nombre");
    expect(apellido.id).toBe("presupuesto-apellido");
    expect(nota.id).toBe("presupuesto-nota");
    expect(nombre.value).toBe("María");
    expect(apellido.value).toBe("Pérez");
    expect(nota.value).toBe("Para el sábado");
  });

  it("al volver a abrir se reinicia con el valor inicial de ese momento, no con lo que quedó escrito", async () => {
    const user = crearUsuario();
    const { rerender, props } = montar();

    await user.clear(screen.getByLabelText("Nombre"));
    await user.type(screen.getByLabelText("Nombre"), "Otro");
    rerender(<GuardarPresupuestoModal {...props} isOpen={false} />);
    rerender(<GuardarPresupuestoModal {...props} isOpen inicial={{ nombre: "Luis", apellido: "Gómez", nota: "n" }} />);

    expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("Luis");
    expect((screen.getByLabelText("Apellido") as HTMLInputElement).value).toBe("Gómez");
    expect((screen.getByLabelText("Nota (opcional)") as HTMLTextAreaElement).value).toBe("n");
  });
});

describe("GuardarPresupuestoModal — validación", () => {
  it("nombre y apellido vacíos: un mensaje por campo y no se llama a onGuardar", async () => {
    const user = crearUsuario();
    const { props } = montar({ inicial: { nombre: "", apellido: "  ", nota: "" } });

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByText("Escribe el nombre del cliente.")).toBeTruthy();
    expect(screen.getByText("Escribe el apellido del cliente.")).toBeTruthy();
    expect(props.onGuardar).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("cada error se borra al editar SU campo y no el de los otros", async () => {
    const user = crearUsuario();
    montar({ inicial: { nombre: "", apellido: "", nota: "" } });

    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await screen.findByText("Escribe el nombre del cliente.");

    await user.type(screen.getByLabelText("Nombre"), "M");

    expect(screen.queryByText("Escribe el nombre del cliente.")).toBeNull();
    expect(screen.getByText("Escribe el apellido del cliente.")).toBeTruthy();
  });

  it("una nota de más de 280 caracteres da su mensaje", async () => {
    const user = crearUsuario();
    const { props } = montar({ inicial: { nombre: "María", apellido: "Pérez", nota: "n".repeat(281) } });

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByText("La nota admite hasta 280 caracteres.")).toBeTruthy();
    expect(props.onGuardar).not.toHaveBeenCalled();
  });
});

describe("GuardarPresupuestoModal — botones", () => {
  it("sin permiso para cambiar uno existente: solo «Guardar», que crea uno nuevo", async () => {
    const user = crearUsuario();
    const { props } = montar({ puedeGuardarCambios: false });

    expect(screen.queryByRole("button", { name: "Guardar cambios" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar como nuevo" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(props.onGuardar).toHaveBeenCalledTimes(1));
    expect(props.onGuardar).toHaveBeenCalledWith({ nombre: "María", apellido: "Pérez", nota: "" }, "nuevo");
  });

  it("con permiso: «Guardar cambios» y «Guardar como nuevo», cada uno con su modo", async () => {
    const user = crearUsuario();
    const { props } = montar({ puedeGuardarCambios: true });

    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(props.onGuardar).toHaveBeenCalledTimes(1));
    expect(vi.mocked(props.onGuardar).mock.calls[0][1]).toBe("cambios");

    await user.click(screen.getByRole("button", { name: "Guardar como nuevo" }));
    await waitFor(() => expect(props.onGuardar).toHaveBeenCalledTimes(2));
    expect(vi.mocked(props.onGuardar).mock.calls[1][1]).toBe("nuevo");
  });

  it("entrega los datos recortados", async () => {
    const user = crearUsuario();
    const { props } = montar({ inicial: { nombre: "  María ", apellido: " Pérez  ", nota: "  hola  " } });

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(props.onGuardar).toHaveBeenCalled());
    expect(props.onGuardar).toHaveBeenCalledWith({ nombre: "María", apellido: "Pérez", nota: "hola" }, "nuevo");
  });
});

describe("GuardarPresupuestoModal — guardando", () => {
  it("mientras guarda, los botones quedan deshabilitados; al terminar bien, se cierra", async () => {
    let terminar: () => void = () => {};
    const onGuardar = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          terminar = resolve;
        }),
    );
    const user = crearUsuario();
    const { props } = montar({ puedeGuardarCambios: true, onGuardar });

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Guardar como nuevo" })).toBeDisabled();
    expect(props.onOpenChange).not.toHaveBeenCalled();

    terminar();
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  });

  it("si onGuardar falla, muestra el motivo dentro del modal, no lo cierra y deja volver a intentar", async () => {
    const onGuardar = vi.fn().mockRejectedValue(new Error("Solo quien guardó este presupuesto o un supervisor puede cambiarlo."));
    const user = crearUsuario();
    const { props } = montar({ onGuardar });

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("Solo quien guardó este presupuesto o un supervisor puede cambiarlo.");
    expect(props.onOpenChange).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Guardar" })).not.toBeDisabled());
  });

  it("un rechazo que no es un Error muestra un mensaje genérico", async () => {
    const onGuardar = vi.fn().mockRejectedValue("boom");
    const user = crearUsuario();
    montar({ onGuardar });

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect((await screen.findByRole("alert")).textContent).toContain("No se pudo guardar el presupuesto");
  });

  it("el error de un intento anterior desaparece al volver a abrir", async () => {
    const onGuardar = vi.fn().mockRejectedValue(new Error("Falló"));
    const user = crearUsuario();
    const { rerender, props } = montar({ onGuardar });

    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await screen.findByText("Falló");

    rerender(<GuardarPresupuestoModal {...props} isOpen={false} />);
    rerender(<GuardarPresupuestoModal {...props} isOpen />);

    expect(screen.queryByText("Falló")).toBeNull();
  });
});
