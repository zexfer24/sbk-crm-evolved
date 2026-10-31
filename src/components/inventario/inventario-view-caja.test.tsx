/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Agent, Product } from "@/lib/types";
import { InventarioView } from "@/components/inventario/inventario-view";

/**
 * Rol `caja` (13/10/2026, plan "Inventario y caja", T5): cuentas que solo
 * CONSULTAN el Inventario (precio, existencia, Cashea y carrito de
 * cotización). La base ya les impide guardar el peso; la pantalla tiene que
 * decirlo: sin otras secciones en el rail, sin campo de peso y sin el
 * subtítulo que habla de "cargar el peso a mano". Acá se usan el rail, la
 * navegación y la fila REALES — lo que se prueba es el cableado de
 * `soloLectura`, no un mock de él.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));

vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() } };
});

vi.mock("@/lib/inventory-data", () => ({
  fetchProduct: vi.fn(),
  fetchProductsByIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/mutations", () => ({ updateProductWeight: vi.fn() }));

// «Presupuestos guardados» (21/10/2026, T5): la caja también lo usa (D4); aquí llega vacío.
vi.mock("@/lib/presupuestos-data", () => ({
  fetchPresupuestos: vi.fn().mockResolvedValue([]),
  borrarPresupuesto: vi.fn(),
  borrarMisPresupuestos: vi.fn(),
}));

// El aviso de asignación no se monta para caja (lo prueba app-rail.test.tsx); aquí no hace falta su canal.
vi.mock("@/components/assignment-notifier", () => ({ AssignmentNotifier: () => null }));
vi.mock("@/components/url-search-box", () => ({ UrlSearchBox: () => null }));

function agente(role: Agent["role"]): Agent {
  return {
    id: "agent-1",
    displayName: "Caja 1",
    fullName: "Caja Uno",
    avatarUrl: null,
    role,
    isActive: true,
  };
}

const PRODUCTO: Product = {
  id: "p-1",
  name: "Carburador PZ27",
  brand: "Bera",
  price: 25,
  currency: "USD",
  stockQuantity: 10,
  description: null,
  isActive: true,
  updatedAt: "2026-10-13T10:00:00Z",
  compatibility: [],
  weightKg: null,
  saintCode: null,
  saintAddedAt: null,
  saintRemovedAt: null,
  shippingFeeUsd: null,
  precioDivisaUsd: null,
};

function pintar(role: Agent["role"]) {
  return render(
    <InventarioView
      currentAgent={agente(role)}
      products={[PRODUCTO]}
      total={1}
      totals={{ productos: 1, activos: 1, agotados: 0, bajos: 0, withoutWeight: 1, updatedAt: new Date().toISOString() }}
      catalog={{ engineFamilies: 1, commercialModels: 1, modelEngineLinks: 1, compatibilityRules: 1, searchSynonyms: 1 }}
      params={{ query: "", filter: "todos", sort: "nombre", page: 1 }}
      bcvRate={{ rate: 40, rateDate: "2026-10-13", isStale: false }}
    />
  );
}

describe("InventarioView — rol caja", () => {
  it("el rail y la navegación superior llevan solo Inventario", () => {
    const { container } = pintar("caja");

    const rail = Array.from(container.querySelectorAll(".dash-rail-btn[href]")).map((a) => a.getAttribute("aria-label"));
    expect(rail).toEqual(["Inventario"]);
    const nav = Array.from(container.querySelectorAll(".dash-nav a")).map((a) => a.textContent);
    expect(nav).toEqual(["Inventario"]);
    expect(screen.queryByLabelText("Bandeja")).toBeNull();
    expect(screen.queryByLabelText("Ventas")).toBeNull();
    expect(screen.getByLabelText("Cerrar sesión")).toBeInTheDocument();
  });

  it("no hay campos de peso: el peso se ve como texto", () => {
    pintar("caja");

    // La calculadora del mostrador (D4: la caja también la usa) trae su propio campo de monto.
    expect(screen.queryAllByRole("textbox").filter((el) => el.id !== "calc-monto")).toEqual([]);
    expect(screen.queryByRole("button", { name: /^Falta el peso: cargalo\s→$/ })).toBeNull();
    // El hueco del precio estándar ya no existe para la caja: ningún «Sin peso cargado».
    expect(screen.queryByText("Sin peso cargado")).toBeNull();
  });

  it("el subtítulo habla de consulta, no de cargar el peso a mano", () => {
    pintar("caja");

    expect(screen.queryByText(/lo único que se carga a mano es el peso/i)).toBeNull();
    expect(screen.getByText(/consulta de precios, existencia y Cashea/i)).toBeInTheDocument();
  });

  it("Cashea y el carrito siguen: son consulta, no escritura", () => {
    pintar("caja");

    expect(screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agregar Carburador PZ27 al carrito" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir carrito" })).toBeInTheDocument();
  });
});

describe("InventarioView — la caja no ve el precio estándar", () => {
  it("ningún texto, title ni aria-label de la pantalla menciona el estándar (con peso y sin peso)", () => {
    const { container, unmount } = pintar("caja");
    expect(container.innerHTML).not.toMatch(/est[aá]ndar/i);
    // El portal del carrito y los modales no viven en `container`: se mira todo el documento.
    expect(document.body.innerHTML).not.toMatch(/est[aá]ndar/i);
    expect(screen.queryByText("Precio estándar")).toBeNull();
    expect(screen.getByText("Precio promoción")).toBeInTheDocument();
    unmount();
  });

  it("la tarjeta «Sin peso» no habla del estándar para la caja, y para el asesor sigue igual", () => {
    pintar("caja");
    expect(screen.getByText("Cashea lo exige para el envío gratis.")).toBeInTheDocument();
  });

  it("con tarifa MRW cargada (un dato viejo en caché) la caja tampoco la ve", () => {
    render(
      <InventarioView
        currentAgent={agente("caja")}
        products={[{ ...PRODUCTO, weightKg: 1, shippingFeeUsd: 1.4 }]}
        total={1}
        totals={{ productos: 1, activos: 1, agotados: 0, bajos: 0, withoutWeight: 0, updatedAt: new Date().toISOString() }}
        catalog={{ engineFamilies: 1, commercialModels: 1, modelEngineLinks: 1, compatibilityRules: 1, searchSynonyms: 1 }}
        params={{ query: "", filter: "todos", sort: "nombre", page: 1 }}
        bcvRate={{ rate: 40, rateDate: "2026-10-13", isStale: false }}
      />
    );
    expect(document.body.innerHTML).not.toMatch(/est[aá]ndar|incluye envío MRW/i);
  });
});

describe("InventarioView — la caja usa los presupuestos y la calculadora (D4)", () => {
  it("las dos piezas están, dentro de .dash-content, y .dash-frame sigue con sus dos hijos (rail + main)", () => {
    const { container } = pintar("caja");

    expect(screen.getByRole("heading", { name: "Presupuestos guardados" })).toBeInTheDocument();
    expect(container.querySelector(".dash-content .inv-calc")).not.toBeNull();
    expect(container.querySelector(".dash-content .inv-presupuestos")).not.toBeNull();
    expect(container.querySelector(".dash-frame")!.childElementCount).toBe(2);
  });
});

describe("InventarioView — un asesor sigue viendo todo", () => {
  it("rail completo, campo de peso y sin subtítulo (se quitó el 30/10/2026)", () => {
    const { container } = pintar("agent");

    expect(container.querySelectorAll(".dash-rail-btn[href]").length).toBeGreaterThan(1);
    expect(screen.getByLabelText("Peso de Carburador PZ27")).toBeInTheDocument();
    expect(container.querySelector(".dash-subtitle")).toBeNull();
    expect(
      screen.getByText("Cashea lo exige para el envío gratis, y sin peso no hay precio estándar.")
    ).toBeInTheDocument();
    expect(screen.getByText("Precio estándar")).toBeInTheDocument();
  });
});
