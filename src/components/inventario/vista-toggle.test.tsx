/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { VistaToggle } from "@/components/inventario/vista-toggle";

/**
 * Interruptor Lista / Cuadrícula (30/10/2026, plan «Cada repuesto con su foto»,
 * T5a, D4). Recuerda la última vista de cada asesor en una cookie —no en
 * `localStorage`— para que el SERVIDOR pinte la vista correcta en el primer
 * render, sin parpadeo; por eso, después de escribirla, pide `router.refresh()`.
 *
 * La cookie lleva `path=/inventario`, y jsdom está en `http://localhost/`: con ese
 * path el `document.cookie` de lectura NO la devuelve, así que se espía el SETTER
 * (lo que de verdad le llega al navegador) en vez de leer de vuelta.
 */

const escritas: string[] = [];
let lanzar = false;

function ui() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

beforeEach(() => {
  escritas.length = 0;
  lanzar = false;
  refresh.mockClear();
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => "",
    set: (valor: string) => {
      if (lanzar) throw new Error("cookies bloqueadas");
      escritas.push(valor);
    },
  });
});

afterEach(() => {
  // Quita la propiedad propia del documento: vuelve a verse la de jsdom en el prototipo.
  delete (document as unknown as Record<string, unknown>).cookie;
});

describe("VistaToggle", () => {
  it("marca con aria-pressed la vista que rige", () => {
    const { unmount } = render(<VistaToggle vista="lista" />);
    expect(screen.getByRole("button", { name: "Lista" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Cuadrícula" })).toHaveAttribute("aria-pressed", "false");
    unmount();

    render(<VistaToggle vista="cuadricula" />);
    expect(screen.getByRole("button", { name: "Lista" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Cuadrícula" })).toHaveAttribute("aria-pressed", "true");
  });

  it("es un grupo con nombre", () => {
    render(<VistaToggle vista="lista" />);
    expect(screen.getByRole("group", { name: "Vista del inventario" })).toBeInTheDocument();
  });

  it("cambiar a Cuadrícula escribe la cookie con su nombre, valor, path, un año y SameSite=Lax, y refresca", async () => {
    render(<VistaToggle vista="lista" />);

    await ui().click(screen.getByRole("button", { name: "Cuadrícula" }));

    expect(escritas).toEqual(["sbk-inventario-vista=cuadricula; path=/inventario; max-age=31536000; samesite=lax"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("volver a Lista escribe «lista»", async () => {
    render(<VistaToggle vista="cuadricula" />);

    await ui().click(screen.getByRole("button", { name: "Lista" }));

    expect(escritas).toEqual(["sbk-inventario-vista=lista; path=/inventario; max-age=31536000; samesite=lax"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("pulsar la vista que ya rige no escribe ni refresca", async () => {
    render(<VistaToggle vista="lista" />);

    await ui().click(screen.getByRole("button", { name: "Lista" }));

    expect(escritas).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("da respuesta al instante: el botón elegido queda marcado antes de que el servidor devuelva la vista nueva", async () => {
    render(<VistaToggle vista="lista" />);

    await ui().click(screen.getByRole("button", { name: "Cuadrícula" }));

    expect(screen.getByRole("button", { name: "Cuadrícula" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Lista" })).toHaveAttribute("aria-pressed", "false");
  });

  it("cuando llega la vista del servidor, manda ella (no se queda con la elección optimista)", async () => {
    const { rerender } = render(<VistaToggle vista="lista" />);
    await ui().click(screen.getByRole("button", { name: "Cuadrícula" }));

    // El servidor contestó con la vista que quedó escrita.
    rerender(<VistaToggle vista="cuadricula" />);
    expect(screen.getByRole("button", { name: "Cuadrícula" })).toHaveAttribute("aria-pressed", "true");

    // Y si después otra pestaña/refresh la devuelve a Lista, se sigue al servidor.
    rerender(<VistaToggle vista="lista" />);
    expect(screen.getByRole("button", { name: "Lista" })).toHaveAttribute("aria-pressed", "true");
  });

  it("si escribir la cookie lanza (cookies bloqueadas), no rompe: no hay excepción y igual pide refrescar", async () => {
    lanzar = true;
    render(<VistaToggle vista="lista" />);

    await expect(ui().click(screen.getByRole("button", { name: "Cuadrícula" }))).resolves.not.toThrow();

    expect(escritas).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Sin cookie el servidor no va a cambiar de vista: el botón no puede decir que sí.
    expect(screen.getByRole("button", { name: "Lista" })).toHaveAttribute("aria-pressed", "true");
  });
});
