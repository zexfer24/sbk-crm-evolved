/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTheme } from "@/lib/use-theme";

/**
 * Qué cambios de tema pasan por el círculo M22 y cuáles no (15/11/2026, ajuste
 * del tema pedido por el operador):
 *   - un clic en el botón: círculo desde el botón (`theme-toggle.test.tsx`);
 *   - el sistema operativo cambia su preferencia con la página abierta y la
 *     persona sigue al sistema: círculo desde el centro de la ventana, como el
 *     laboratorio sin origen, y respetando prefers-reduced-motion;
 *   - otra pestaña cambia el tema (evento `storage`): SIN animación — la
 *     persona no hizo clic aquí y esta pestaña suele estar oculta, donde una
 *     View Transition ni corre;
 *   - la carga inicial (script del <head>): SIN animación, fuera de este hook.
 */

type Oyente = (evento: { matches: boolean }) => void;

let sistemaOscuro = false;
let reducirMovimiento = false;
const oyentes = new Map<string, Set<Oyente>>();

function simularMatchMedia() {
  vi.stubGlobal("matchMedia", (consulta: string) => ({
    get matches() {
      if (consulta.includes("prefers-reduced-motion")) return reducirMovimiento;
      if (consulta.includes("prefers-color-scheme: dark")) return sistemaOscuro;
      return false;
    },
    addEventListener: (_: string, fn: Oyente) => {
      if (!oyentes.has(consulta)) oyentes.set(consulta, new Set());
      oyentes.get(consulta)!.add(fn);
    },
    removeEventListener: (_: string, fn: Oyente) => oyentes.get(consulta)?.delete(fn),
  }));
}

/** El sistema operativo pasa a (des)activar el modo oscuro y avisa a quien escuche. */
function cambiarSistema(oscuro: boolean) {
  sistemaOscuro = oscuro;
  for (const fn of oyentes.get("(prefers-color-scheme: dark)") ?? []) fn({ matches: oscuro });
}

const animate = vi.fn();
const original = { animate: Element.prototype.animate };
let startViewTransition: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sistemaOscuro = false;
  reducirMovimiento = false;
  oyentes.clear();
  simularMatchMedia();
  animate.mockReset();
  Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
  startViewTransition = vi.fn((cb: () => void) => {
    cb();
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  });
  (document as unknown as { startViewTransition: unknown }).startViewTransition = startViewTransition;
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 800);
  localStorage.clear();
  document.documentElement.dataset.theme = "light";
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  Element.prototype.animate = original.animate;
  vi.unstubAllGlobals();
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
});

describe("useTheme: cambios que no son un clic", () => {
  it("el sistema pasa a oscuro y la persona sigue al sistema: círculo desde el centro de la ventana", async () => {
    renderHook(() => useTheme());

    await act(async () => {
      cambiarSistema(true);
    });

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.theme).toBe("dark");
    const [[fotogramas, opciones]] = animate.mock.calls;
    expect(fotogramas.clipPath[0]).toBe("circle(0px at 500px 400px)");
    expect(opciones.duration).toBe(620);
    expect(opciones.pseudoElement).toBe("::view-transition-new(root)");
  });

  it("con varios consumidores del hook (botón, selector de emojis) la transición ocurre UNA sola vez", async () => {
    renderHook(() => useTheme());
    renderHook(() => useTheme());

    await act(async () => {
      cambiarSistema(true);
    });

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("al desmontar al último consumidor se quita el aviso del sistema", async () => {
    const { unmount } = renderHook(() => useTheme());
    expect(oyentes.get("(prefers-color-scheme: dark)")?.size).toBe(1);

    unmount();

    expect(oyentes.get("(prefers-color-scheme: dark)")?.size ?? 0).toBe(0);
  });

  it("con prefers-reduced-motion el cambio del sistema es directo", async () => {
    reducirMovimiento = true;
    renderHook(() => useTheme());

    await act(async () => {
      cambiarSistema(true);
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
  });

  it("si la persona ya eligió un tema, el cambio del sistema no lo toca ni anima", async () => {
    localStorage.setItem("liminal-theme", "light");
    renderHook(() => useTheme());

    await act(async () => {
      cambiarSistema(true);
    });

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("el cambio que llega de OTRA pestaña (storage) se aplica sin animación", async () => {
    renderHook(() => useTheme());

    await act(async () => {
      localStorage.setItem("liminal-theme", "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: "liminal-theme" }));
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
  });
});
