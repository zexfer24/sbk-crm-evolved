/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Product } from "@/lib/types";
import { ProductoFila } from "@/components/inventario/producto-fila";

/**
 * T4 del plan "Seis frentes del buzón" (8/9/2026): el campo "Peso (kg)"
 * replica exactamente el patrón de stock/precio que ya probaba esta fila
 * antes de que existiera este archivo — guarda al salir del campo, revierte
 * con un error, y muestra "Sin peso" cuando `weightKg` es null (el estado en
 * el que nace todo producto, hasta que alguien lo completa).
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const toastDanger = vi.fn();
vi.mock("@heroui/react", () => ({ toast: { danger: (...args: unknown[]) => toastDanger(...args) } }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({})),
}));

const updateProductWeight = vi.fn().mockResolvedValue(undefined);
const updateProductStock = vi.fn().mockResolvedValue(undefined);
const setProductActive = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/mutations", () => ({
  updateProductWeight: (...args: unknown[]) => updateProductWeight(...args),
  updateProductStock: (...args: unknown[]) => updateProductStock(...args),
  setProductActive: (...args: unknown[]) => setProductActive(...args),
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
    updatedAt: "2026-09-08T10:00:00Z",
    compatibility: [],
    weightKg: null,
    ...over,
  };
}

function pesoInput() {
  return screen.getByLabelText("Peso de Carburador PZ27");
}

function stockInput() {
  return screen.getByLabelText("Stock de Carburador PZ27");
}

describe("ProductoFila — el campo Peso", () => {
  beforeEach(() => {
    refresh.mockClear();
    toastDanger.mockClear();
    updateProductWeight.mockClear();
    updateProductWeight.mockResolvedValue(undefined);
  });

  it("arranca vacío cuando el producto todavía no tiene peso cargado", () => {
    render(<ProductoFila product={product({ weightKg: null })} bcvRate={40} />);
    expect(pesoInput()).toHaveValue("");
  });

  it("arranca con tres decimales cuando ya hay un peso guardado", () => {
    render(<ProductoFila product={product({ weightKg: 0.5 })} bcvRate={40} />);
    expect(pesoInput()).toHaveValue("0.500");
  });

  it("escribir con coma y salir del campo guarda el kilo tal cual", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<ProductoFila product={product({ weightKg: null })} bcvRate={40} />);

    await user.clear(pesoInput());
    await user.type(pesoInput(), "0,250");
    await user.tab();

    await waitFor(() => expect(updateProductWeight).toHaveBeenCalledWith(expect.anything(), "prod-1", 0.25));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("un valor inválido no llama a la mutación: revierte el borrador y avisa", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<ProductoFila product={product({ weightKg: 1 })} bcvRate={40} />);

    await user.clear(pesoInput());
    await user.type(pesoInput(), "pesado");
    await user.tab();

    expect(updateProductWeight).not.toHaveBeenCalled();
    expect(toastDanger).toHaveBeenCalled();
    await waitFor(() => expect(pesoInput()).toHaveValue("1.000"));
  });

  it("si la mutación falla, revierte al valor anterior y avisa", async () => {
    updateProductWeight.mockRejectedValueOnce(new Error("caído"));
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<ProductoFila product={product({ weightKg: 1 })} bcvRate={40} />);

    await user.clear(pesoInput());
    await user.type(pesoInput(), "2");
    await user.tab();

    await waitFor(() => expect(toastDanger).toHaveBeenCalledWith("No se pudo guardar el cambio."));
    await waitFor(() => expect(pesoInput()).toHaveValue("1.000"));
  });

  it("sin peso muestra el badge que explica por qué importa", () => {
    render(<ProductoFila product={product({ weightKg: null })} bcvRate={40} />);
    expect(screen.getByText("Sin peso")).toBeInTheDocument();
  });

  it("con peso cargado no muestra el badge", () => {
    render(<ProductoFila product={product({ weightKg: 3 })} bcvRate={40} />);
    expect(screen.queryByText("Sin peso")).not.toBeInTheDocument();
  });
});

/**
 * T1 del plan "El precio se lee en bolívares" (19/9/2026): el precio deja de
 * editarse desde el CRM — llega de `products`, que se carga por fuera. Ya no
 * hay un textbox "Precio de …", solo texto: bolívares arriba (la cifra
 * principal, `priceDisplay`), dólares en el pie. Reemplaza al escenario
 * anterior (10/9/2026, T7) donde era al revés — USD arriba, "Bs. …" chico
 * SOLO en productos en dólares — y donde el campo todavía se guardaba con
 * `updateProductPrice` (borrada en esta misma corrida). El pie `.inv-bs`
 * sigue reservándose SIEMPRE (con o sin texto), mismo motivo de T7: si solo
 * aparece a veces, ese campo queda más alto y descuadra Stock/Peso (ver
 * `inventario-css.test.ts`, que mira la hoja de estilos porque jsdom no
 * calcula ese layout).
 */
