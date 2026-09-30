/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationCartBlock } from "@/components/context-panel/conversation-cart-block";
import type { CartActions } from "@/components/context-panel/use-cart-actions";
import type { ConversationCartItem, Product } from "@/lib/types";

// El toast real de HeroUI no aporta nada acá: se espía `success`/`danger` de
// «Copiar» (T4, "Ronda del cliente", 30/9/2026) y el resto del módulo queda
// intacto.
vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return { ...real, toast: { success: vi.fn(), danger: vi.fn(), warning: vi.fn() } };
});

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
  const onSendToComposer = vi.fn();
  render(
    <ConversationCartBlock cart={cart} bcvRate={bcvRate} actions={actions} onSendToComposer={onSendToComposer} />
  );
  return { user, actions, onSendToComposer };
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

// T4 del plan "Ronda del cliente" (30/9/2026): «Copiar» y «Enviar al chat» bajo
// el total. El texto exacto lo cubre `cartSummaryText` en su propio test; acá
// se prueba que los botones lo usan tal cual y cuándo existen.
describe("ConversationCartBlock — copiar y enviar al chat", () => {
  const TEXTO = ["Carburador PZ27", "SKU: A-100", "Precio: $20.00", "", "Total: $20.00"].join("\n");
  const renglon = () => item({ quantity: 1, product: product({ saintCode: "A-100" }) });

  it("con el carrito vacío no existen ni «Copiar» ni «Enviar al chat»", () => {
    setup([]);

    expect(screen.queryByRole("button", { name: /^copiar$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enviar al chat/i })).not.toBeInTheDocument();
  });

  it("«Copiar» pone el resumen exacto en el portapapeles y avisa con un toast", async () => {
    const { user } = setup([renglon()]);
    // `userEvent.setup()` instala su propio stub de `navigator.clipboard`: se
    // espía DESPUÉS del setup (mismo criterio que catalog-links-panel.test.tsx).
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const { toast } = await import("@heroui/react");

    await user.click(screen.getByRole("button", { name: /^copiar$/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TEXTO));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Carrito copiado"));
  });

  it("si el portapapeles falla, avisa «No se pudo copiar»", async () => {
    const { user } = setup([renglon()]);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denegado"));
    const { toast } = await import("@heroui/react");

    await user.click(screen.getByRole("button", { name: /^copiar$/i }));

    await waitFor(() => expect(toast.danger).toHaveBeenCalledWith("No se pudo copiar"));
  });

  it("«Enviar al chat» entrega el mismo texto a onSendToComposer, sin copiar nada", async () => {
    const { user, onSendToComposer } = setup([renglon()]);
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    await user.click(screen.getByRole("button", { name: /enviar al chat/i }));

    expect(onSendToComposer).toHaveBeenCalledTimes(1);
    expect(onSendToComposer).toHaveBeenCalledWith(TEXTO);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("con un renglón sin precio (falta la tasa BCV) los dos botones quedan deshabilitados y dicen por qué", async () => {
    const { user, onSendToComposer } = setup([item({ product: product({ currency: "VES", price: 101 }) })], makeActions(), 0);
    const copiar = screen.getByRole("button", { name: /^copiar$/i });
    const enviar = screen.getByRole("button", { name: /enviar al chat/i });

    expect(copiar).toBeDisabled();
    expect(enviar).toBeDisabled();
    // El `title` vive en el envoltorio del botón (el Button de HeroUI no lo pasa al DOM).
    expect(copiar.closest("[title]")).toHaveAttribute("title", "Hay productos sin precio (falta la tasa BCV)");
    expect(enviar.closest("[title]")).toHaveAttribute("title", "Hay productos sin precio (falta la tasa BCV)");

    await user.click(enviar);
    expect(onSendToComposer).not.toHaveBeenCalled();
  });
});
