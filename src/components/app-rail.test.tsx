/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppRail, AppTopNav } from "@/components/app-rail";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));

const SECCIONES = [
  ["Recorrido", "/"],
  ["Bandeja", "/inbox"],
  ["Clientes", "/clientes"],
  ["Ventas", "/ventas"],
  ["Inventario", "/inventario"],
  ["Control de IA", "/agent-control"],
] as const;

describe("AppRail", () => {
  // El rail estaba copiado en cuatro pantallas; el punto de extraerlo es que
  // agregar una sección no dependa de acordarse de editar las cuatro.
  it("ofrece las seis secciones con su destino", () => {
    render(<AppRail active="clientes" />);

    for (const [label, href] of SECCIONES) {
      expect(screen.getByLabelText(label).getAttribute("href")).toBe(href);
    }
  });

  it("marca solo la sección activa", () => {
    render(<AppRail active="inventario" />);

    expect(screen.getByLabelText("Inventario").getAttribute("data-active")).toBe("true");
    expect(screen.getByLabelText("Inventario").getAttribute("aria-current")).toBe("page");
    expect(screen.getByLabelText("Clientes").getAttribute("data-active")).toBeNull();
  });

  it("siempre deja a mano el cierre de sesión", () => {
    render(<AppRail active="bandeja" />);
    expect(screen.getByLabelText("Cerrar sesión")).toBeTruthy();
  });

  // La bandeja a pantalla completa y las pantallas enmarcadas siguen usando
  // dos familias de clases distintas en el CSS.
  it("respeta el prefijo de clase de cada familia de pantallas", () => {
    const { container, unmount } = render(<AppRail active="bandeja" variant="crm" />);
    expect(container.querySelector(".crm-rail")).toBeTruthy();
    unmount();

    const { container: dash } = render(<AppRail active="ventas" variant="dash" />);
    expect(dash.querySelector(".dash-rail")).toBeTruthy();
  });
});

describe("AppTopNav", () => {
  it("lleva las mismas secciones que el rail", () => {
    render(<AppTopNav active="ventas" />);

    for (const [label, href] of SECCIONES) {
      expect(screen.getByText(label).getAttribute("href")).toBe(href);
    }
  });

  it("marca la sección activa para lectores de pantalla", () => {
    render(<AppTopNav active="ventas" />);
    expect(screen.getByText("Ventas").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Clientes").getAttribute("aria-current")).toBeNull();
  });
});
