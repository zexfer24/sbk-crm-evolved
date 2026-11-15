/** @vitest-environment jsdom */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PanelHoja } from "./panel-hoja";

/**
 * Plan "Paneles" (13/11/2026): la hoja lateral de detalle sobre `<dialog>`
 * (en el mockup, `ui.hoja` de `kit.js`). jsdom no implementa `showModal`, así
 * que el componente cae a `open` y estos tests miran lo que sí es contrato:
 * Esc y clic fuera cierran, el foco entra al abrir y vuelve al disparador.
 */

function Montaje({ alCerrar }: { alCerrar?: () => void }) {
  const [abierta, setAbierta] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setAbierta(true)}>
        Ver detalle
      </button>
      <PanelHoja
        abierta={abierta}
        titulo="Ventas de la tienda"
        onCerrar={() => {
          alCerrar?.();
          setAbierta(false);
        }}
      >
        <p>Contenido del detalle</p>
      </PanelHoja>
    </>
  );
}

function dialogo(container: HTMLElement): HTMLDialogElement {
  return container.querySelector("dialog") as HTMLDialogElement;
}

describe("PanelHoja", () => {
  it("cerrada no pinta el contenido ni queda abierta", () => {
    const { container } = render(<Montaje />);

    expect(screen.queryByText("Contenido del detalle")).toBeNull();
    expect(dialogo(container).open).toBe(false);
  });

  it("al abrir muestra el título y el contenido en un dialog con nombre accesible", () => {
    const { container } = render(<Montaje />);

    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));

    expect(dialogo(container).open).toBe(true);
    expect(screen.getByText("Contenido del detalle")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ventas de la tienda" })).toBeInTheDocument();
    expect(dialogo(container).getAttribute("aria-label")).toBe("Ventas de la tienda");
  });

  it("al abrir el foco va al botón Cerrar", () => {
    render(<Montaje />);

    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cerrar" }));
  });

  it("el botón Cerrar cierra y devuelve el foco a quien abrió la hoja", () => {
    const alCerrar = vi.fn();
    const { container } = render(<Montaje alCerrar={alCerrar} />);
    const disparador = screen.getByRole("button", { name: "Ver detalle" });
    disparador.focus();
    fireEvent.click(disparador);

    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));

    expect(alCerrar).toHaveBeenCalledTimes(1);
    expect(dialogo(container).open).toBe(false);
    expect(document.activeElement).toBe(disparador);
  });

  it("Esc cierra y devuelve el foco", () => {
    const alCerrar = vi.fn();
    const { container } = render(<Montaje alCerrar={alCerrar} />);
    const disparador = screen.getByRole("button", { name: "Ver detalle" });
    disparador.focus();
    fireEvent.click(disparador);

    fireEvent.keyDown(dialogo(container), { key: "Escape" });

    expect(alCerrar).toHaveBeenCalledTimes(1);
    expect(dialogo(container).open).toBe(false);
    expect(document.activeElement).toBe(disparador);
  });

  it("el evento cancel del navegador (Esc nativo) también cierra, sin dejar que el dialog se cierre solo", () => {
    const alCerrar = vi.fn();
    const { container } = render(<Montaje alCerrar={alCerrar} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));

    const evento = new Event("cancel", { cancelable: true });
    dialogo(container).dispatchEvent(evento);

    expect(evento.defaultPrevented).toBe(true);
    expect(alCerrar).toHaveBeenCalledTimes(1);
  });

  it("un clic fuera del panel (en el fondo del dialog) cierra; uno dentro no", () => {
    const alCerrar = vi.fn();
    const { container } = render(<Montaje alCerrar={alCerrar} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));

    fireEvent.click(screen.getByText("Contenido del detalle"));
    expect(alCerrar).not.toHaveBeenCalled();

    fireEvent.click(dialogo(container));
    expect(alCerrar).toHaveBeenCalledTimes(1);
  });

  it("lleva las clases de la hoja lateral y de la hoja inferior (el CSS decide con el ancho)", () => {
    const { container } = render(<Montaje />);
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));

    expect(dialogo(container).classList.contains("pn-hoja")).toBe(true);
    expect(container.querySelector(".pn-hoja__panel")).toBeTruthy();
  });
});
