/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDebouncedCallback", () => {
  it("agrupa varias llamadas rápidas en una sola ejecución tras el delay", () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(callback, 750));

    result.current();
    vi.advanceTimersByTime(300);
    result.current();
    vi.advanceTimersByTime(300);
    result.current();

    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(750);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("permite volver a disparar después de que ya se ejecutó una vez", () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(callback, 750));

    result.current();
    vi.advanceTimersByTime(750);
    expect(callback).toHaveBeenCalledTimes(1);

    result.current();
    vi.advanceTimersByTime(750);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("cancela el timer pendiente al desmontar, sin llamar al callback", () => {
    const callback = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(callback, 750));

    result.current();
    unmount();
    vi.advanceTimersByTime(750);

    expect(callback).not.toHaveBeenCalled();
  });

  it("siempre usa la versión más reciente del callback, no la de la primera llamada", () => {
    let calls = 0;
    const first = () => {
      calls = 1;
    };
    const second = () => {
      calls = 2;
    };
    const { result, rerender } = renderHook(({ cb }) => useDebouncedCallback(cb, 750), {
      initialProps: { cb: first },
    });

    rerender({ cb: second });
    result.current();
    vi.advanceTimersByTime(750);

    expect(calls).toBe(2);
  });
});
