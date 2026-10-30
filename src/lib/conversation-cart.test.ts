import { describe, expect, it } from "vitest";
import type { ConversationCartItem, Product } from "@/lib/types";
import { OPCIONES_COPIA_INICIALES, type OpcionesCopia } from "@/lib/copia-carrito";
import {
  cartSummaryText,
  cartToSaleLines,
  cartTotals,
  priceCartLines,
  quoteComparisonLabel,
} from "@/lib/conversation-cart";

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
    quantity: 1,
    origin: "inventory",
    quoteId: null,
    quotedPriceUsd: null,
    priceKind: "promocion",
    addedBy: "agent-1",
    createdAt: "2026-09-29T10:00:00.000Z",
    updatedAt: "2026-09-29T10:00:00.000Z",
    product: p,
    ...over,
  };
}

describe("priceCartLines — el precio es el VIGENTE (D6), nunca el cotizado", () => {
  it("un producto en dólares se cobra a su precio de hoy y da su equivalente en bolívares", () => {
    const [line] = priceCartLines([item({ quantity: 2 })], 40);
    expect(line.unitPriceUsd).toBe(20);
    expect(line.unitPriceBs).toBe(800);
    expect(line.subtotalUsd).toBe(40);
    expect(line.subtotalBs).toBe(1600);
  });

  it("aunque el renglón venga de una cotización, se factura el precio de hoy y no el cotizado", () => {
    // Seba cotizó $18; el producto hoy vale $20. Lo que se cobra es $20.
    const [line] = priceCartLines(
      [item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 18, quantity: 3 })],
      40
    );
    expect(line.unitPriceUsd).toBe(20);
    expect(line.subtotalUsd).toBe(60);
  });

  it("un producto en bolívares pasa por usdFromBs: redondeo hacia arriba al décimo, a favor del negocio", () => {
    // 101 Bs / 40 = 2,525 -> $2,60 (no $2,53 ni $2,50).
    const [line] = priceCartLines([item({ product: product({ currency: "VES", price: 101 }) })], 40);
    expect(line.unitPriceUsd).toBe(2.6);
    expect(line.unitPriceBs).toBe(101);
  });

  it("sin tasa, un producto en bolívares queda sin precio en dólares (no se inventa uno)", () => {
    const [line] = priceCartLines([item({ product: product({ currency: "VES", price: 101 }) })], 0);
    expect(line.unitPriceUsd).toBeNull();
    expect(line.subtotalUsd).toBeNull();
    expect(line.unitPriceBs).toBe(101);
  });

  it("sin tasa, un producto en dólares sí tiene precio pero no equivalente en bolívares", () => {
    const [line] = priceCartLines([item()], 0);
    expect(line.unitPriceUsd).toBe(20);
    expect(line.unitPriceBs).toBeNull();
    expect(line.subtotalBs).toBeNull();
  });
});

