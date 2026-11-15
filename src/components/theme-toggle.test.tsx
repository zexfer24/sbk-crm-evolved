/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * El interruptor de tema con la animación M22 (15/11/2026): el cambio pasa por
 * `document.startViewTransition` con un `clip-path` circular desde el centro del
 * botón, y el ícono entra girando (`rotation -90 → 0`, `scale .6 → 1`, 0,6 s,
 * `back.out(2)`, hecho con WAAPI porque aquí no hay GSAP). Vale para TODO
 * `ThemeToggle`, esté donde esté. jsdom no tiene nada de eso: se simula.
 */

type Vt = { ready: Promise<void>; finished: Promise<void> };
const animate = vi.fn();
const original = { animate: Element.prototype.animate };

function simularReducirMovimiento(reduce: boolean) {
  vi.stubGlobal("matchMedia", (consulta: string) => ({
    matches: reduce && consulta.includes("prefers-reduced-motion"),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function simularViewTransitions() {
  const startViewTransition = vi.fn((cb: () => void): Vt => {
    cb();
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  });
  (document as unknown as { startViewTransition: unknown }).startViewTransition = startViewTransition;
  return startViewTransition;
}

const usuario = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

beforeEach(() => {
  animate.mockReset();
  Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
  simularReducirMovimiento(false);
  localStorage.clear();
  document.documentElement.dataset.theme = "light";
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  Element.prototype.animate = original.animate;
  vi.unstubAllGlobals();
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

/** Los `animate` que NO son del clip-path del documento: los de los íconos. */
const animacionesDeIcono = () => animate.mock.calls.filter((_, i) => animate.mock.contexts[i] !== document.documentElement);
const animacionDeClip = () => animate.mock.calls.filter((_, i) => animate.mock.contexts[i] === document.documentElement);

describe("ThemeToggle", () => {
  it("con View Transitions: llama a startViewTransition y el tema cambia en <html> y en localStorage", async () => {
    const startViewTransition = simularViewTransitions();
    render(<ThemeToggle />);

    await act(async () => {
      await usuario().click(screen.getByRole("button", { name: /Cambiar a modo oscuro/ }));
    });

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("liminal-theme")).toBe("dark");
    // El estado de React también se enteró (aria-label del botón).
    expect(screen.getByRole("button", { name: /Cambiar a modo claro/ })).toBeTruthy();
  });

  it("el clip-path circular parte del centro del botón, con 620 ms y el easing de M22", async () => {
    simularViewTransitions();
    render(<ThemeToggle />);
    const boton = screen.getByRole("button");
    boton.getBoundingClientRect = () =>
      ({ left: 20, top: 100, width: 40, height: 40, right: 60, bottom: 140, x: 20, y: 100, toJSON: () => ({}) }) as DOMRect;

    await act(async () => {
      await usuario().click(boton);
    });

    const [[fotogramas, opciones]] = animacionDeClip();
    expect(opciones).toEqual({
      duration: 620,
      easing: "cubic-bezier(.65,0,.35,1)",
      pseudoElement: "::view-transition-new(root)",
    });
    expect(fotogramas.clipPath[0]).toBe("circle(0px at 40px 120px)");
  });

  it("el ícono entra girando: -90° y escala .6 hacia 0° y 1, en 0,6 s con un back.out", async () => {
    simularViewTransitions();
    render(<ThemeToggle />);

    await act(async () => {
      await usuario().click(screen.getByRole("button"));
    });

    const iconos = animacionesDeIcono();
    expect(iconos.length).toBe(2); // el sol y la luna conviven en el DOM; el CSS muestra uno
    for (const [fotogramas, opciones] of iconos) {
      expect(fotogramas).toEqual([
        { transform: "rotate(-90deg) scale(0.6)" },
        { transform: "rotate(0deg) scale(1)" },
      ]);
      expect(opciones.duration).toBe(600);
      // back.out(2): un cubic-bezier que se pasa de 1 y vuelve.
      expect(opciones.easing).toMatch(/^cubic-bezier\(\s*[\d.]+,\s*(1\.[5-9]\d*|[2-9][\d.]*),/);
    }
  });

  it("sin View Transitions cambia directo; el ícono igual gira y el clip no existe", async () => {
    render(<ThemeToggle />);

    await act(async () => {
      await usuario().click(screen.getByRole("button"));
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(animacionDeClip().length).toBe(0);
    expect(animacionesDeIcono().length).toBe(2);
  });

  it("con prefers-reduced-motion cambia directo y no anima nada", async () => {
    const startViewTransition = simularViewTransitions();
    simularReducirMovimiento(true);
    render(<ThemeToggle />);

    await act(async () => {
      await usuario().click(screen.getByRole("button"));
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
  });

  it("sin Element.animate (entornos viejos) no lanza y el tema igual cambia", async () => {
    // @ts-expect-error simula un entorno sin WAAPI
    Element.prototype.animate = undefined;
    render(<ThemeToggle />);

    await act(async () => {
      await usuario().click(screen.getByRole("button"));
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
