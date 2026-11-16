/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATRIBUTO_TRANSICION_TEMA,
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
  document.documentElement.removeAttribute(ATRIBUTO_TRANSICION_TEMA);
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

/**
 * La marca `data-transicion-tema` en `<html>` (16/11/2026). HeroUI trae
 * `:root { view-transition-name: none }` y con eso el root no tiene foto: el
 * círculo animaba un pseudo-elemento que nunca se pintaba y el tema cambiaba de
 * golpe. `theme.css` devuelve el nombre `root` SOLO mientras dura el cambio, y
 * esa marca es lo que lo activa. Tiene que estar puesta cuando el navegador
 * captura la foto vieja y quitarse al terminar, aunque la transición se salte.
 */
describe("la marca de transición de tema en <html>", () => {
  const marca = () => document.documentElement.hasAttribute(ATRIBUTO_TRANSICION_TEMA);

  /** Un startViewTransition cuyo `finished` se resuelve/rechaza a mano. */
  function simularControlable() {
    const controles: { resolver: () => void; rechazar: () => void }[] = [];
    const startViewTransition = vi.fn((cb: () => void): Vt => {
      cb();
      let resolver!: () => void;
      let rechazar!: () => void;
      const finished = new Promise<void>((res, rej) => {
        resolver = res;
        rechazar = () => rej(new Error("saltada"));
      });
      finished.catch(() => {});
      controles.push({ resolver, rechazar });
      return { ready: Promise.resolve(), finished };
    });
    (document as unknown as { startViewTransition: unknown }).startViewTransition = startViewTransition;
    return { startViewTransition, controles };
  }

  it("el atributo se llama data-transicion-tema", () => {
    expect(ATRIBUTO_TRANSICION_TEMA).toBe("data-transicion-tema");
  });

  it("ya está puesta cuando se llama a startViewTransition (el navegador la lee al capturar la foto vieja)", async () => {
    let estabaPuesta: boolean | null = null;
    (document as unknown as { startViewTransition: unknown }).startViewTransition = (cb: () => void): Vt => {
      estabaPuesta = marca();
      cb();
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    };

    await cambiarConTransicionCircular(vi.fn());

    expect(estabaPuesta).toBe(true);
  });

  it("se quita cuando finished se resuelve", async () => {
    const { controles } = simularControlable();

    const espera = cambiarConTransicionCircular(vi.fn());
    await vi.waitFor(() => expect(animate).toHaveBeenCalled());
    expect(marca()).toBe(true);

    controles[0].resolver();
    await espera;

    expect(marca()).toBe(false);
  });

  it("se quita también cuando finished rechaza (transición saltada)", async () => {
    const { controles } = simularControlable();

    const espera = cambiarConTransicionCircular(vi.fn());
    await vi.waitFor(() => expect(animate).toHaveBeenCalled());
    expect(marca()).toBe(true);

    controles[0].rechazar();
    await espera;

    expect(marca()).toBe(false);
  });

  it("se quita también cuando ready rechaza", async () => {
    (document as unknown as { startViewTransition: unknown }).startViewTransition = (cb: () => void): Vt => {
      cb();
      const ready = Promise.reject(new Error("saltada"));
      ready.catch(() => {});
      return { ready, finished: Promise.resolve() };
    };

    await cambiarConTransicionCircular(vi.fn());

    expect(marca()).toBe(false);
  });

  it("doble cambio: el finished de la transición vieja NO quita la marca mientras la nueva sigue; el de la nueva sí", async () => {
    const { controles } = simularControlable();

    const primera = cambiarConTransicionCircular(vi.fn());
    await vi.waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
    const segunda = cambiarConTransicionCircular(vi.fn());
    await vi.waitFor(() => expect(animate).toHaveBeenCalledTimes(2));
    expect(controles).toHaveLength(2);

    // El navegador salta la vieja al llegar la nueva: su finished se resuelve.
    controles[0].resolver();
    await primera;
    expect(marca(), "la nueva sigue en curso: la marca no se toca").toBe(true);

    controles[1].resolver();
    await segunda;
    expect(marca()).toBe(false);
  });

  it("doble cambio con la vieja rechazada tampoco quita la marca de la nueva", async () => {
    const { controles } = simularControlable();

    const primera = cambiarConTransicionCircular(vi.fn());
    await vi.waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
    const segunda = cambiarConTransicionCircular(vi.fn());
    await vi.waitFor(() => expect(animate).toHaveBeenCalledTimes(2));

    controles[0].rechazar();
    await primera;
    expect(marca()).toBe(true);

    controles[1].resolver();
    await segunda;
    expect(marca()).toBe(false);
  });

  it("sin la API de View Transitions la marca nunca aparece", async () => {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    let vista = false;
    const aplicar = vi.fn(() => {
      vista = marca();
    });

    await cambiarConTransicionCircular(aplicar);

    expect(aplicar).toHaveBeenCalledTimes(1);
    expect(vista).toBe(false);
    expect(marca()).toBe(false);
  });

  it("con prefers-reduced-motion la marca nunca aparece", async () => {
    simularViewTransitions();
    simularReducirMovimiento(true);
    let vista = false;
    const aplicar = vi.fn(() => {
      vista = marca();
    });

    await cambiarConTransicionCircular(aplicar);

    expect(vista).toBe(false);
    expect(marca()).toBe(false);
  });

  it("si startViewTransition lanza: la marca no queda, aplicar corre una sola vez y no relanza", async () => {
    (document as unknown as { startViewTransition: unknown }).startViewTransition = () => {
      throw new Error("no se pudo");
    };
    const aplicar = vi.fn();

    await expect(cambiarConTransicionCircular(aplicar)).resolves.toBeUndefined();

    expect(aplicar).toHaveBeenCalledTimes(1);
    expect(marca()).toBe(false);
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

  // 16/11/2026: HeroUI trae `:root { view-transition-name: none }` dentro de
  // `@layer base`; sin nombre no hay foto del root y el círculo no se pinta. Una
  // regla de autor SIN capa le gana a una con capa sin importar la especificidad.
  it("devuelve view-transition-name: root solo con la marca, fuera de cualquier @layer", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const css = await readFile(join(process.cwd(), "src/app/theme.css"), "utf8");

    const regla = /:root\[data-transicion-tema\]\s*\{([^}]*)\}/.exec(css);
    expect(regla, "falta :root[data-transicion-tema]").not.toBeNull();
    expect(regla![1]).toMatch(/view-transition-name:\s*root\s*;/);

    // Profundidad de llaves en el punto de la regla: 0 = nivel raíz, sin `@layer` ni `@media`.
    const antes = css.slice(0, regla!.index).replace(/\/\*[\s\S]*?\*\//g, "");
    const abre = (antes.match(/\{/g) ?? []).length;
    const cierra = (antes.match(/\}/g) ?? []).length;
    expect(abre - cierra, "la regla no puede estar dentro de un bloque @layer").toBe(0);
  });
});
