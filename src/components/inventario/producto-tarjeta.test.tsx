/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { Product, ProductPhoto } from "@/lib/types";
import { ProductoTarjeta } from "@/components/inventario/producto-tarjeta";
import {
  CarritoContext,
  type InventarioCarritoValue,
} from "@/components/inventario/inventario-carrito-context";

/**
 * Tarjeta de la cuadrícula de /inventario (30/10/2026, plan «Cada repuesto con
 * su foto», T5b). Los helpers de precio ya los prueban `inventory.test.ts` y
 * `producto-fila.test.tsx`; acá se fija lo propio de la tarjeta: la píldora de
 * estado, la foto o su hueco, qué cifra va en la tercera columna según el rol y
 * los dos botones de ícono.
 */

// El Modal real de HeroUI no se monta acá: basta saber que la tarjeta abre la
// calculadora con el producto correcto (mismo criterio que producto-fila.test).
vi.mock("@/components/inventario/cashea-calculadora", () => ({
  CasheaCalculadora: ({ isOpen, product }: { isOpen: boolean; product: { name: string } }) =>
    isOpen ? <div role="dialog" aria-label={`Cashea ${product.name}`} /> : null,
}));

function foto(n: number, over: Partial<ProductPhoto> = {}): ProductPhoto {
  return { id: `f${n}`, storagePath: `prod-1/f${n}.jpg`, url: `https://cdn.test/prod-1/f${n}.jpg`, isPrimary: n === 1, position: n, ...over };
}

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
    updatedAt: "2026-09-08T10:00:00Z",
    compatibility: [],
    weightKg: 1.5,
    shippingFeeUsd: 4,
    precioDivisaUsd: 22,
    saintCode: "ABC-123",
    saintAddedAt: null,
    saintRemovedAt: null,
    fotos: [],
    ...over,
  };
}

const agregar = vi.fn();
let enCarrito = 0;

function conCarrito(children: ReactNode) {
  const value = { agregar, cantidadDe: () => enCarrito } as unknown as InventarioCarritoValue;
  return <CarritoContext.Provider value={value}>{children}</CarritoContext.Provider>;
}

function renderTarjeta(
  over: Partial<Product> = {},
  props: { soloLectura?: boolean; puedeEditarFotos?: boolean; onAbrirFicha?: (id: string) => void; carrito?: boolean } = {}
) {
  const { carrito = true, onAbrirFicha = vi.fn(), ...resto } = props;
  const ui = <ProductoTarjeta product={product(over)} bcvRate={40} onAbrirFicha={onAbrirFicha} {...resto} />;
  return { onAbrirFicha, ...render(<ul>{carrito ? conCarrito(ui) : ui}</ul>) };
}

beforeEach(() => {
  agregar.mockClear();
  enCarrito = 0;
});

describe("ProductoTarjeta — la píldora de estado", () => {
  it.each([
    ["En stock", "good", { stockQuantity: 10 }],
    ["Bajo stock", "wait", { stockQuantity: 3 }],
    ["Agotado", "hot", { stockQuantity: 0 }],
    ["Oculto a la IA", "muted", { isActive: false, stockQuantity: 10 }],
  ] as const)("%s", (texto, tono, over) => {
    renderTarjeta(over);
    expect(screen.getByText(texto)).toHaveAttribute("data-tone", tono);
  });
});

