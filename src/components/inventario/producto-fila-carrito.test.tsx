/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Product } from "@/lib/types";
import { ProductoFila } from "@/components/inventario/producto-fila";
import { InventarioCarritoProvider } from "@/components/inventario/inventario-carrito-provider";

/**
 * Cableado de la fila del Inventario con el carrito y la calculadora Cashea
 * (12/10/2026, plan "Carrito de cotización en el Inventario, con Cashea", T5).
 * Va en un archivo aparte de `producto-fila.test.tsx` porque aquel mockea
 * `@heroui/react` con solo `toast.danger` y aquí hacen falta el Drawer y el
 * Modal reales (corren en jsdom); solo se sustituye `toast`.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...real,
    toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() },
  };
});

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({})),
}));

vi.mock("@/lib/mutations", () => ({
  updateProductWeight: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/inventory-data", () => ({
  fetchProductsByIds: vi.fn().mockResolvedValue([]),
}));

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "Carburador PZ27",
    brand: "Bera",
    price: 25,
    currency: "USD",
    stockQuantity: 10,
    description: null,
    isActive: true,
    updatedAt: "2026-10-12T10:00:00Z",
    compatibility: [],
    weightKg: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    shippingFeeUsd: null,
    ...over,
  };
}

function conCarrito(p: Product) {
  return render(
    <InventarioCarritoProvider agentId="agente-1" bcvRate={100}>
      <ul>
        <ProductoFila product={p} bcvRate={100} />
      </ul>
    </InventarioCarritoProvider>,
  );
}

describe("ProductoFila — botones del carrito", () => {
  it("dentro del provider muestra «Agregar al carrito» con su aria-label", () => {
    conCarrito(product());
    const boton = screen.getByRole("button", { name: "Agregar Carburador PZ27 al carrito" });
    expect(boton).toBeInTheDocument();
    expect(boton).toHaveTextContent("Agregar al carrito");
  });

  /** T2, plan "Inventario y caja" (13/10/2026): botones de verdad en su propio bloque, no insignias entre los estados. */
  it("«Agregar al carrito» y «Cashea» son botones en .inv-acciones, no dentro de .inv-status", () => {
    const { container } = conCarrito(product());
    const agregar = screen.getByRole("button", { name: "Agregar Carburador PZ27 al carrito" });
    const cashea = screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" });
    const acciones = container.querySelector(".inv-acciones");

    expect(acciones).toContainElement(agregar);
    expect(acciones).toContainElement(cashea);
    expect(agregar).toHaveClass("crm-pill", "inv-accion-btn");
    expect(agregar.getAttribute("type")).toBe("button");
    expect(agregar.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".inv-status")).not.toContainElement(agregar);
    expect(container.querySelector(".inv-status")).not.toContainElement(cashea);
    expect(container.querySelector("li")?.lastElementChild).toBe(acciones);
  });

  it("en solo lectura (caja) el carrito sigue disponible", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <InventarioCarritoProvider agentId="agente-1" bcvRate={100}>
        <ul>
          <ProductoFila product={product()} bcvRate={100} soloLectura />
        </ul>
      </InventarioCarritoProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Agregar Carburador PZ27 al carrito" }));
    expect(
      screen.getByRole("button", { name: /Sumar otra unidad de Carburador PZ27 \(hay 1 en el carrito\)/ }),
    ).toBeInTheDocument();
  });

  it("cada clic suma una unidad y el texto pasa a «En carrito ×N»", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    conCarrito(product());

    await user.click(screen.getByRole("button", { name: "Agregar Carburador PZ27 al carrito" }));
    const uno = screen.getByRole("button", { name: /Sumar otra unidad de Carburador PZ27 \(hay 1 en el carrito\)/ });
    expect(uno).toHaveTextContent("En carrito ×1");

    await user.click(uno);
    expect(
      screen.getByRole("button", { name: /Sumar otra unidad de Carburador PZ27 \(hay 2 en el carrito\)/ }),
    ).toHaveTextContent("En carrito ×2");
  });

  it("un producto que Saint dio de baja no se puede agregar", () => {
    conCarrito(product({ isActive: false }));
    const boton = screen.getByRole("button", { name: "Agregar Carburador PZ27 al carrito" });
    expect(boton).toBeDisabled();
    expect(boton).toHaveAttribute("title", "Saint lo dio de baja");
  });

  it("sin stock se deja agregar", () => {
    conCarrito(product({ stockQuantity: 0 }));
    expect(screen.getByRole("button", { name: "Agregar Carburador PZ27 al carrito" })).toBeEnabled();
  });

  it("«Cashea» abre la calculadora del producto", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    conCarrito(product());

    expect(screen.queryByText("Calcular con Cashea")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" }));
    expect(await screen.findByText("Calcular con Cashea")).toBeInTheDocument();
  });
});
