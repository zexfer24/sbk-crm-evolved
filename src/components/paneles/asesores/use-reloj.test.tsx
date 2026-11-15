/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useReloj } from "./use-reloj";

/**
 * Plan "Paneles" (13/11/2026), C6: el reloj único de Asesores. Un solo
 * `setInterval` de 1 s para todos los contadores en vivo, y se detiene con la
 * pestaña oculta (`document.hidden`) para no gastar CPU ni batería.
 */

function ocultar(valor: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => valor });
  document.dispatchEvent(new Event("visibilitychange"));
}

const INICIO = new Date("2026-11-13T15:00:00-04:00");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(INICIO);
  ocultar(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useReloj", () => {
  it("arranca en el instante dado y avanza cada segundo", () => {
    const { result } = renderHook(() => useReloj(INICIO));
    expect(result.current.getTime()).toBe(INICIO.getTime());
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.getTime()).toBe(INICIO.getTime() + 3000);
  });

  it("usa un solo setInterval de 1 s", () => {
    const espia = vi.spyOn(globalThis, "setInterval");
    renderHook(() => useReloj(INICIO));
    expect(espia.mock.calls.filter(([, ms]) => ms === 1000)).toHaveLength(1);
  });

  it("con la pestaña oculta se detiene y al volver se pone al día", () => {
    const { result } = renderHook(() => useReloj(INICIO));
    act(() => {
      ocultar(true);
    });
    const antes = result.current.getTime();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.getTime()).toBe(antes);

    act(() => {
      ocultar(false);
    });
    expect(result.current.getTime()).toBe(INICIO.getTime() + 10_000);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.getTime()).toBe(INICIO.getTime() + 11_000);
  });

  it("sin nada que medir (activo = false) no crea ningún intervalo", () => {
    const espia = vi.spyOn(globalThis, "setInterval");
    renderHook(() => useReloj(INICIO, false));
    expect(espia.mock.calls.filter(([, ms]) => ms === 1000)).toHaveLength(0);
  });

  it("al desmontar limpia el intervalo", () => {
    const limpiar = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderHook(() => useReloj(INICIO));
    unmount();
    expect(limpiar).toHaveBeenCalled();
  });
});
