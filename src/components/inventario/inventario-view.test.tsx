/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Agent } from "@/lib/types";
import { InventarioView } from "@/components/inventario/inventario-view";

/**
 * El inventario se cargó el 24 de agosto de 2026 y no se volvió a tocar. La
 * sincronización vive en una aplicación aparte del dueño y todavía no corre —
 * pero esta pantalla mostraba 5.438 repuestos igual que si se hubieran cargado
 * esa mañana. El dueño se enteró consultando la base de datos.
 *
 * Es lo mismo que ya pasó con la tasa del BCV, y por eso la tarjeta nueva se
 * parece a aquella: el número grande y, pegada, la antigüedad.
 */

// Lo que se prueba acá es la tarjeta de antigüedad; los vecinos no pintan nada.
vi.mock("@/components/app-rail", () => ({ AppRail: () => null, AppTopNav: () => null }));
vi.mock("@/components/url-search-box", () => ({ UrlSearchBox: () => null }));
vi.mock("@/components/inventario/producto-fila", () => ({ ProductoFila: () => null }));

const ASESOR: Agent = {
  id: "agent-1",
  displayName: "Rosa",
  fullName: "Rosa Pérez",
  avatarUrl: null,
  role: "supervisor",
  isActive: true,
};

const CATALOGO = {
  engineFamilies: 12,
  commercialModels: 40,
  modelEngineLinks: 60,
  compatibilityRules: 900,
  searchSynonyms: 30,
};

function haceDias(dias: number): string {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

function pintar(updatedAt: string | null) {
  render(
    <InventarioView
      currentAgent={ASESOR}
      products={[]}
      total={0}
      totals={{ productos: 5438, activos: 5435, agotados: 2474, bajos: 300, updatedAt }}
      catalog={CATALOGO}
      params={{ query: "", filter: "todos", sort: "nombre", page: 1 }}
      bcvRate={{ rate: 791.3248, rateDate: "2026-08-27", isStale: false }}
    />
  );

  return screen.getByText("Actualizado").closest(".cli-stat");
}

describe("InventarioView — la antigüedad del inventario se ve", () => {
  it("muestra cuántos días lleva el catálogo sin cambios", () => {
    const tarjeta = pintar(haceDias(4));

    expect(tarjeta).toHaveTextContent("4 días");
    expect(tarjeta).toHaveTextContent(/La IA cotiza con esto/i);
  });

  /** El mismo tratamiento visual que la tasa vieja: si no se distingue, no sirve de nada. */
  it("marca la tarjeta como vieja para que se vea distinta", () => {
    expect(pintar(haceDias(4))).toHaveAttribute("data-stale", "true");
  });

  it("con el inventario de hoy no alarma", () => {
    const tarjeta = pintar(haceDias(0));

    expect(tarjeta).toHaveTextContent("Hoy");
    expect(tarjeta).not.toHaveAttribute("data-stale");
  });

  it("sin fecha lo dice, en vez de mostrar un cero", () => {
    const tarjeta = pintar(null);

    expect(tarjeta).toHaveTextContent("—");
    expect(tarjeta).toHaveTextContent(/no se sabe/i);
  });
});
