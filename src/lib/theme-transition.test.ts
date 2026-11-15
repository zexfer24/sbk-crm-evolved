/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EASING_CLIP_TEMA,
  DURACION_CLIP_TEMA_MS,
  cambiarConTransicionCircular,
} from "@/lib/theme-transition";

/**
 * El cambio de tema como M22 del «Laboratorio de movimiento» de Liminal CRM V3
 * (15/11/2026): `document.startViewTransition` y, en `ready`, un `clip-path`
 * circular que crece desde el botón hasta la esquina más lejana (620 ms,
 * `cubic-bezier(.65,0,.35,1)`, sobre `::view-transition-new(root)`). jsdom no
 * tiene View Transitions ni `Element.animate`: se simulan.
 */

type Vt = { ready: Promise<void>; finished: Promise<void> };

const animate = vi.fn();
const original = {
  animate: Element.prototype.animate,
  matchMedia: window.matchMedia,
  startViewTransition: (document as unknown as { startViewTransition?: unknown }).startViewTransition,
};

function simularReducirMovimiento(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (consulta: string) => ({
      matches: reduce && consulta.includes("prefers-reduced-motion"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  );
}

function simularViewTransitions() {
  const startViewTransition = vi.fn((cb: () => void): Vt => {
    cb();
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  });
  (document as unknown as { startViewTransition: unknown }).startViewTransition = startViewTransition;
  return startViewTransition;
}

beforeEach(() => {
  animate.mockReset();
  Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
  simularReducirMovimiento(false);
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 800);
});

afterEach(() => {
  Element.prototype.animate = original.animate;
  vi.unstubAllGlobals();
  if (original.startViewTransition === undefined) {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  } else {
    (document as unknown as { startViewTransition: unknown }).startViewTransition = original.startViewTransition;
  }
});

describe("cambiarConTransicionCircular", () => {
  it("llama a startViewTransition y aplica el cambio dentro de su callback", async () => {
    const startViewTransition = simularViewTransitions();
    const aplicar = vi.fn();

    await cambiarConTransicionCircular(aplicar, { x: 100, y: 50 });

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(aplicar).toHaveBeenCalledTimes(1);
    // El callback que recibe el navegador ES `aplicar`: el cambio ocurre dentro de la transición.
    expect(startViewTransition.mock.calls[0][0]).toBe(aplicar);
  });

  it("anima el clip-path circular: 620 ms, ese easing y ::view-transition-new(root)", async () => {
    simularViewTransitions();

    await cambiarConTransicionCircular(vi.fn(), { x: 100, y: 50 });

    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(document.documentElement);
    const [fotogramas, opciones] = animate.mock.calls[0];
    expect(opciones).toEqual({
      duration: 620,
      easing: "cubic-bezier(.65,0,.35,1)",
      pseudoElement: "::view-transition-new(root)",
    });
    expect(DURACION_CLIP_TEMA_MS).toBe(620);
    expect(EASING_CLIP_TEMA).toBe("cubic-bezier(.65,0,.35,1)");
    // R = distancia del botón a la esquina más lejana de la ventana: desde (100,50) en 1000x800
    // la más lejana es (1000,800): hypot(900, 750).
    const R = Math.hypot(900, 750);
    expect(fotogramas.clipPath).toEqual(["circle(0px at 100px 50px)", `circle(${R}px at 100px 50px)`]);
  });

  it("sin origen crece desde el centro de la ventana", async () => {
    simularViewTransitions();

    await cambiarConTransicionCircular(vi.fn());

    const [fotogramas] = animate.mock.calls[0];
    expect(fotogramas.clipPath[0]).toBe("circle(0px at 500px 400px)");
    expect(fotogramas.clipPath[1]).toBe(`circle(${Math.hypot(500, 400)}px at 500px 400px)`);
  });

  it("sin soporte de View Transitions cambia directo y no anima", async () => {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    const aplicar = vi.fn();

    await cambiarConTransicionCircular(aplicar, { x: 1, y: 1 });

    expect(aplicar).toHaveBeenCalledTimes(1);
    expect(animate).not.toHaveBeenCalled();
  });

  it("con prefers-reduced-motion cambia directo: ni startViewTransition ni animate", async () => {
    const startViewTransition = simularViewTransitions();
    simularReducirMovimiento(true);
    const aplicar = vi.fn();

    await cambiarConTransicionCircular(aplicar, { x: 1, y: 1 });

    expect(aplicar).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
  });

  it("si la transición se salta (ready rechaza) el cambio igual quedó aplicado y no lanza", async () => {
    (document as unknown as { startViewTransition: unknown }).startViewTransition = (cb: () => void) => {
      cb();
      const ready = Promise.reject(new Error("saltada"));
      ready.catch(() => {});
      return { ready, finished: Promise.resolve() };
    };
    const aplicar = vi.fn();

    await expect(cambiarConTransicionCircular(aplicar)).resolves.toBeUndefined();
    expect(aplicar).toHaveBeenCalledTimes(1);
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("la hoja global de las View Transitions", () => {
  it("apaga la animación por defecto de old/new(root): el clip-path es el único movimiento", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const css = await readFile(join(process.cwd(), "src/app/theme.css"), "utf8");

    const regla = /::view-transition-old\(root\),\s*::view-transition-new\(root\)\s*\{([^}]*)\}/.exec(css);
    expect(regla, "falta la regla de ::view-transition-old/new(root)").not.toBeNull();
    expect(regla![1]).toMatch(/animation:\s*none\s*;/);
    expect(regla![1]).toMatch(/mix-blend-mode:\s*normal\s*;/);
  });

  // Igual que `Base/src/styles/base.css` del laboratorio: mientras el círculo crece,
  // la foto NUEVA tiene que pintarse siempre ENCIMA de la vieja. Sin estos z-index
  // el orden de las dos capas queda a criterio del navegador y el círculo puede
  // revelar la pantalla vieja en vez de la nueva.
  it("pone la foto nueva encima de la vieja: old z-index 1, new z-index 2", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const css = await readFile(join(process.cwd(), "src/app/theme.css"), "utf8");

    const cuerpos = (pseudo: string) =>
      [...css.matchAll(new RegExp(String.raw`::view-transition-${pseudo}\(root\)\s*\{([^}]*)\}`, "g"))].map((m) => m[1]);
    expect(cuerpos("old").some((c) => /z-index:\s*1\s*;/.test(c)), "falta ::view-transition-old(root) con z-index: 1").toBe(true);
    expect(cuerpos("new").some((c) => /z-index:\s*2\s*;/.test(c)), "falta ::view-transition-new(root) con z-index: 2").toBe(true);
  });
});
