import { describe, expect, it } from "vitest";
import type { ConversationQuote, Product, SaleCartItem } from "@/lib/types";
import {
  addProductToCart,
  addQuoteToCart,
  cartToLineItems,
  cartTotalUsd,
  productPriceUsd,
  removeFromCart,
  setCartQuantity,
} from "@/lib/sale-cart";

function quote(over: Partial<ConversationQuote> = {}): ConversationQuote {
  return {
    id: "q-1",
    productId: "prod-1",
    productName: "Carburador PZ27",
    priceUsd: 18,
    priceBs: 720,
    bcvRate: 40,
    quotedAt: "2026-08-22T12:00:00.000Z",
    ...over,
  };
}

function product(over: Partial<Product> = {}): Product {
  return {
    id: "prod-9",
    name: "Filtro de aceite",
    brand: "Genérico",
    price: 4.5,
    currency: "USD",
    stockQuantity: 20,
    description: null,
    isActive: true,
    updatedAt: "2026-08-22T10:00:00.000Z",
    compatibility: [],
    ...over,
  };
}

function item(over: Partial<SaleCartItem> = {}): SaleCartItem {
  return {
    id: "q-1",
    origin: "quote",
    productId: "prod-1",
    description: "Carburador PZ27",
    unitPriceUsd: 18,
    quantity: 1,
    ...over,
  };
}

describe("addQuoteToCart", () => {
  it("agrega la cotización como un renglón nuevo", () => {
    const cart = addQuoteToCart([], quote());
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({
      id: "q-1",
      origin: "quote",
      productId: "prod-1",
      description: "Carburador PZ27",
      unitPriceUsd: 18,
      quantity: 1,
    });
  });

  // Que el cliente lleve dos no es un renglón repetido: es cantidad 2.
  it("si la cotización ya está, suma una unidad en vez de duplicar el renglón", () => {
    const cart = addQuoteToCart(addQuoteToCart([], quote()), quote());
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(2);
  });

  // La IA cotiza el mismo repuesto cada vez que el cliente pregunta, así que
  // conversation_quotes trae varias filas del mismo producto con ids distintos.
  it("dos cotizaciones distintas del mismo producto son un solo renglón", () => {
    const cart = addQuoteToCart(addQuoteToCart([], quote({ id: "q-1" })), quote({ id: "q-2" }));
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(2);
  });

  it("dos cotizaciones sin producto asociado no se confunden entre sí", () => {
    const cart = addQuoteToCart(
      addQuoteToCart([], quote({ id: "q-1", productId: null, productName: "Repuesto viejo" })),
      quote({ id: "q-2", productId: null, productName: "Otro repuesto" })
    );
    expect(cart).toHaveLength(2);
  });
});

describe("addProductToCart", () => {
  it("agrega un repuesto del inventario que la IA nunca cotizó", () => {
    const cart = addProductToCart([], product(), 40);
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({
      origin: "inventory",
      productId: "prod-9",
      description: "Filtro de aceite",
      unitPriceUsd: 4.5,
      quantity: 1,
    });
  });

  // Si el asesor agrega algo que la IA ya había cotizado, no debe quedar
  // dos veces en la venta: es el mismo producto.
  it("no duplica un producto que ya entró como cotización", () => {
    const cart = addProductToCart(addQuoteToCart([], quote()), product({ id: "prod-1" }), 40);
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(2);
    // El renglón conserva el precio que se le cotizó al cliente.
    expect(cart[0].unitPriceUsd).toBe(18);
  });

  it("convierte a dólares el repuesto que tiene el precio en bolívares", () => {
    const cart = addProductToCart([], product({ price: 800, currency: "VES" }), 40);
    expect(cart[0].unitPriceUsd).toBe(20);
  });
});

describe("productPriceUsd", () => {
  it("deja el precio en dólares tal cual", () => {
    expect(productPriceUsd(product({ price: 4.5, currency: "USD" }), 40)).toBe(4.5);
  });

  it("convierte desde bolívares con la tasa", () => {
    expect(productPriceUsd(product({ price: 800, currency: "VES" }), 40)).toBe(20);
  });

  // Sin tasa no se puede convertir, y meter un cero en la venta sería peor
  // que no dejar agregarlo.
  it("devuelve null si hay que convertir y no hay tasa", () => {
    expect(productPriceUsd(product({ price: 800, currency: "VES" }), 0)).toBeNull();
  });
});

describe("setCartQuantity", () => {
  it("cambia la cantidad del renglón", () => {
    const cart = setCartQuantity([item()], "q-1", 5);
    expect(cart[0].quantity).toBe(5);
  });

  it("nunca baja de una unidad", () => {
    expect(setCartQuantity([item()], "q-1", 0)[0].quantity).toBe(1);
    expect(setCartQuantity([item()], "q-1", -4)[0].quantity).toBe(1);
  });

  it("redondea una cantidad con decimales", () => {
    expect(setCartQuantity([item()], "q-1", 2.7)[0].quantity).toBe(3);
  });

  it("ignora un renglón que no está en el carrito", () => {
    const cart = [item()];
    expect(setCartQuantity(cart, "no-existe", 9)).toEqual(cart);
  });
});

describe("removeFromCart", () => {
  it("saca el renglón indicado y deja los demás", () => {
    const cart = removeFromCart([item({ id: "a" }), item({ id: "b" })], "a");
    expect(cart).toHaveLength(1);
    expect(cart[0].id).toBe("b");
  });
});

describe("cartTotalUsd", () => {
  it("suma precio por cantidad de cada renglón", () => {
    const total = cartTotalUsd([
      item({ id: "a", unitPriceUsd: 18, quantity: 1 }),
      item({ id: "b", unitPriceUsd: 32.5, quantity: 2 }),
    ]);
    expect(total).toBe(83);
  });

  it("no arrastra errores de coma flotante", () => {
    expect(cartTotalUsd([item({ unitPriceUsd: 0.1, quantity: 3 })])).toBe(0.3);
  });

  it("un carrito vacío suma cero", () => {
    expect(cartTotalUsd([])).toBe(0);
  });
});

describe("cartToLineItems", () => {
  it("traduce el carrito a los renglones que guarda la venta", () => {
    const items = cartToLineItems([
      item({ id: "q-1", origin: "quote", productId: "prod-1", description: "Carburador", unitPriceUsd: 18, quantity: 2 }),
    ]);

    expect(items).toEqual([
      {
        id: "q-1",
        origin: "quote",
        productId: "prod-1",
        description: "Carburador",
        unitPrice: 18,
        quantity: 2,
      },
    ]);
  });
});
