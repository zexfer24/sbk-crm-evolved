/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { toast } from "@heroui/react";
import { useCartActions } from "@/components/context-panel/use-cart-actions";
import type { ConversationQuote, Product } from "@/lib/types";

// ---------------------------------------------------------------------------
// T8, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
// esperando" (28/9/2026). `useCartActions` es lo que comparten el panel
// derecho y el modal de cierre para escribir en el carrito persistente: el
// mismo chequeo de precio, el mismo aviso de error y el mismo refresco. Un
// guardado que falla NO se traga: avisa, y refresca igual para que la
// pantalla muestre lo que de verdad quedó en la base.
// ---------------------------------------------------------------------------

const addToCart = vi.fn();
const addQuotesToCart = vi.fn();
const setCartQuantity = vi.fn();
const removeFromCart = vi.fn();
vi.mock("@/lib/mutations", () => ({
  addToCart: (...args: unknown[]) => addToCart(...args),
  addQuotesToCart: (...args: unknown[]) => addQuotesToCart(...args),
  setCartQuantity: (...args: unknown[]) => setCartQuantity(...args),
  removeFromCart: (...args: unknown[]) => removeFromCart(...args),
}));

const fetchConversationQuotes = vi.fn();
vi.mock("@/lib/data", () => ({
  fetchConversationQuotes: (...args: unknown[]) => fetchConversationQuotes(...args),
}));

const CLIENT = { marca: "cliente-de-prueba" };
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => CLIENT) }));

vi.mock("@heroui/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@heroui/react")>();
  return {
    ...real,
    toast: { ...real.toast, danger: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  };
});

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod-1",
    name: "Bujía CR7HSA",
    brand: "NGK",
    price: 3.25,
    currency: "USD",
    stockQuantity: 10,
    description: null,
    isActive: true,
    updatedAt: "2026-09-29T00:00:00.000Z",
    compatibility: [],
    weightKg: null,
    saintCode: null,
    saintAddedAt: null,
    saintRemovedAt: null,
    ...over,
  };
}

function quote(over: Partial<ConversationQuote> = {}): ConversationQuote {
  return {
    id: "q-1",
    productId: "prod-1",
    productName: "Bujía CR7HSA",
    priceUsd: 3.25,
    priceBs: 130,
    bcvRate: 40,
    quotedAt: "2026-09-29T10:00:00.000Z",
    ...over,
  };
}

const onCartChanged = vi.fn();

function setup(bcvRate = 40) {
  return renderHook(() => useCartActions({ conversationId: "conv-1", bcvRate, onCartChanged }));
}

beforeEach(() => {
  for (const fn of [addToCart, addQuotesToCart, setCartQuantity, removeFromCart, fetchConversationQuotes, onCartChanged]) {
    fn.mockReset();
    fn.mockResolvedValue(undefined);
  }
  addQuotesToCart.mockResolvedValue(0);
  fetchConversationQuotes.mockResolvedValue([]);
  vi.mocked(toast.danger).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.info).mockClear();
});

describe("useCartActions — agregar un producto del inventario", () => {
  it("escribe en el carrito de la conversación, con origen «inventory», y refresca", async () => {
    const { result } = setup();

    await act(() => result.current.addProduct(product()));

    expect(addToCart).toHaveBeenCalledWith(CLIENT, {
      conversationId: "conv-1",
      productId: "prod-1",
      quantity: 1,
      origin: "inventory",
    });
    expect(onCartChanged).toHaveBeenCalledTimes(1);
  });

  it("un producto en bolívares sin tasa del BCV no entra: avisa y no escribe nada", async () => {
    const { result } = setup(0);

    await act(() => result.current.addProduct(product({ currency: "VES", price: 100 })));

    expect(addToCart).not.toHaveBeenCalled();
    expect(toast.danger).toHaveBeenCalledWith(expect.stringMatching(/tasa/i));
  });

  it("si la escritura falla avisa con el mensaje del error y refresca igual", async () => {
    addToCart.mockRejectedValueOnce(new Error("otro asesor lo estaba cambiando"));
    const { result } = setup();

    await act(() => result.current.addProduct(product()));

    expect(toast.danger).toHaveBeenCalledWith("otro asesor lo estaba cambiando");
    expect(onCartChanged).toHaveBeenCalledTimes(1);
  });

  it("un error sin mensaje legible cae al texto genérico", async () => {
    addToCart.mockRejectedValueOnce({ code: "42501" });
    const { result } = setup();

    await act(() => result.current.addProduct(product()));

    expect(toast.danger).toHaveBeenCalledWith("No se pudo agregar al carrito.");
  });
});

describe("useCartActions — agregar una cotización puntual de Seba", () => {
  it("guarda el renglón con origen «quote» y el vínculo a la cotización", async () => {
    const { result } = setup();

    await act(() => result.current.addQuote(quote({ id: "q-9", productId: "prod-3" })));

    expect(addToCart).toHaveBeenCalledWith(CLIENT, {
      conversationId: "conv-1",
      productId: "prod-3",
      quantity: 1,
      origin: "quote",
      quoteId: "q-9",
    });
  });

  it("una cotización de un producto que ya no existe avisa y no escribe", async () => {
    const { result } = setup();

    await act(() => result.current.addQuote(quote({ productId: null })));

    expect(addToCart).not.toHaveBeenCalled();
    expect(toast.danger).toHaveBeenCalled();
  });
});

describe("useCartActions — «Agregar cotizaciones de Seba»", () => {
  it("lee las cotizaciones de ESTA conversación y las agrega todas de una vez", async () => {
    const cotizaciones = [quote({ id: "q-1", productId: "prod-1" }), quote({ id: "q-2", productId: "prod-2" })];
    fetchConversationQuotes.mockResolvedValue(cotizaciones);
    addQuotesToCart.mockResolvedValue(2);
    const { result } = setup();

    await act(() => result.current.addAllQuotes());

    expect(fetchConversationQuotes).toHaveBeenCalledWith(CLIENT, "conv-1");
    expect(addQuotesToCart).toHaveBeenCalledWith(CLIENT, "conv-1", cotizaciones);
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("2"));
    expect(onCartChanged).toHaveBeenCalledTimes(1);
  });

  it("si no había nada nuevo que agregar lo dice, sin fingir un éxito", async () => {
    fetchConversationQuotes.mockResolvedValue([quote()]);
    addQuotesToCart.mockResolvedValue(0);
    const { result } = setup();

    await act(() => result.current.addAllQuotes());

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/nada nuevo|no hay/i));
  });
});

describe("useCartActions — cambiar la cantidad y quitar", () => {
  it("fija la cantidad del renglón y refresca", async () => {
    const { result } = setup();

    await act(() => result.current.setQuantity("cart-1", 4));

    expect(setCartQuantity).toHaveBeenCalledWith(CLIENT, "cart-1", 4);
    expect(onCartChanged).toHaveBeenCalledTimes(1);
  });

  it("quita el renglón y refresca", async () => {
    const { result } = setup();

    await act(() => result.current.remove("cart-1"));

    expect(removeFromCart).toHaveBeenCalledWith(CLIENT, "cart-1");
    expect(onCartChanged).toHaveBeenCalledTimes(1);
  });

  it("si quitar falla avisa y refresca igual", async () => {
    removeFromCart.mockRejectedValueOnce(new Error("Ese renglón ya no está en el carrito"));
    const { result } = setup();

    await act(() => result.current.remove("cart-1"));

    expect(toast.danger).toHaveBeenCalledWith("Ese renglón ya no está en el carrito");
    expect(onCartChanged).toHaveBeenCalledTimes(1);
  });
});
