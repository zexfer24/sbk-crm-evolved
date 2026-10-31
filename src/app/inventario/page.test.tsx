import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

/**
 * La página de /inventario lee la vista elegida (30/10/2026, plan «Cada repuesto
 * con su foto», T5a, D4) de la cookie `sbk-inventario-vista` EN EL SERVIDOR y se
 * la pasa a la vista ya resuelta: si la leyera el navegador, la primera pintura
 * sería siempre Lista y un instante después saltaría a Cuadrícula.
 *
 * Es un componente de servidor `async`: se invoca como una función y se mira el
 * elemento que devuelve.
 */

const cookieGet = vi.fn<(nombre: string) => { name: string; value: string } | undefined>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));

const redirect = vi.fn((destino: string) => {
  throw new Error(`NEXT_REDIRECT ${destino}`);
});
vi.mock("next/navigation", () => ({ redirect: (destino: string) => redirect(destino) }));

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));

const fetchCurrentAgent = vi.fn();
vi.mock("@/lib/data", () => ({ fetchCurrentAgent: (...args: unknown[]) => fetchCurrentAgent(...args) }));

vi.mock("@/lib/inventory-data", () => ({
  fetchProductsPage: vi.fn(async () => ({ products: [], total: 0 })),
  fetchInventoryTotals: vi.fn(async () => ({
    productos: 0,
    activos: 0,
    agotados: 0,
    bajos: 0,
    withoutWeight: 0,
    conFoto: 0,
    updatedAt: null,
  })),
  fetchMotoCatalogSummary: vi.fn(async () => ({
    engineFamilies: 0,
    commercialModels: 0,
    modelEngineLinks: 0,
    compatibilityRules: 0,
    searchSynonyms: 0,
  })),
}));

vi.mock("@/lib/ai/bcv", () => ({
  getBcvRate: vi.fn(async () => ({ rate: 40, rateDate: "2026-10-30", isStale: false })),
}));

// La vista real arrastra el árbol entero del cliente: aquí solo importa con qué props se la monta.
vi.mock("@/components/inventario/inventario-view", () => ({ InventarioView: () => null }));

import InventarioPage from "@/app/inventario/page";

const AGENTE = { id: "a1", displayName: "Rosa", fullName: "Rosa", avatarUrl: null, role: "supervisor", isActive: true };

async function vistaQueRecibe(): Promise<string | undefined> {
  const elemento = (await InventarioPage({ searchParams: Promise.resolve({}) })) as ReactElement<{ vista?: string }>;
  return elemento.props.vista;
}

beforeEach(() => {
  cookieGet.mockReset();
  redirect.mockClear();
  fetchCurrentAgent.mockReset();
  fetchCurrentAgent.mockResolvedValue(AGENTE);
});

describe("/inventario — la vista viene de la cookie", () => {
  it("pregunta por la cookie `sbk-inventario-vista`", async () => {
    await vistaQueRecibe();
    expect(cookieGet).toHaveBeenCalledWith("sbk-inventario-vista");
  });

  it("con la cookie «cuadricula» pasa vista=\"cuadricula\"", async () => {
    cookieGet.mockReturnValue({ name: "sbk-inventario-vista", value: "cuadricula" });
    expect(await vistaQueRecibe()).toBe("cuadricula");
  });

  it("con la cookie «lista» pasa vista=\"lista\"", async () => {
    cookieGet.mockReturnValue({ name: "sbk-inventario-vista", value: "lista" });
    expect(await vistaQueRecibe()).toBe("lista");
  });

  it("sin cookie la vista inicial es Lista (D4)", async () => {
    cookieGet.mockReturnValue(undefined);
    expect(await vistaQueRecibe()).toBe("lista");
  });

  it("una cookie con basura cae en Lista, no rompe", async () => {
    cookieGet.mockReturnValue({ name: "sbk-inventario-vista", value: "tabla" });
    expect(await vistaQueRecibe()).toBe("lista");
  });

  it("sin sesión sigue mandando a /login", async () => {
    fetchCurrentAgent.mockResolvedValue(null);
    await expect(vistaQueRecibe()).rejects.toThrow("NEXT_REDIRECT /login");
  });
});
