/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CartLines } from "@/components/context-panel/cart-lines";
import type { CartActions } from "@/components/context-panel/use-cart-actions";
import type { ConversationCartItem, Product } from "@/lib/types";

// 28/10/2026 (plan "Facturar en SAINT sale del fondo del panel", T2): la tarjeta
// del artículo separa lo que se EDITA (promoción/estándar y cantidad, a la
// izquierda) de lo que se COBRA (subtotal y bolívares, a la derecha). Jsdom no
// calcula layout: acá se fija el orden y la pertenencia en el DOM; que el
// toggle ocupe todo el ancho lo fija el test de la hoja
// (`cart-lines-css.test.ts`).

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
    shippingFeeUsd: null,
    precioDivisaUsd: null,
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
    priceKind: "estandar",
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
    setPriceKind: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

// Estándar con tarifa MRW para que el renglón tenga precio y el toggle esté vivo.
const conTarifa = () => item({ product: product({ shippingFeeUsd: 5 }) });

describe("CartLines — la tarjeta del artículo", () => {
  it("el selector Promoción/Estándar va ANTES de la cantidad en el DOM", () => {
    render(<CartLines cart={[conTarifa()]} bcvRate={40} actions={makeActions()} />);
    const toggle = screen.getByRole("radiogroup", { name: "Precio de Carburador PZ27" });
    const cantidad = screen.getByLabelText("Cantidad de Carburador PZ27");
    expect(toggle.compareDocumentPosition(cantidad) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("el origen y la existencia van antes del selector", () => {
    render(<CartLines cart={[conTarifa()]} bcvRate={40} actions={makeActions()} />);
    const toggle = screen.getByRole("radiogroup", { name: "Precio de Carburador PZ27" });
    const origen = screen.getByText("Agregado por un asesor");
    expect(origen.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("el precio c/u queda dentro de la columna de la cantidad, no de la del subtotal", () => {
    const { container } = render(<CartLines cart={[conTarifa()]} bcvRate={40} actions={makeActions()} />);
    const colCantidad = container.querySelector<HTMLElement>(".crm-pcart-col-qty");
    const colTotal = container.querySelector<HTMLElement>(".crm-pcart-col-total");
    expect(colCantidad).not.toBeNull();
    expect(colTotal).not.toBeNull();
    expect(within(colCantidad!).getByLabelText("Cantidad de Carburador PZ27")).toBeTruthy();
    expect(within(colCantidad!).getByText(/c\/u/)).toBeTruthy();
    expect(within(colTotal!).queryByText(/c\/u/)).toBeNull();
  });

  it("el subtotal y los bolívares quedan juntos en la columna de la derecha", () => {
    const { container } = render(<CartLines cart={[conTarifa()]} bcvRate={40} actions={makeActions()} />);
    const colTotal = container.querySelector<HTMLElement>(".crm-pcart-col-total")!;
    expect(within(colTotal).getByText(/^\$\d+\.\d{2}$/)).toBeTruthy();
    expect(within(colTotal).getByText(/^Bs\. /)).toBeTruthy();
    const colCantidad = container.querySelector<HTMLElement>(".crm-pcart-col-qty")!;
    expect(within(colCantidad).queryByText(/^Bs\. /)).toBeNull();
  });

  it("sin tasa un producto en USD no tiene bolívares y el subtotal avisa en su columna", () => {
    const usd = item({ priceKind: "promocion" });
    const { container } = render(<CartLines cart={[usd]} bcvRate={0} actions={makeActions()} />);
    const colTotal = container.querySelector<HTMLElement>(".crm-pcart-col-total")!;
    expect(within(colTotal).queryByText(/^Bs\. /)).toBeNull();
  });

  it("sin tasa un producto en bolívares avisa «Sin tasa» pero conserva sus Bs. en la columna del total", () => {
    const bs = item({ priceKind: "promocion", product: product({ currency: "VES", price: 800 }) });
    const { container } = render(<CartLines cart={[bs]} bcvRate={0} actions={makeActions()} />);
    const colTotal = container.querySelector<HTMLElement>(".crm-pcart-col-total")!;
    expect(within(colTotal).getByText("Sin tasa")).toBeTruthy();
    expect(within(colTotal).getByText(/^Bs\. /)).toBeTruthy();
  });

  it("conserva el aviso de «Sin tarifa MRW» y el data-agotado", () => {
    const sinTarifa = item({ product: product({ shippingFeeUsd: null, stockQuantity: 0 }) });
    const { container } = render(<CartLines cart={[sinTarifa]} bcvRate={40} actions={makeActions()} />);
    expect(screen.getByText(/Sin tarifa MRW/)).toBeTruthy();
    expect(container.querySelector('li[data-agotado="true"]')).not.toBeNull();
  });

  it("los botones siguen llamando a las acciones", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const actions = makeActions();
    render(<CartLines cart={[conTarifa()]} bcvRate={40} actions={actions} />);
    await user.click(screen.getByRole("radio", { name: "Promoción" }));
    expect(actions.setPriceKind).toHaveBeenCalledWith("cart-1", "promocion");
    await user.click(screen.getByRole("button", { name: "Agregar una unidad de Carburador PZ27" }));
    expect(actions.setQuantity).toHaveBeenCalledWith("cart-1", 3);
    await user.click(screen.getByRole("button", { name: "Restar una unidad de Carburador PZ27" }));
    expect(actions.setQuantity).toHaveBeenCalledWith("cart-1", 1);
    await user.click(screen.getByRole("button", { name: "Quitar Carburador PZ27 del carrito" }));
    expect(actions.remove).toHaveBeenCalledWith("cart-1");
  });
});

describe("CartLines — mostrarTotal", () => {
  it("por defecto pinta el total", () => {
    render(<CartLines cart={[conTarifa()]} bcvRate={40} actions={makeActions()} />);
    expect(screen.getByTestId("cart-total")).toBeTruthy();
  });

  it("con mostrarTotal={false} no pinta el total", () => {
    render(<CartLines cart={[conTarifa()]} bcvRate={40} actions={makeActions()} mostrarTotal={false} />);
    expect(screen.queryByTestId("cart-total")).toBeNull();
  });

  it("con mostrarTotal={false} el aviso de renglones sin precio se pinta igual", () => {
    const bs = item({ priceKind: "promocion", product: product({ currency: "VES", price: 800 }) });
    render(<CartLines cart={[bs]} bcvRate={0} actions={makeActions()} mostrarTotal={false} />);
    expect(screen.getByText(/1 renglón sin precio/)).toBeTruthy();
    expect(screen.queryByTestId("cart-total")).toBeNull();
  });
});
