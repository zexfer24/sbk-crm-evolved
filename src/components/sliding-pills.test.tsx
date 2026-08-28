/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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

/**
 * R8: el contenedor es `width: fit-content` con tope en el espacio
 * disponible del panel. Una vez que la fila ya desborda (el carril
 * scrollea), ese tope no se mueve aunque la píldora activa se ensanche —el
 * conteo de "Pendientes" pasando de un dígito a dos—, así que el
 * ResizeObserver del contenedor no dispara y el recorte queda corrido. La
 * corrección observa también el botón activo, cuyo propio ancho sí refleja
 * ese cambio.
 */
describe("SlidingPills — R8: el conteo activo re-mide aunque el contenedor no se mueva", () => {
  /** Sustituto mínimo: registra a quién observa cada instancia y deja
   * disparar su callback a mano, como haría un resize real del navegador. */
  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    observed: Element[] = [];
    private readonly cb: ResizeObserverCallback;

    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      FakeResizeObserver.instances.push(this);
    }

    observe(el: Element) {
      this.observed.push(el);
    }
    unobserve() {}
    disconnect() {}
    trigger() {
      this.cb([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
    }
  }

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** jsdom no calcula layout: se fuerzan los valores que un resize real
   * habría dejado, sobre-escribiendo las propiedades de solo lectura. */
  function fakeWidth(el: HTMLElement, width: number) {
    Object.defineProperty(el, "offsetLeft", { value: 0, configurable: true });
    Object.defineProperty(el, "offsetWidth", { value: width, configurable: true });
  }

  const ITEMS_CON_CONTEO = [
    { value: "pending", label: "Pendientes", count: 9 },
    { value: "all", label: "Todos" },
  ];

  it("observa el botón activo además del contenedor", () => {
    render(
      <SlidingPills items={ITEMS_CON_CONTEO} value="pending" onChange={() => {}} ariaLabel="Filtros" />
    );

    const activeButton = screen
      .getAllByRole("button", { name: /Pendientes/ })
      .find((b) => b.hasAttribute("aria-pressed"));
    expect(activeButton).toBeDefined();

    const observaAlBotón = FakeResizeObserver.instances.some((o) =>
      o.observed.includes(activeButton as HTMLElement)
    );
    expect(observaAlBotón).toBe(true);
  });

  it("re-mide el recorte cuando el botón activo cambia de ancho, aunque el contenedor no se mueva", () => {
    const { container } = render(
      <SlidingPills items={ITEMS_CON_CONTEO} value="pending" onChange={() => {}} ariaLabel="Filtros" />
    );

    const activeButton = screen
      .getAllByRole("button", { name: /Pendientes/ })
      .find((b) => b.hasAttribute("aria-pressed")) as HTMLElement;
    const pillsContainer = container.querySelector(".lm-pills") as HTMLElement;
    const overlay = container.querySelector(".lm-pills-active") as HTMLElement;

    const observerDelBotón = FakeResizeObserver.instances.find((o) =>
      o.observed.includes(activeButton)
    ) as FakeResizeObserver;

    // El contenedor ya está en el tope del panel (316px) y no se mueve —el
    // caso exacto que describe R8—; solo el botón activo se ensancha.
    Object.defineProperty(pillsContainer, "offsetWidth", { value: 200, configurable: true });

    fakeWidth(activeButton, 40); // conteo de un dígito, "9".
    act(() => observerDelBotón.trigger());
    const antes = overlay.style.clipPath;

    fakeWidth(activeButton, 52); // conteo de dos dígitos, "12": el botón se ensancha.
    act(() => observerDelBotón.trigger());
    const después = overlay.style.clipPath;

    expect(después).not.toBe(antes);
  });
});
