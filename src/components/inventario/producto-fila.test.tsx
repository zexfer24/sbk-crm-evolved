/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
vi.mock("@/lib/mutations", () => ({
  updateProductWeight: (...args: unknown[]) => updateProductWeight(...args),
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
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    ...over,
  };
}

function pesoInput() {
  return screen.getByLabelText("Peso de Carburador PZ27");
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
 * T3 del plan "El inventario llega de Saint y no se toca a mano" (25/9/2026):
 * Stock deja de editarse desde acá, mismo motivo y mismo patrón que el
 * precio el 19/9/2026 — `saint.sync_products()` es el único que escribe
 * `stock_quantity`. Reemplaza al escenario anterior ("Stock sigue
 * guardando", sumado el 19/9/2026 para dejar constancia de que el refactor
 * del precio no le tocaba el guardado a Stock/Peso): ahora es Stock el que
 * deja de guardarse.
 */
describe("ProductoFila — el stock, de solo lectura", () => {
  it("no hay un textbox de Stock: es texto, con el número tal cual llega de Saint", () => {
    render(<ProductoFila product={product({ stockQuantity: 14 })} bcvRate={40} />);

    expect(screen.queryByRole("textbox", { name: /Stock de/ })).toBeNull();
    expect(screen.getByLabelText("Stock de Carburador PZ27")).toHaveTextContent("14");
  });
});

/**
 * El botón Activar/Desactivar salió de la fila el 25/9/2026: `is_active` ya
 * no es una decisión que se tome desde el CRM, la escribe Saint. Que el
 * repuesto esté oculto a la IA se sigue viendo (badge "Oculto a la IA",
 * `aiVisibility`), pero ya no hay ninguna acción para cambiarlo acá.
 */
describe("ProductoFila — sin botón Activar/Desactivar", () => {
  it("no hay ningún botón para cambiar la visibilidad a mano", () => {
    render(<ProductoFila product={product({ isActive: true })} bcvRate={40} />);
    expect(screen.queryByRole("button", { name: /activar|desactivar/i })).toBeNull();
  });

  it("tampoco lo hay en un producto ya inactivo", () => {
    render(<ProductoFila product={product({ isActive: false })} bcvRate={40} />);
    expect(screen.queryByRole("button", { name: /activar|desactivar/i })).toBeNull();
  });
});

/**
 * Badge "Nuevo desde Saint" (T2/T3 del mismo plan, decisión del operador del
 * 24/9/2026: 7 días desde `saintAddedAt`). Se prueba con el reloj fijo —
 * `isNewFromSaint` usa `new Date()` por default, y un test que dependiera del
 * reloj real sería frágil (CLAUDE.md, "nunca un test que dependa del reloj
 * real").
 */
describe("ProductoFila — badge Nuevo desde Saint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("se muestra cuando el producto llegó de Saint hace 1 día", () => {
    render(<ProductoFila product={product({ saintAddedAt: "2026-09-24T12:00:00Z" })} bcvRate={40} />);
    expect(screen.getByText("Nuevo desde Saint")).toBeInTheDocument();
  });

  it("no se muestra sin fecha de ingreso a Saint", () => {
    render(<ProductoFila product={product({ saintAddedAt: null })} bcvRate={40} />);
    expect(screen.queryByText("Nuevo desde Saint")).not.toBeInTheDocument();
  });

  it("no se muestra pasados los 7 días", () => {
    render(<ProductoFila product={product({ saintAddedAt: "2026-09-17T12:00:00Z" })} bcvRate={40} />);
    expect(screen.queryByText("Nuevo desde Saint")).not.toBeInTheDocument();
  });
});
