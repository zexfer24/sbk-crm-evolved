/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNumeroAnimado } from "./use-numero-animado";

/**
 * Plan "Paneles" (13/11/2026): las cifras grandes de los paneles suben o bajan
 * hasta su valor nuevo en ~0,9 s con rAF, salvo que el visor pida menos
 * movimiento (`prefers-reduced-motion`), caso en que saltan directo. Con timers
 * falsos no se usa `waitFor` (cuelga hasta el testTimeout, ver CLAUDE.md): se
 * avanza el reloj a mano dentro de `act`.
 */

function simularPreferenciaDeMovimiento(reducido: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reducido && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  });
}

describe("useNumeroAnimado", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("con prefers-reduced-motion devuelve siempre el valor final, sin animar", () => {
    simularPreferenciaDeMovimiento(true);
    const { result, rerender } = renderHook(({ valor }) => useNumeroAnimado(valor), { initialProps: { valor: 100 } });
    expect(result.current).toBe(100);

    rerender({ valor: 250 });

    expect(result.current).toBe(250);
  });

  it("arranca en el valor inicial (sin contar desde cero al montar)", () => {
    simularPreferenciaDeMovimiento(false);
    const { result } = renderHook(() => useNumeroAnimado(480));
    expect(result.current).toBe(480);
  });

  it("al cambiar el valor interpola desde el último mostrado y termina exacto", () => {
    simularPreferenciaDeMovimiento(false);
    const { result, rerender } = renderHook(({ valor }) => useNumeroAnimado(valor, { duracionMs: 900 }), {
      initialProps: { valor: 100 },
    });

    rerender({ valor: 200 });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const medio = result.current;
    expect(medio).toBeGreaterThan(100);
    expect(medio).toBeLessThan(200);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(200);
  });

  it("ease out: a un tercio del tiempo ya recorrió más de un tercio del camino", () => {
    simularPreferenciaDeMovimiento(false);
    const { result, rerender } = renderHook(({ valor }) => useNumeroAnimado(valor, { duracionMs: 900 }), {
      initialProps: { valor: 0 },
    });

    rerender({ valor: 300 });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current).toBeGreaterThan(100);
  });

  it("si el valor cambia a mitad de camino, sigue desde donde estaba (no salta de vuelta)", () => {
    simularPreferenciaDeMovimiento(false);
    const { result, rerender } = renderHook(({ valor }) => useNumeroAnimado(valor, { duracionMs: 900 }), {
      initialProps: { valor: 0 },
    });
    rerender({ valor: 1000 });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    const antes = result.current;
    expect(antes).toBeGreaterThan(0);

    rerender({ valor: 2000 });
    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(result.current).toBeGreaterThanOrEqual(antes);
    expect(result.current).toBeLessThan(2000);
  });
});
