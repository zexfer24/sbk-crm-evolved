import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Plan "Paneles" (13/11/2026): `/panel` es solo de supervisor y admin. El
 * layout es el primer candado (el definitivo está en las RPC, con 42501); un
 * asesor que escribe la URL a mano termina en `/recorrido` (antes `/`; desde el 15/11/2026 se ahorra el salto), y quien no tiene sesión en
 * `/login`. La caja no llega acá: la frena el middleware. Desde el 15/11/2026 la
 * lógica vive en `acceso-servidor.ts` (la comparten el layout y cada página,
 * ver `paginas.test.ts`); acá se prueba que el layout la use.
 *
 * `redirect` de Next LANZA (para cortar el render); el mock hace lo mismo, y
 * así un test detecta un layout que siguiera de largo tras redirigir.
 */

class Redireccion extends Error {
  constructor(public destino: string) {
    super(`redirect:${destino}`);
  }
}

const redirectMock = vi.fn((destino: string) => {
  throw new Redireccion(destino);
});
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => redirectMock(destino),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({})),
}));

const fetchCurrentAgentMock = vi.fn();
vi.mock("@/lib/data", () => ({
  fetchCurrentAgent: (...args: unknown[]) => fetchCurrentAgentMock(...args),
}));

async function correrLayout() {
  const { default: PanelLayout } = await import("./layout");
  return PanelLayout({ children: "contenido" });
}

describe("panel/layout.tsx", () => {
  beforeEach(() => {
    redirectMock.mockClear();
    fetchCurrentAgentMock.mockReset();
  });

  it("sin sesión redirige a /login", async () => {
    fetchCurrentAgentMock.mockResolvedValue(null);

    await expect(correrLayout()).rejects.toMatchObject({ destino: "/login" });
  });

  it.each(["agent", "caja"])("un %s es redirigido a /recorrido", async (role) => {
    fetchCurrentAgentMock.mockResolvedValue({ id: "a-1", role });

    await expect(correrLayout()).rejects.toMatchObject({ destino: "/recorrido" });
    expect(redirectMock).toHaveBeenCalledWith("/recorrido");
  });

  it("si la consulta del agente falla, el error se propaga: ni deja pasar ni redirige", async () => {
    fetchCurrentAgentMock.mockRejectedValue(new Error("base caída"));

    await expect(correrLayout()).rejects.toThrow("base caída");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it.each(["supervisor", "admin"])("un %s pasa y recibe sus hijos", async (role) => {
    fetchCurrentAgentMock.mockResolvedValue({ id: "a-1", role });

    const resultado = await correrLayout();

    expect(redirectMock).not.toHaveBeenCalled();
    expect(resultado).toBeTruthy();
  });
});