// 14/10/2026: cada renglón se cobra a precio de promoción o estándar
// (promoción + envío MRW), a elección del asesor. El estándar se calcula igual
// que el precio vigente (D6): nada se guarda, todo sale del producto y la tasa.
describe("priceCartLines — precio estándar (promoción + envío MRW)", () => {
  const conTarifa = product({ price: 25, currency: "USD", weightKg: 2, shippingFeeUsd: 2.5 });

  it("un renglón estándar se cobra a promoción + tarifa, en dólares y en bolívares", () => {
    const [line] = priceCartLines([item({ product: conTarifa, priceKind: "estandar", quantity: 2 })], 40);
    expect(line.unitPriceUsd).toBe(27.5);
    expect(line.unitPriceBs).toBe(1100);
    expect(line.subtotalUsd).toBe(55);
    expect(line.subtotalBs).toBe(2200);
  });

  it("el mismo producto en promoción sigue cobrando solo su precio", () => {
    const [line] = priceCartLines([item({ product: conTarifa, priceKind: "promocion" })], 40);
    expect(line.unitPriceUsd).toBe(25);
  });

  it("estándar sin tarifa MRW queda SIN precio (no se inventa un número) y cuenta como renglón sin precio", () => {
    const lines = priceCartLines([item({ priceKind: "estandar" })], 40);
    expect(lines[0].unitPriceUsd).toBeNull();
    expect(lines[0].unitPriceBs).toBeNull();
    expect(lines[0].subtotalUsd).toBeNull();
    expect(cartTotals(lines).unpricedCount).toBe(1);
  });

  it("estándar de un producto en bolívares usa usdFromBs + tarifa", () => {
    const [line] = priceCartLines(
      [item({ priceKind: "estandar", product: product({ price: 87, currency: "VES", shippingFeeUsd: 1.4 }) })],
      40
    );
    expect(line.unitPriceUsd).toBe(3.6);
    expect(line.unitPriceBs).toBe(143);
  });

  it("estándar de un producto en bolívares sin tasa queda sin precio en dólares", () => {
    const [line] = priceCartLines(
      [item({ priceKind: "estandar", product: product({ price: 87, currency: "VES", shippingFeeUsd: 1.4 }) })],
      0
    );
    expect(line.unitPriceUsd).toBeNull();
  });

  it("el aviso «cotizado vs hoy» solo aplica a promoción: Seba cotiza promoción", () => {
    const base = { origin: "quote" as const, quoteId: "q-1", quotedPriceUsd: 18, product: conTarifa };
    const [promo] = priceCartLines([item({ ...base, priceKind: "promocion" })], 40);
    expect(promo.priceChange).toEqual({ quotedUsd: 18, todayUsd: 25 });
    const [estandar] = priceCartLines([item({ ...base, priceKind: "estandar" })], 40);
    expect(estandar.priceChange).toBeNull();
    expect(quoteComparisonLabel(estandar)).toBeNull();
  });

  it("un renglón sin priceKind (carrito de Inventario) se cobra a promoción", () => {
    const [line] = priceCartLines([{ product: conTarifa, quantity: 1, quotedPriceUsd: null }], 40);
    expect(line.unitPriceUsd).toBe(25);
  });

  it("el total suma cada renglón a su precio elegido", () => {
    const lines = priceCartLines(
      [
        item({ id: "a", product: conTarifa, priceKind: "estandar" }),
        item({ id: "b", productId: "p2", product: product({ id: "p2", price: 5 }), priceKind: "promocion", quantity: 2 }),
      ],
      40
    );
    expect(cartTotals(lines).usd).toBe(37.5);
  });
});

describe("quoteComparisonLabel — «cotizado $X · hoy $Y» solo cuando difieren", () => {
  it("muestra las dos cifras cuando el precio de hoy no es el que cotizó Seba", () => {
    const [line] = priceCartLines([item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 18 })], 40);
    expect(line.priceChange).toEqual({ quotedUsd: 18, todayUsd: 20 });
    expect(quoteComparisonLabel(line)).toBe("cotizado $18.00 · hoy $20.00");
  });

  it("no muestra nada si el precio cotizado es igual al de hoy", () => {
    const [line] = priceCartLines([item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 20 })], 40);
    expect(line.priceChange).toBeNull();
    expect(quoteComparisonLabel(line)).toBeNull();
  });

  it("no muestra nada si el renglón no viene de una cotización", () => {
    const [line] = priceCartLines([item({ quotedPriceUsd: null })], 40);
    expect(quoteComparisonLabel(line)).toBeNull();
  });

  it("no compara si hoy no se puede calcular el precio en dólares", () => {
    const [line] = priceCartLines(
      [item({ origin: "quote", quoteId: "q-1", quotedPriceUsd: 3, product: product({ currency: "VES", price: 101 }) })],
      0
    );
    expect(quoteComparisonLabel(line)).toBeNull();
  });
});

