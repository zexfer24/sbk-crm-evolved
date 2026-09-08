/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useInboxDay } from "@/lib/use-inbox-day";
import type { InboxDayScope } from "@/lib/types";

// ---------------------------------------------------------------------------
// T1 del plan "Seis frentes del buzón" (8/9/2026). `America/Caracas` es
// UTC-4 sin horario de verano, así que la medianoche local del 8/9/2026 es
// las 04:00 UTC del mismo día — ese es el valor que este hook tiene que
// devolver mientras dure ese día calendario en Caracas.
//
// `vi.setSystemTime` + `vi.advanceTimersByTime`: `useClock` (use-clock.ts)
// cuantiza al minuto con `setInterval`, así que hay que avanzar el reloj
// falso para que el hook se entere de que rodó el día — igual que hace
// `conversation-list-item.test.tsx` con la píldora de ventana de 24h.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useInboxDay", () => {
  it('con scope "today", devuelve la medianoche de HOY en America/Caracas (04:00 UTC)', () => {
    vi.setSystemTime(new Date("2026-09-08T15:00:00.000Z"));

    const { result } = renderHook(() => useInboxDay("today"));

    expect(result.current).toBe("2026-09-08T04:00:00.000Z");
  });

  it('con scope "all", no hay corte: devuelve null aunque haya hora puesta', () => {
    vi.setSystemTime(new Date("2026-09-08T15:00:00.000Z"));

    const { result } = renderHook(() => useInboxDay("all"));

    expect(result.current).toBeNull();
  });

  it("antes de la medianoche de Caracas, el corte sigue siendo el de ayer", () => {
    // 2026-09-08T03:59:00Z: todavía 23:59 del 7/9 en Caracas (UTC-4).
    vi.setSystemTime(new Date("2026-09-08T03:59:00.000Z"));

    const { result } = renderHook(() => useInboxDay("today"));

    expect(result.current).toBe("2026-09-07T04:00:00.000Z");
  });

  it("rueda solo cuando el reloj cruza la medianoche de Caracas, no en cada minuto que pasa", () => {
    vi.setSystemTime(new Date("2026-09-08T03:59:00.000Z"));
    const { result } = renderHook(() => useInboxDay("today"));
    expect(result.current).toBe("2026-09-07T04:00:00.000Z");

    // Un minuto más tarde, todavía del lado de ayer en Caracas (03:59 UTC es
    // 23:59 del 7/9; +1 min sigue siendo 04:00 UTC = medianoche EXACTA, el
    // primer minuto que ya cuenta como "hoy" 8/9).
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe("2026-09-08T04:00:00.000Z");

    // Otro minuto más: sigue siendo el mismo día, el corte no se mueve.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe("2026-09-08T04:00:00.000Z");

    // Un día entero después: el corte avanza a la medianoche del día nuevo.
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });
    expect(result.current).toBe("2026-09-09T04:00:00.000Z");
  });

  it('cambiar de "today" a "all" entre renders apaga el corte sin que haga falta remontar', () => {
    vi.setSystemTime(new Date("2026-09-08T15:00:00.000Z"));

    const { result, rerender } = renderHook(
      ({ scope }: { scope: InboxDayScope }) => useInboxDay(scope),
      { initialProps: { scope: "today" } }
    );
    expect(result.current).toBe("2026-09-08T04:00:00.000Z");

    rerender({ scope: "all" });
    expect(result.current).toBeNull();

    rerender({ scope: "today" });
    expect(result.current).toBe("2026-09-08T04:00:00.000Z");
  });
});
