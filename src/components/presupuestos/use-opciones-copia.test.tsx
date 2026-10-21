/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useOpcionesCopia } from "@/components/presupuestos/use-opciones-copia";
import { COPIA_STORAGE_PREFIX, OPCIONES_COPIA_INICIALES } from "@/lib/copia-carrito";

// 21/10/2026, "Presupuestos y mensajes rápidos" (T3).

beforeEach(() => {
  window.localStorage.clear();
});

describe("useOpcionesCopia", () => {
  it("arranca con lo guardado para ese asesor", () => {
    window.localStorage.setItem(`${COPIA_STORAGE_PREFIX}a1`, JSON.stringify({ codigo: false }));
    const { result } = renderHook(() => useOpcionesCopia("a1"));
    expect(result.current[0]).toEqual({ ...OPCIONES_COPIA_INICIALES, codigo: false });
  });

  it("setOpciones actualiza el estado y lo recuerda para la próxima vez", () => {
    const { result, unmount } = renderHook(() => useOpcionesCopia("a1"));

    act(() => result.current[1]({ ...OPCIONES_COPIA_INICIALES, totalBs: false }));

    expect(result.current[0].totalBs).toBe(false);
    unmount();
    const otra = renderHook(() => useOpcionesCopia("a1"));
    expect(otra.result.current[0].totalBs).toBe(false);
  });

  it("si el asesor cambia (el perfil llega después), relee SUS casillas", () => {
    window.localStorage.setItem(`${COPIA_STORAGE_PREFIX}a2`, JSON.stringify({ subtotal: false }));
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useOpcionesCopia(id), {
      initialProps: { id: null as string | null },
    });
    expect(result.current[0]).toEqual(OPCIONES_COPIA_INICIALES);

    rerender({ id: "a2" });

    expect(result.current[0]).toEqual({ ...OPCIONES_COPIA_INICIALES, subtotal: false });
  });
});
