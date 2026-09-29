/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationCartBlock } from "@/components/context-panel/conversation-cart-block";
import type { CartActions } from "@/components/context-panel/use-cart-actions";
import type { ConversationCartItem, Product } from "@/lib/types";

// ---------------------------------------------------------------------------
// T8, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026): el bloque «Lo que lleva el cliente» del panel
// derecho. Es presentacional: pinta el carrito con precios VIGENTES y delega
// cada acción en `CartActions` (probadas aparte en `use-cart-actions.test.tsx`).
// Jsdom no calcula layout: este archivo prueba contenido y comportamiento, no
// que la columna de 300 px se vea bien.
// ---------------------------------------------------------------------------

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "Carburador PZ27",
    brand: null,
    price: 20,
    currency: "USD",
    stockQuantity: 5,
    description: null,
    isActive: true,
    updatedAt: "2026-09-29T10:00:00.000Z",
    compatibility: [],
    weightKg: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    ...over,
  };
}

function item(over: Partial<ConversationCartItem> = {}): ConversationCartItem {
  const p = over.product ?? product();
  return {
    id: "cart-1",
    conversationId: "conv-1",
    productId: p.id,
    quantity: 2,
    origin: "inventory",
    quoteId: null,
    quotedPriceUsd: null,
    addedBy: "agent-1",
    createdAt: "2026-09-29T10:00:00.000Z",
    updatedAt: "2026-09-29T10:00:00.000Z",
    product: p,
    ...over,
  };
}

