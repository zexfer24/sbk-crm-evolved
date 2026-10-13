/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Product } from "@/lib/types";
import { CarritoBoton } from "@/components/inventario/carrito-boton";
import {
  InventarioCarritoProvider,
  useInventarioCarrito,
} from "@/components/inventario/inventario-carrito-provider";

/**
 * Botón flotante del carrito (13/10/2026, plan "Inventario y caja", T3): pasó
 * de la cabecera a un círculo fijo abajo a la derecha, con un globo de
 * unidades. Que sea `position: fixed` (lo fija `inventario-css.test.ts`, jsdom
 * no calcula layout) lo saca del flujo: es lo que permite montarlo dentro de
 * la vista sin sumarle una columna a la grilla de `.dash-frame`.
 */

vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() } };
});

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({})) }));

vi.mock("@/lib/inventory-data", () => ({
  fetchProductsByIds: vi.fn().mockResolvedValue([]),
}));

const PRODUCTO: Product = {
  id: "a",
  name: "Carburador PZ27",
  brand: null,
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
};

/** Agrega unidades desde el contexto, como lo haría una fila. */
function Agregador() {
  const carrito = useInventarioCarrito();
  return (
    <button type="button" onClick={() => carrito?.agregar(PRODUCTO)}>
      agregar de prueba
    </button>
  );
}

function montar() {
  const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
  const { container } = render(
    <InventarioCarritoProvider agentId="agente-1" bcvRate={100}>
      <Agregador />
      <CarritoBoton />
    </InventarioCarritoProvider>,
  );
  return { user, container };
}

describe("CarritoBoton — botón flotante", () => {
  it("es el botón redondo flotante, no una píldora de la cabecera", () => {
    montar();
    const boton = screen.getByRole("button", { name: "Abrir carrito" });

    expect(boton).toHaveClass("inv-carrito-flotante");
    expect(boton).not.toHaveClass("crm-pill");
    expect(boton).toHaveAttribute("type", "button");
    expect(boton.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("en cero no pinta el globo y no deja texto suelto", () => {
    montar();
    const boton = screen.getByRole("button", { name: "Abrir carrito" });

    expect(boton.querySelector(".inv-carrito-globo")).toBeNull();
    expect(boton).toHaveTextContent("");
  });

  it("con unidades pinta el globo con el número y el aria-label las cuenta", async () => {
    const { user } = montar();
    await user.click(screen.getByText("agregar de prueba"));
    await user.click(screen.getByText("agregar de prueba"));

    const boton = screen.getByRole("button", { name: "Abrir carrito (2 unidades)" });
    const globo = boton.querySelector(".inv-carrito-globo");
    expect(globo).toHaveTextContent("2");
    expect(globo).toHaveAttribute("aria-hidden", "true");
    expect(globo).toHaveClass("lm-num");
  });

  it("con una sola unidad el aria-label va en singular", async () => {
    const { user } = montar();
    await user.click(screen.getByText("agregar de prueba"));

    expect(screen.getByRole("button", { name: "Abrir carrito (1 unidad)" })).toBeInTheDocument();
  });

  it("al pulsarlo abre el panel del carrito", async () => {
    const { user } = montar();
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Abrir carrito" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("fuera del provider no pinta nada", () => {
    const { container } = render(<CarritoBoton />);
    expect(container).toBeEmptyDOMElement();
  });
});