describe("cartTotals — el total en $ es la suma de lo que se factura", () => {
  it("suma los subtotales en dólares por renglón y los bolívares por renglón", () => {
    const lines = priceCartLines(
      [
        item({ id: "a", quantity: 2 }),
        item({ id: "b", productId: "prod-2", product: product({ id: "prod-2", price: 5 }), quantity: 3 }),
      ],
      40
    );
    expect(cartTotals(lines)).toEqual({ usd: 55, bs: 2200, unpricedCount: 0 });
  });

  it("no vuelve a redondear el total: suma los dólares ya redondeados por renglón", () => {
    // Dos renglones VES de 101 Bs a tasa 40: cada uno $2,60 -> $5,20 en total.
    // Convertir el total en bolívares (202 / 40 = 5,05) habría dado $5,10.
    const lines = priceCartLines(
      [
        item({ id: "a", product: product({ id: "p1", currency: "VES", price: 101 }) }),
        item({ id: "b", productId: "p2", product: product({ id: "p2", currency: "VES", price: 101 }) }),
      ],
      40
    );
    expect(cartTotals(lines).usd).toBe(5.2);
    expect(cartTotals(lines).bs).toBe(202);
  });

  it("no arrastra colas de coma flotante", () => {
    const lines = priceCartLines([item({ quantity: 3, product: product({ price: 0.1 }) })], 40);
    expect(cartTotals(lines).usd).toBe(0.3);
  });

  it("cuenta los renglones sin precio y los deja fuera del total en dólares", () => {
    const lines = priceCartLines(
      [
        item({ id: "a" }),
        item({ id: "b", productId: "p2", product: product({ id: "p2", currency: "VES", price: 101 }) }),
      ],
      0
    );
    const totals = cartTotals(lines);
    expect(totals.usd).toBe(20);
    expect(totals.unpricedCount).toBe(1);
    expect(totals.bs).toBeNull();
  });

  it("un carrito vacío suma cero", () => {
    expect(cartTotals(priceCartLines([], 40))).toEqual({ usd: 0, bs: 0, unpricedCount: 0 });
  });
});

describe("cartToSaleLines — lo que recibe closeSaleWithContactInfo", () => {
  it("arma los renglones de la venta con el precio vigente y el vínculo por product_id", () => {
    const lines = priceCartLines(
      [item({ id: "cart-7", origin: "quote", quoteId: "q-1", quotedPriceUsd: 18, quantity: 2 })],
      40
    );
    expect(cartToSaleLines(lines)).toEqual([
      {
        id: "cart-7",
        origin: "quote",
        productId: "prod-1",
        description: "Carburador PZ27",
        unitPrice: 20,
        quantity: 2,
      },
    ]);
  });

  it("un renglón estándar se factura a precio estándar y lo dice en la descripción", () => {
    const lines = priceCartLines(
      [item({ id: "cart-9", priceKind: "estandar", product: product({ price: 25, shippingFeeUsd: 2.5 }), quantity: 2 })],
      40
    );
    expect(cartToSaleLines(lines)).toEqual([
      {
        id: "cart-9",
        origin: "inventory",
        productId: "prod-1",
        description: "Carburador PZ27 (precio estándar, incluye envío MRW)",
        unitPrice: 27.5,
        quantity: 2,
      },
    ]);
  });

  it("deja fuera los renglones que no tienen precio calculable", () => {
    const lines = priceCartLines(
      [item({ id: "a", product: product({ currency: "VES", price: 101 }) })],
      0
    );
    expect(cartToSaleLines(lines)).toEqual([]);
  });
});

