import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La raíz `/` ya no pinta el Recorrido (se mudó a `/recorrido`, 15/11/2026,
 * plan "Paneles"): decide por rol adónde mandar a quien entra. Supervisor y
 * admin caen en el Dashboard de ventas (`/panel`); un asesor, en el Recorrido;
 * sin sesión, `/login`. Así siguen valiendo sin tocarlos el `router.push("/")`
 * del login, el `redirect("/")` de `login/page.tsx` y el del proxy.
 *
 * `redirect` de Next LANZA para cortar el render; el mock hace lo mismo.
 */

class Redireccion extends Error {
  constructor(public destino: string) {
    super(`redirect:${destino}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Redireccion(destino);
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({})),
}));

const fetchCurrentAgentMock = vi.fn();
vi.mock("@/lib/data", () => ({
  fetchCurrentAgent: (...args: unknown[]) => fetchCurrentAgentMock(...args),
}));

async function correrRaiz() {
  const { default: Raiz } = await import("./page");
  return Raiz();
}

describe("página raíz /", () => {
  beforeEach(() => {
    fetchCurrentAgentMock.mockReset();
  });

  it("sin sesión redirige a /login", async () => {
    fetchCurrentAgentMock.mockResolvedValue(null);

    await expect(correrRaiz()).rejects.toMatchObject({ destino: "/login" });
  });

  it.each(["supervisor", "admin"])("un %s cae en el Dashboard de ventas (/panel)", async (role) => {
    fetchCurrentAgentMock.mockResolvedValue({ id: "a-1", role });

    await expect(correrRaiz()).rejects.toMatchObject({ destino: "/panel" });
  });

  it.each(["agent", "caja", "rol-desconocido"])("un %s cae en el Recorrido (/recorrido)", async (role) => {
    fetchCurrentAgentMock.mockResolvedValue({ id: "a-2", role });

    await expect(correrRaiz()).rejects.toMatchObject({ destino: "/recorrido" });
  });

  it("si la consulta del agente falla, el error se propaga (ni redirige a ciegas)", async () => {
    fetchCurrentAgentMock.mockRejectedValue(new Error("base caída"));

    await expect(correrRaiz()).rejects.toThrow("base caída");
  });
});