describe("ProductoTarjeta — la foto", () => {
  it("con foto pinta la principal con el nombre como alt", () => {
    renderTarjeta({ fotos: [foto(1)] });
    const img = screen.getByRole("img", { name: "Carburador PZ27" });
    expect(img).toHaveAttribute("src", "https://cdn.test/prod-1/f1.jpg");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("con varias fotos muestra el contador; con una sola no", () => {
    const { unmount } = renderTarjeta({ fotos: [foto(1), foto(2), foto(3)] });
    expect(screen.getByText("3")).toBeInTheDocument();
    unmount();
    renderTarjeta({ fotos: [foto(1)] });
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("sin foto y con permiso ofrece «Agregar foto»", () => {
    renderTarjeta({ fotos: [] }, { puedeEditarFotos: true });
    expect(screen.getByRole("button", { name: "Agregar foto a Carburador PZ27" })).toBeInTheDocument();
    expect(screen.getByText("Agregar foto")).toBeInTheDocument();
  });

  it("sin foto y sin permiso dice «Sin foto» y no ofrece agregar", () => {
    renderTarjeta({ fotos: [] }, { puedeEditarFotos: false });
    expect(screen.getByText("Sin foto")).toBeInTheDocument();
    expect(screen.queryByText("Agregar foto")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver ficha de Carburador PZ27" })).toBeInTheDocument();
  });

  it("tocar la foto abre la ficha de ese producto", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { onAbrirFicha } = renderTarjeta({ fotos: [foto(1)] });
    await user.click(screen.getByRole("img", { name: "Carburador PZ27" }));
    expect(onAbrirFicha).toHaveBeenCalledWith("prod-1");
  });

  it("tocar el hueco sin foto también abre la ficha", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { onAbrirFicha } = renderTarjeta({ fotos: [] }, { puedeEditarFotos: true });
    await user.click(screen.getByRole("button", { name: "Agregar foto a Carburador PZ27" }));
    expect(onAbrirFicha).toHaveBeenCalledWith("prod-1");
  });
});

describe("ProductoTarjeta — título y cifras", () => {
  it("muestra el nombre, el código de Saint y la marca", () => {
    renderTarjeta();
    expect(screen.getByText("Carburador PZ27")).toBeInTheDocument();
    expect(screen.getByText("ABC-123")).toBeInTheDocument();
    expect(screen.getByText("Bera")).toBeInTheDocument();
  });

  it("sin código dice «Sin código»", () => {
    renderTarjeta({ saintCode: null });
    expect(screen.getByText("Sin código")).toBeInTheDocument();
  });

  it("avisa «Nuevo desde Saint» cuando acaba de entrar", () => {
    renderTarjeta({ saintAddedAt: new Date().toISOString() });
    expect(screen.getByText("Nuevo desde Saint")).toBeInTheDocument();
  });

  it("el precio promoción lleva Bs y su pie en dólares con la misma regla de la fila", () => {
    renderTarjeta({ price: 25 });
    expect(screen.getByText("Precio promoción")).toBeInTheDocument();
    expect(screen.getByText("Bs. 1000.00")).toBeInTheDocument();
    expect(screen.getByText("$ 25.00")).toBeInTheDocument();
  });

  it("el precio estándar suma la tarifa MRW (Bs y pie en dólares)", () => {
    renderTarjeta({ price: 25, shippingFeeUsd: 4 });
    expect(screen.getByText("Precio estándar")).toBeInTheDocument();
    expect(screen.getByText("Bs. 1160.00")).toBeInTheDocument();
    expect(screen.getByText("$ 29.00")).toBeInTheDocument();
  });

  it("sin peso, el estándar es el botón «Falta el peso →» que abre la ficha", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { onAbrirFicha } = renderTarjeta({ weightKg: null, shippingFeeUsd: null });
    await user.click(screen.getByRole("button", { name: "Falta el peso →" }));
    expect(onAbrirFicha).toHaveBeenCalledWith("prod-1");
    expect(screen.getByText("Sin peso")).toBeInTheDocument();
  });

  it("el pie trae el peso con tres decimales y la divisa", () => {
    renderTarjeta({ weightKg: 1.5, precioDivisaUsd: 22 });
    expect(screen.getByText("1.500 kg")).toBeInTheDocument();
    expect(screen.getByText("$ 22.00")).toBeInTheDocument();
  });

  it("la caja (soloLectura) ve «Precio divisa» y no «Precio estándar»", () => {
    renderTarjeta({ precioDivisaUsd: 22 }, { soloLectura: true });
    expect(screen.getByText("Precio divisa")).toBeInTheDocument();
    expect(screen.queryByText("Precio estándar")).not.toBeInTheDocument();
    expect(screen.queryByText(/Bs\. 1160/)).not.toBeInTheDocument();
    expect(screen.getByText("$ 22.00")).toBeInTheDocument();
  });

  it("la caja sin precio divisa en SAINT lo dice, nunca un $ 0.00", () => {
    renderTarjeta({ precioDivisaUsd: null }, { soloLectura: true });
    expect(screen.getByText("Sin precio en SAINT")).toBeInTheDocument();
    expect(screen.queryByText("$ 0.00")).not.toBeInTheDocument();
  });

  it.each([
    [0, "agotado"],
    [3, "bajo"],
    [5, "bajo"],
    [6, "disponible"],
  ] as const)("el stock %i pinta la caja en nivel «%s»", (stock, nivel) => {
    renderTarjeta({ stockQuantity: stock });
    const caja = screen.getByLabelText(`Stock de Carburador PZ27`);
    expect(caja).toHaveTextContent(String(stock));
    expect(caja).toHaveAttribute("data-level", nivel);
  });
});

describe("ProductoTarjeta — las acciones", () => {
  it("el botón del carrito agrega el producto", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderTarjeta();
    const boton = screen.getByRole("button", { name: "Agregar Carburador PZ27 al carrito" });
    expect(boton).toHaveAttribute("title", "Agregar al carrito");
    await user.click(boton);
    expect(agregar).toHaveBeenCalledTimes(1);
    expect(agregar.mock.calls[0][0]).toMatchObject({ id: "prod-1" });
  });

  it("con unidades ya en el carrito, el aria-label ofrece sumar otra", () => {
    enCarrito = 2;
    renderTarjeta();
    expect(
      screen.getByRole("button", { name: "Sumar otra unidad de Carburador PZ27 (hay 2 en el carrito)" })
    ).toBeInTheDocument();
  });

  it("un producto que Saint dio de baja no se agrega", () => {
    renderTarjeta({ isActive: false });
    const boton = screen.getByRole("button", { name: "Agregar Carburador PZ27 al carrito" });
    expect(boton).toBeDisabled();
    expect(boton).toHaveAttribute("title", "Saint lo dio de baja");
  });

  it("sin provider no hay botón de carrito pero sí Cashea", () => {
    renderTarjeta({}, { carrito: false });
    expect(screen.queryByRole("button", { name: /al carrito/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" })).toBeInTheDocument();
  });

  it("el botón de Cashea trae el logo y abre la calculadora", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderTarjeta();
    const boton = screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" });
    expect(boton).toHaveAttribute("title", "Calcular Cashea");
    expect(boton.querySelector("svg rect[fill='#FFF83D']")).not.toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(boton);
    expect(screen.getByRole("dialog", { name: "Cashea Carburador PZ27" })).toBeInTheDocument();
  });

  it("los dos botones comparten el bloque de acciones", () => {
    renderTarjeta();
    const bloque = screen.getByRole("button", { name: "Calcular Cashea de Carburador PZ27" }).parentElement as HTMLElement;
    expect(within(bloque).getAllByRole("button")).toHaveLength(2);
  });
});