// T4 del plan "Ronda del cliente" (30/9/2026): el resumen que el asesor copia
// o deja en el composer para mandarle al cliente lo que lleva.
// 21/10/2026, "Presupuestos y mensajes rápidos" (T3): el rótulo es siempre
// «Precio» (el cliente pidió que NO diga «incluye envío»), el total en
// bolívares sale por defecto y cada parte se puede apagar con las casillas.
describe("cartSummaryText — el resumen del carrito para el cliente", () => {
  function resumen(items: ConversationCartItem[], rate = 40, opciones?: OpcionesCopia) {
    const lines = priceCartLines(items, rate);
    return cartSummaryText(lines, cartTotals(lines), opciones);
  }

  function sin(...claves: (keyof OpcionesCopia)[]): OpcionesCopia {
    const opciones = { ...OPCIONES_COPIA_INICIALES };
    for (const clave of claves) opciones[clave] = false;
    return opciones;
  }

  const DOS_PRODUCTOS = [
    item({ id: "a", product: product({ id: "p1", name: "Caucho 90/90-18 Kenda", price: 25, saintCode: "12345" }), quantity: 1 }),
    item({ id: "b", product: product({ id: "p2", name: "Casco LS2 FF353", price: 40, saintCode: "67890" }), quantity: 2 }),
  ];

  it("un producto: nombre, SKU, precio, total y total en bolívares", () => {
    const text = resumen([
      item({ product: product({ name: "Caucho 90/90-18 Kenda", price: 25, saintCode: "12345" }), quantity: 1 }),
    ]);

    expect(text).toBe(
      [
        "Caucho 90/90-18 Kenda",
        "SKU: 12345",
        "Precio: $25.00",
        "",
        "Total: $25.00",
        "Total en bolívares: Bs. 1.000,00",
      ].join("\n")
    );
  });

  it("con todas las casillas, el texto es el de siempre más la línea de bolívares", () => {
    // El literal de antes de T3 (sin bolívares) es el mismo con `totalBs` apagado.
    const sinBs = [
      "Caucho 90/90-18 Kenda",
      "SKU: 12345",
      "Precio: $25.00",
      "",
      "Casco LS2 FF353 (x2)",
      "SKU: 67890",
      "Precio: $40.00 c/u · $80.00",
      "",
      "Total: $105.00",
    ].join("\n");

    expect(resumen(DOS_PRODUCTOS, 40, sin("totalBs"))).toBe(sinBs);
    expect(resumen(DOS_PRODUCTOS)).toBe(`${sinBs}\nTotal en bolívares: Bs. 4.200,00`);
    expect(resumen(DOS_PRODUCTOS, 40, OPCIONES_COPIA_INICIALES)).toBe(resumen(DOS_PRODUCTOS));
  });

  it("un producto sin código Saint dice «sin código»", () => {
    const text = resumen([item({ product: product({ saintCode: null }), quantity: 1 })]);

    expect(text).toContain("SKU: sin código");
  });

  it("un producto en bolívares usa el precio ya redondeado por usdFromBs", () => {
    // 101 Bs / 40 = 2,525 -> $2,60.
    const text = resumen([item({ product: product({ currency: "VES", price: 101, saintCode: "9" }), quantity: 1 })]);

    expect(text).toContain("Precio: $2.60");
    expect(text).toContain("Total: $2.60");
    expect(text).toContain("Total en bolívares: Bs. 101,00");
  });

  it("si algún renglón no tiene precio en dólares, no hay resumen (no se manda un total falso)", () => {
    const text = resumen(
      [
        item({ id: "a", quantity: 1 }),
        item({ id: "b", product: product({ id: "p2", currency: "VES", price: 101 }), quantity: 1 }),
      ],
      0
    );

    expect(text).toBeNull();
  });

  it("un carrito vacío no tiene resumen", () => {
    expect(resumen([])).toBeNull();
  });

  it("un renglón estándar ya NO dice «incluye envío»: el rótulo es siempre «Precio»", () => {
    const text = resumen(
      [
        item({
          product: product({ name: "Caucho 90/90-18 Kenda", price: 25, saintCode: "12345", shippingFeeUsd: 2.5 }),
          priceKind: "estandar",
          quantity: 1,
        }),
      ],
      40,
      sin("totalBs")
    );

    expect(text).not.toContain("incluye envío");
    expect(text).toBe(["Caucho 90/90-18 Kenda", "SKU: 12345", "Precio: $27.50", "", "Total: $27.50"].join("\n"));
  });

  it("estándar con cantidad 2: c/u y subtotal, sin la frase del envío en ningún renglón", () => {
    const text = resumen([
      item({
        id: "a",
        product: product({ id: "p1", name: "Casco LS2", price: 40, saintCode: "1", shippingFeeUsd: 5 }),
        priceKind: "estandar",
        quantity: 2,
      }),
      item({ id: "b", product: product({ id: "p2", name: "Guante", price: 10, saintCode: "2" }), quantity: 1 }),
    ]);

    expect(text).not.toContain("incluye envío");
    expect(text).toContain("Precio: $45.00 c/u · $90.00");
    expect(text).toContain("Precio: $10.00");
  });

  it("un renglón estándar sin tarifa deja el carrito sin resumen", () => {
    expect(resumen([item({ priceKind: "estandar" })])).toBeNull();
  });

  describe("casillas de qué incluir", () => {
    it("sin código: desaparece la línea SKU de todos los renglones", () => {
      const text = resumen(DOS_PRODUCTOS, 40, sin("codigo", "totalBs")) as string;

      expect(text).not.toContain("SKU");
      expect(text).toBe(
        [
          "Caucho 90/90-18 Kenda",
          "Precio: $25.00",
          "",
          "Casco LS2 FF353 (x2)",
          "Precio: $40.00 c/u · $80.00",
          "",
          "Total: $105.00",
        ].join("\n")
      );
    });

    it("sin cantidad: el nombre no lleva (xN), pero el precio sigue diciendo c/u y subtotal", () => {
      const text = resumen(DOS_PRODUCTOS, 40, sin("cantidad", "totalBs")) as string;

      expect(text).not.toContain("(x2)");
      expect(text).toContain("Casco LS2 FF353\nSKU: 67890\nPrecio: $40.00 c/u · $80.00");
    });

    it("solo subtotal: una sola cifra por renglón, también con cantidad 1", () => {
      const text = resumen(DOS_PRODUCTOS, 40, sin("precioUnitario", "totalBs")) as string;

      expect(text).toContain("Caucho 90/90-18 Kenda\nSKU: 12345\nPrecio: $25.00");
      expect(text).toContain("Casco LS2 FF353 (x2)\nSKU: 67890\nPrecio: $80.00");
      expect(text).not.toContain("c/u");
    });

    it("solo precio unitario: con cantidad 2 dice «c/u» sin subtotal; con cantidad 1 la cifra sola", () => {
      const text = resumen(DOS_PRODUCTOS, 40, sin("subtotal", "totalBs")) as string;

      expect(text).toContain("Precio: $25.00\n");
      expect(text).toContain("Precio: $40.00 c/u\n");
      expect(text).not.toContain("$80.00");
    });

    it("sin precio unitario ni subtotal: el renglón no lleva línea de precio", () => {
      const text = resumen(DOS_PRODUCTOS, 40, sin("precioUnitario", "subtotal", "totalBs")) as string;

      expect(text).not.toContain("Precio:");
      expect(text).toContain("Caucho 90/90-18 Kenda\nSKU: 12345\n\nCasco LS2 FF353 (x2)");
    });

    it("sin total en dólares ni en bolívares: el texto termina en el último renglón", () => {
      const text = resumen(DOS_PRODUCTOS, 40, sin("totalUsd", "totalBs")) as string;

      expect(text).not.toContain("Total");
      expect(text.endsWith("Precio: $40.00 c/u · $80.00")).toBe(true);
    });

    it("con y sin bolívares: la línea va pegada a la del total", () => {
      const con = resumen(DOS_PRODUCTOS) as string;
      expect(con.endsWith("Total: $105.00\nTotal en bolívares: Bs. 4.200,00")).toBe(true);

      const sinBs = resumen(DOS_PRODUCTOS, 40, sin("totalBs")) as string;
      expect(sinBs).not.toContain("bolívares");
    });

    it("solo total en bolívares: sale esa línea sola, sin «Total:»", () => {
      const text = resumen(DOS_PRODUCTOS, 40, sin("totalUsd")) as string;

      expect(text.endsWith("\n\nTotal en bolívares: Bs. 4.200,00")).toBe(true);
      expect(text).not.toContain("Total: $");
    });

    it("sin tasa (bolívares nulos) la línea de bolívares se omite sin anular el resumen", () => {
      const text = resumen([item({ quantity: 1 })], 0) as string;

      expect(text).toContain("Total: $20.00");
      expect(text).not.toContain("bolívares");
    });

    it("todas las casillas de precio apagadas: la lista de nombres sale aunque falte el precio de un renglón", () => {
      const items = [
        item({ id: "a", product: product({ id: "p1", name: "Caucho" }) }),
        item({ id: "b", product: product({ id: "p2", name: "Casco", currency: "VES", price: 101 }), quantity: 2 }),
      ];
      const opciones = sin("precioUnitario", "subtotal", "totalUsd", "totalBs");

      // Sin tasa, el segundo renglón no tiene precio en dólares.
      expect(resumen(items, 0, opciones)).toBe(
        ["Caucho", "SKU: sin código", "", "Casco (x2)", "SKU: sin código"].join("\n")
      );
    });

    it.each(["precioUnitario", "subtotal", "totalUsd", "totalBs"] as const)(
      "con «%s» encendida y un renglón sin precio, no hay resumen",
      (clave) => {
        const items = [item({ id: "b", product: product({ id: "p2", currency: "VES", price: 101 }) })];
        const todasApagadas = sin("precioUnitario", "subtotal", "totalUsd", "totalBs");

        expect(resumen(items, 0, { ...todasApagadas, [clave]: true })).toBeNull();
      }
    );

    it("un carrito vacío sigue sin resumen con cualquier combinación", () => {
      expect(resumen([], 40, sin("precioUnitario", "subtotal", "totalUsd", "totalBs"))).toBeNull();
    });
  });
});