function makeActions(over: Partial<CartActions> = {}): CartActions {
  return {
    busy: false,
    addProduct: vi.fn().mockResolvedValue(undefined),
    addQuote: vi.fn().mockResolvedValue(undefined),
    addAllQuotes: vi.fn().mockResolvedValue(undefined),
    setQuantity: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function setup(cart: ConversationCartItem[], actions = makeActions(), bcvRate = 40) {
  const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
  render(<ConversationCartBlock cart={cart} bcvRate={bcvRate} actions={actions} />);
  return { user, actions };
}

describe("ConversationCartBlock — carrito vacío", () => {
  it("dice qué es y cómo llenarlo, y ofrece traer lo que cotizó Seba", () => {
    setup([]);

    expect(screen.getByText("Lo que lleva el cliente")).toBeInTheDocument();
    expect(screen.getByText(/todavía no hay nada/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /agregar cotizaciones de seba/i })).toBeInTheDocument();
  });

  it("«Agregar cotizaciones de Seba» dispara la acción", async () => {
    const { user, actions } = setup([]);

    await user.click(screen.getByRole("button", { name: /agregar cotizaciones de seba/i }));

    expect(actions.addAllQuotes).toHaveBeenCalledTimes(1);
  });
});

describe("ConversationCartBlock — con renglones", () => {
  it("muestra nombre, precio vigente por unidad, subtotal y el total en dólares y bolívares", () => {
    setup([
      item({ quantity: 2 }),
      item({ id: "cart-2", productId: "prod-2", product: product({ id: "prod-2", name: "Kit de arrastre", price: 5 }), quantity: 1 }),
    ]);

    expect(screen.getByText("Carburador PZ27")).toBeInTheDocument();
    expect(screen.getByText("Kit de arrastre")).toBeInTheDocument();
    // Carburador: 2 x $20 = $40 (Bs. 1600.00); Kit: 1 x $5 = $5.
    expect(screen.getByText("$40.00")).toBeInTheDocument();
    // Total = $45 y Bs. 1800.00 (2 x 800 + 1 x 200).
    expect(screen.getByTestId("cart-total")).toHaveTextContent("$45.00");
    expect(screen.getByTestId("cart-total")).toHaveTextContent("Bs. 1800.00");
  });

  it("un renglón que vino de una cotización con otro precio muestra «cotizado $X · hoy $Y» y cobra el de hoy", () => {
    setup([item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 18, quantity: 1 })]);

    expect(screen.getByText("cotizado $18.00 · hoy $20.00")).toBeInTheDocument();
    expect(screen.getByTestId("cart-total")).toHaveTextContent("$20.00");
  });

  it("si el precio cotizado coincide con el de hoy no muestra la comparación", () => {
    setup([item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 20 })]);

    expect(screen.queryByText(/cotizado \$/i)).not.toBeInTheDocument();
  });

  it("un repuesto en bolívares sin tasa queda marcado «Sin tasa» y avisa que no entra al total", () => {
    setup([item({ product: product({ currency: "VES", price: 101 }) })], makeActions(), 0);

    expect(screen.getAllByText(/sin tasa/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/sin precio/i)).toBeInTheDocument();
  });

  it("«+» sube una unidad, escribiendo la cantidad nueva", async () => {
    const { user, actions } = setup([item({ quantity: 2 })]);

    await user.click(screen.getByRole("button", { name: "Agregar una unidad de Carburador PZ27" }));

    expect(actions.setQuantity).toHaveBeenCalledWith("cart-1", 3);
  });

  it("«−» baja una unidad, pero con una sola no baja de ahí", async () => {
    const { user, actions } = setup([item({ quantity: 3 })]);
    await user.click(screen.getByRole("button", { name: "Restar una unidad de Carburador PZ27" }));
    expect(actions.setQuantity).toHaveBeenCalledWith("cart-1", 2);
  });

  it("con una sola unidad el «−» está deshabilitado (quitar es otro botón)", () => {
    setup([item({ quantity: 1 })]);

    expect(screen.getByRole("button", { name: "Restar una unidad de Carburador PZ27" })).toBeDisabled();
  });

  it("escribir una cantidad se guarda al salir del campo, no en cada tecla", () => {
    const { actions } = setup([item({ quantity: 2 })]);
    const input = screen.getByLabelText("Cantidad de Carburador PZ27");

    fireEvent.change(input, { target: { value: "7" } });
    expect(actions.setQuantity).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(actions.setQuantity).toHaveBeenCalledWith("cart-1", 7);
  });

  it("una cantidad inválida (vacía o cero) vuelve a la que había y no escribe nada", () => {
    const { actions } = setup([item({ quantity: 2 })]);
    const input = screen.getByLabelText("Cantidad de Carburador PZ27");

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);

    expect(actions.setQuantity).not.toHaveBeenCalled();
    expect(input).toHaveValue("2");
  });

  it("la misma cantidad no vuelve a escribirse", () => {
    const { actions } = setup([item({ quantity: 2 })]);
    const input = screen.getByLabelText("Cantidad de Carburador PZ27");

    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.blur(input);

    expect(actions.setQuantity).not.toHaveBeenCalled();
  });

  it("quitar pide borrar SOLO ese renglón", async () => {
    const { user, actions } = setup([
      item({ quantity: 1 }),
      item({ id: "cart-2", productId: "prod-2", product: product({ id: "prod-2", name: "Kit de arrastre" }) }),
    ]);

    await user.click(screen.getByRole("button", { name: "Quitar Kit de arrastre del carrito" }));

    expect(actions.remove).toHaveBeenCalledWith("cart-2");
    expect(actions.remove).toHaveBeenCalledTimes(1);
  });

  // T9 (29/9/2026, 3.5): la existencia también se ve en el carrito, y un
  // renglón cuyo producto quedó en 0 se marca — se puede vender igual (puede
  // haber existencia física sin cargar), pero el asesor tiene que enterarse.
  it("cada renglón lleva la pastilla de existencia de su producto", () => {
    setup([item({ product: product({ stockQuantity: 5 }) })]);

    expect(screen.getByText("5 en stock")).toHaveAttribute("data-stock", "in");
  });

  it("un renglón cuyo producto quedó en 0 se marca «Agotado» y el renglón queda señalado", () => {
    setup([
      item({ product: product({ stockQuantity: 5 }) }),
      item({
        id: "cart-2",
        productId: "prod-2",
        product: product({ id: "prod-2", name: "Kit de arrastre", stockQuantity: 0 }),
      }),
    ]);

    expect(screen.getByText("Agotado")).toHaveAttribute("data-stock", "out");
    const renglonAgotado = screen.getByText("Kit de arrastre").closest("li");
    expect(renglonAgotado).toHaveAttribute("data-agotado", "true");
    const renglonConStock = screen.getByText("Carburador PZ27").closest("li");
    expect(renglonConStock).not.toHaveAttribute("data-agotado");
  });

  it("mientras hay una escritura en curso los controles se deshabilitan", () => {
    setup([item({ quantity: 2 })], makeActions({ busy: true }));

    expect(screen.getByRole("button", { name: "Agregar una unidad de Carburador PZ27" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quitar Carburador PZ27 del carrito" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /agregar cotizaciones de seba/i })).toBeDisabled();
  });
});