describe("ProductoFila — el precio, de solo lectura", () => {
  it("ya no existe un textbox de Precio: es texto, no un input", () => {
    render(<ProductoFila product={product()} bcvRate={40} />);
    expect(screen.queryByRole("textbox", { name: /Precio de/ })).toBeNull();
  });

  it("USD con tasa: bolívares como cifra principal, dólares en el pie", () => {
    render(<ProductoFila product={product({ currency: "USD", price: 25 })} bcvRate={40} />);
    const precio = screen.getByLabelText("Precio de Carburador PZ27");
    const pie = precio.closest(".inv-field")?.querySelector(".inv-bs");

    expect(precio).toHaveTextContent("Bs. 1000.00");
    expect(pie).toHaveTextContent("$ 25.00");
  });

  it("VES con tasa: bolívares como cifra principal, el equivalente en dólares en el pie", () => {
    render(<ProductoFila product={product({ currency: "VES", price: 1000 })} bcvRate={40} />);
    const precio = screen.getByLabelText("Precio de Carburador PZ27");
    const pie = precio.closest(".inv-field")?.querySelector(".inv-bs");

    expect(precio).toHaveTextContent("Bs. 1000.00");
    expect(pie).toHaveTextContent("$ 25.00");
  });

  it("sin tasa no inventa el pie: la cifra principal queda en la moneda propia del producto", () => {
    render(<ProductoFila product={product({ currency: "USD", price: 25 })} bcvRate={0} />);
    const precio = screen.getByLabelText("Precio de Carburador PZ27");
    const pie = precio.closest(".inv-field")?.querySelector(".inv-bs");

    expect(precio).toHaveTextContent("$ 25.00");
    expect(pie).not.toBeNull();
    expect(pie).toHaveTextContent("");
  });

  it("los campos Stock y Peso también llevan su pie, vacío", () => {
    render(<ProductoFila product={product()} bcvRate={40} />);
    const stockField = screen.getByLabelText("Stock de Carburador PZ27").closest(".inv-field");
    const pesoField = screen.getByLabelText("Peso de Carburador PZ27").closest(".inv-field");

    expect(stockField?.querySelector(".inv-bs")).not.toBeNull();
    expect(pesoField?.querySelector(".inv-bs")).not.toBeNull();
  });
});

/**
 * Stock y Peso siguen siendo editables (D3 del plan: "el pedido habla solo
 * de precios") — este caso de Stock no estaba cubierto en este archivo
 * (solo Peso, T4 del 8/9/2026): lo suma esta corrida para dejar constancia
 * de que el refactor del campo Precio no le tocó el guardado a los otros dos.
 */
describe("ProductoFila — Stock sigue guardando", () => {
  beforeEach(() => {
    refresh.mockClear();
    toastDanger.mockClear();
    updateProductStock.mockClear();
    updateProductStock.mockResolvedValue(undefined);
  });

  it("escribir un stock nuevo y salir del campo lo guarda", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<ProductoFila product={product({ stockQuantity: 10 })} bcvRate={40} />);

    await user.clear(stockInput());
    await user.type(stockInput(), "14");
    await user.tab();

    await waitFor(() => expect(updateProductStock).toHaveBeenCalledWith(expect.anything(), "prod-1", 14));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
