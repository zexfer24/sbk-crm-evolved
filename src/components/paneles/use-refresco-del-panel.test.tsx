/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  INTERVALO_REFRESCO_MS,
  REFRESCO_AL_VOLVER_MS,
  useRefrescoDelPanel,
} from "./use-refresco-del-panel";

/**
 * Plan "Los paneles cuentan desde el lunes 16/11/2026 y se refrescan solos"
 * (T5, 21/11/2026): el refresco automático de los paneles. Con timers falsos
 * NO se usa `waitFor` (CLAUDE.md): se avanza el reloj y se ceden microtareas.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}));

// `isPending` de una transición real dura lo que tarda el servidor; con
// `router.refresh` espía no hay forma fiable de dejarlo pendiente. Este mock
// envuelve el `useTransition` real y, con `simularPendiente`, solo FUERZA el
// valor de `isPending` (el orden de los hooks no cambia).
const estado = vi.hoisted(() => ({ simularPendiente: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useTransition: () => {
      const [pendiente, empezar] = actual.useTransition();
      return [estado.simularPendiente ? true : pendiente, empezar] as ReturnType<typeof actual.useTransition>;
    },
  };
});

let oculto = false;
function ponerOculto(valor: boolean) {
  oculto = valor;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => oculto });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function avanzar(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-21T13:00:00Z"));
  refresh.mockClear();
  estado.simularPendiente = false;
  oculto = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => oculto });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRefrescoDelPanel", () => {
  it("las constantes valen lo que dice el plan", () => {
    expect(INTERVALO_REFRESCO_MS).toBe(60_000);
    expect(REFRESCO_AL_VOLVER_MS).toBe(30_000);
  });

  it("llama refresh a los 60 s, a los 120 s (dos veces) y no antes", async () => {
    renderHook(() => useRefrescoDelPanel());
    await avanzar(59_999);
    expect(refresh).toHaveBeenCalledTimes(0);
    await avanzar(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await avanzar(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("con la pestaña oculta desde el inicio no crea ningún intervalo", async () => {
    oculto = true;
    renderHook(() => useRefrescoDelPanel());
    await avanzar(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(0);
  });

  it("oculta 45 s y al mostrarla refresca ya", async () => {
    renderHook(() => useRefrescoDelPanel());
    await act(async () => ponerOculto(true));
    await avanzar(45_000);
    expect(refresh).toHaveBeenCalledTimes(0);
    await act(async () => ponerOculto(false));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("oculta 10 s no refresca al volver, y el siguiente llega a los 60 s de reanudar", async () => {
    renderHook(() => useRefrescoDelPanel());
    await act(async () => ponerOculto(true));
    await avanzar(10_000);
    await act(async () => ponerOculto(false));
    expect(refresh).toHaveBeenCalledTimes(0);
    await avanzar(59_999);
    expect(refresh).toHaveBeenCalledTimes(0);
    await avanzar(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refrescar() llama una vez, y al desmontar no queda ningún intervalo", async () => {
    const { result, unmount } = renderHook(() => useRefrescoDelPanel());
    await act(async () => result.current.refrescar());
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    await avanzar(10 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("al desmontar tampoco reacciona a la visibilidad", async () => {
    const { unmount } = renderHook(() => useRefrescoDelPanel());
    unmount();
    await act(async () => ponerOculto(true));
    await avanzar(45_000);
    await act(async () => ponerOculto(false));
    expect(refresh).toHaveBeenCalledTimes(0);
  });

  it("no apila: con un refresco en curso el tick no dispara otro, ni el botón a mano", async () => {
    estado.simularPendiente = true;
    const { result, rerender } = renderHook(() => useRefrescoDelPanel());
    expect(result.current.refrescando).toBe(true);
    await avanzar(60_000);
    expect(refresh).toHaveBeenCalledTimes(0);
    await act(async () => result.current.refrescar());
    expect(refresh).toHaveBeenCalledTimes(0);
    // En cuanto termina, el siguiente tick vuelve a refrescar.
    estado.simularPendiente = false;
    rerender();
    await avanzar(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
