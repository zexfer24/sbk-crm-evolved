/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLiveRefresh, STALE_AFTER_MS } from "@/lib/use-live-refresh";

/**
 * F9 (4/9/2026): volver a la pestaña refresca si quedó algo anotado, pero
 * también si ya pasó demasiado tiempo sin un refresco real — un canal que se
 * cayó del realtime con la pestaña oculta no anota nada (no hubo evento que
 * perderse, el canal simplemente no escuchaba), así que sin este segundo
 * motivo la vista se hubiera quedado vieja hasta la pasada de fondo.
 */

function ocultarPestana(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

describe("useLiveRefresh — la pestaña vieja se repara sola al volver", () => {
  it("oculta más de STALE_AFTER_MS y sin nada pendiente: al volver, refresca igual", () => {
    const refresh = vi.fn();
    renderHook(() => useLiveRefresh(refresh, { safetyMs: null }));

    act(() => ocultarPestana(true));
    act(() => {
      vi.advanceTimersByTime(STALE_AFTER_MS + 60_000); // 3 minutos
    });
    expect(refresh).not.toHaveBeenCalled();

    act(() => ocultarPestana(false));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("oculta poco tiempo y sin nada pendiente: al volver, no refresca", () => {
    const refresh = vi.fn();
    renderHook(() => useLiveRefresh(refresh, { safetyMs: null }));

    act(() => ocultarPestana(true));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    act(() => ocultarPestana(false));

    expect(refresh).not.toHaveBeenCalled();
  });

  it("oculta poco tiempo pero con un pedido pendiente: al volver, refresca", () => {
    const refresh = vi.fn();
    const { result } = renderHook(() => useLiveRefresh(refresh, { safetyMs: null }));

    act(() => ocultarPestana(true));
    act(() => result.current());
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(refresh).not.toHaveBeenCalled();

    act(() => ocultarPestana(false));

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
