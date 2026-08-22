import { describe, expect, it } from "vitest";
import type { Contact, CustomerConversationRow } from "@/lib/types";
import {
  CUSTOMERS_PAGE_SIZE,
  customerLocation,
  customerName,
  customersHref,
  formatCedula,
  isProfileIncomplete,
  pageRange,
  parseCustomerParams,
  summarizeCustomerActivity,
  totalPages,
} from "@/lib/customers";

function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: "c1",
    phoneNumber: "584121112233",
    displayName: null,
    profileName: null,
    avatarUrl: null,
    cedulaType: null,
    cedulaNumber: null,
    state: null,
    city: null,
    address: null,
    tags: [],
    ...over,
  };
}

function row(over: Partial<CustomerConversationRow> = {}): CustomerConversationRow {
  return {
    id: "conv-1",
    dealStatus: "none",
    dealClosedAt: null,
    lastMessageAt: null,
    orderTotal: null,
    orderCurrency: null,
    orderPurchasedAt: null,
    ...over,
  };
}

describe("customerName", () => {
  it("prefiere el nombre editado por el asesor", () => {
    expect(customerName(contact({ displayName: "Pedro Pérez", profileName: "Pedrito" }))).toBe("Pedro Pérez");
  });

  it("cae al nombre de perfil de WhatsApp cuando nadie lo editó", () => {
    expect(customerName(contact({ profileName: "Pedrito" }))).toBe("Pedrito");
  });

  it("usa el teléfono cuando no hay ningún nombre", () => {
    expect(customerName(contact())).toBe("584121112233");
  });
});

describe("formatCedula", () => {
  it("junta tipo y número", () => {
    expect(formatCedula(contact({ cedulaType: "V", cedulaNumber: "12345678" }))).toBe("V-12345678");
  });

  it("devuelve null si falta cualquiera de las dos partes", () => {
    expect(formatCedula(contact({ cedulaType: "V" }))).toBeNull();
    expect(formatCedula(contact({ cedulaNumber: "12345678" }))).toBeNull();
  });
});

describe("customerLocation", () => {
  it("arma ciudad y estado", () => {
    expect(customerLocation(contact({ city: "Maracaibo", state: "Zulia" }))).toBe("Maracaibo, Zulia");
  });

  it("no deja comas sueltas cuando solo hay una parte", () => {
    expect(customerLocation(contact({ state: "Zulia" }))).toBe("Zulia");
    expect(customerLocation(contact())).toBeNull();
  });
});

describe("isProfileIncomplete", () => {
  it("marca al contacto sin cédula o sin dirección", () => {
    expect(isProfileIncomplete(contact())).toBe(true);
    expect(isProfileIncomplete(contact({ cedulaType: "V", cedulaNumber: "1", state: "Zulia" }))).toBe(true);
  });

  it("no marca al que tiene cédula y dirección", () => {
    const completo = contact({
      cedulaType: "V",
      cedulaNumber: "12345678",
      state: "Zulia",
      city: "Maracaibo",
      address: "Av. 5 de Julio",
    });
    expect(isProfileIncomplete(completo)).toBe(false);
  });
});

describe("summarizeCustomerActivity", () => {
  it("suma solo las ventas cerradas", () => {
    const activity = summarizeCustomerActivity([
      row({
        id: "a",
        dealStatus: "won",
        orderTotal: 100,
        orderCurrency: "USD",
        orderPurchasedAt: "2026-08-01T10:00:00Z",
      }),
      row({
        id: "b",
        dealStatus: "won",
        orderTotal: 50,
        orderCurrency: "USD",
        orderPurchasedAt: "2026-08-10T10:00:00Z",
      }),
    ]);
    expect(activity.totalSpentUsd).toBe(150);
    expect(activity.purchaseCount).toBe(2);
  });

  // `returnSale` y `deleteSale` solo tocan `conversations`: la fila de
  // `orders` sigue viva. Si el resumen mirara `orders` directo, una
  // devolución seguiría contando como gasto del cliente.
  it("ignora la venta devuelta aunque su orden siga existiendo", () => {
    const activity = summarizeCustomerActivity([
      row({ id: "a", dealStatus: "won", orderTotal: 100, orderCurrency: "USD" }),
      row({ id: "b", dealStatus: "returned", orderTotal: 80, orderCurrency: "USD" }),
    ]);
    expect(activity.totalSpentUsd).toBe(100);
    expect(activity.purchaseCount).toBe(1);
  });

  it("ignora la venta eliminada del feed aunque su orden siga existiendo", () => {
    const activity = summarizeCustomerActivity([
      row({ id: "a", dealStatus: "none", orderTotal: 80, orderCurrency: "USD" }),
    ]);
    expect(activity.totalSpentUsd).toBe(0);
    expect(activity.purchaseCount).toBe(0);
  });

  it("avisa cuando hubo compras fuera de USD en vez de sumarlas mezcladas", () => {
    const activity = summarizeCustomerActivity([
      row({ id: "a", dealStatus: "won", orderTotal: 100, orderCurrency: "USD" }),
      row({ id: "b", dealStatus: "won", orderTotal: 4000, orderCurrency: "VES" }),
    ]);
    expect(activity.totalSpentUsd).toBe(100);
    expect(activity.purchaseCount).toBe(2);
    expect(activity.hasNonUsdPurchases).toBe(true);
  });

  it("toma la fecha de compra más reciente", () => {
    const activity = summarizeCustomerActivity([
      row({
        id: "a",
        dealStatus: "won",
        orderTotal: 10,
        orderCurrency: "USD",
        orderPurchasedAt: "2026-01-01T00:00:00Z",
      }),
      row({
        id: "b",
        dealStatus: "won",
        orderTotal: 10,
        orderCurrency: "USD",
        orderPurchasedAt: "2026-05-01T00:00:00Z",
      }),
    ]);
    expect(activity.lastPurchaseAt).toBe("2026-05-01T00:00:00Z");
  });

  it("usa la fecha de cierre cuando la orden no trae fecha de compra", () => {
    const activity = summarizeCustomerActivity([
      row({ id: "a", dealStatus: "won", orderTotal: 10, orderCurrency: "USD", dealClosedAt: "2026-03-03T00:00:00Z" }),
    ]);
    expect(activity.lastPurchaseAt).toBe("2026-03-03T00:00:00Z");
  });

  it("apunta a la conversación con el mensaje más reciente", () => {
    const activity = summarizeCustomerActivity([
      row({ id: "vieja", lastMessageAt: "2026-01-01T00:00:00Z" }),
      row({ id: "nueva", lastMessageAt: "2026-08-01T00:00:00Z" }),
    ]);
    expect(activity.latestConversationId).toBe("nueva");
    expect(activity.lastMessageAt).toBe("2026-08-01T00:00:00Z");
    expect(activity.conversationCount).toBe(2);
  });

  it("no se cae con un cliente cuyas conversaciones no tienen fecha", () => {
    const activity = summarizeCustomerActivity([row({ id: "sola" })]);
    expect(activity.latestConversationId).toBe("sola");
    expect(activity.lastMessageAt).toBeNull();
  });

  it("devuelve un resumen vacío para el contacto sin conversaciones", () => {
    expect(summarizeCustomerActivity([])).toEqual({
      totalSpentUsd: 0,
      purchaseCount: 0,
      lastPurchaseAt: null,
      lastMessageAt: null,
      conversationCount: 0,
      latestConversationId: null,
      hasNonUsdPurchases: false,
    });
  });
});

describe("parseCustomerParams", () => {
  it("aplica los valores por defecto cuando la URL viene limpia", () => {
    expect(parseCustomerParams({})).toEqual({ query: "", filter: "todos", sort: "recientes", page: 1 });
  });

  it("recorta la búsqueda", () => {
    expect(parseCustomerParams({ q: "  bera  " }).query).toBe("bera");
  });

  it("descarta un filtro que no existe en vez de romper la página", () => {
    expect(parseCustomerParams({ filtro: "inventado" }).filter).toBe("todos");
  });

  it("descarta un orden que no existe", () => {
    expect(parseCustomerParams({ orden: "precio" }).sort).toBe("recientes");
  });

  it("acepta los filtros y órdenes válidos", () => {
    expect(parseCustomerParams({ filtro: "compradores" }).filter).toBe("compradores");
    expect(parseCustomerParams({ filtro: "sin-compras" }).filter).toBe("sin-compras");
    expect(parseCustomerParams({ filtro: "datos-incompletos" }).filter).toBe("datos-incompletos");
    expect(parseCustomerParams({ orden: "nombre" }).sort).toBe("nombre");
  });

  it("ignora páginas absurdas", () => {
    expect(parseCustomerParams({ page: "0" }).page).toBe(1);
    expect(parseCustomerParams({ page: "-3" }).page).toBe(1);
    expect(parseCustomerParams({ page: "abc" }).page).toBe(1);
    expect(parseCustomerParams({ page: "2.7" }).page).toBe(1);
    expect(parseCustomerParams({ page: "5" }).page).toBe(5);
  });

  // Next entrega un array cuando el mismo parámetro aparece repetido en la URL.
  it("toma el primer valor cuando el parámetro viene repetido", () => {
    expect(parseCustomerParams({ q: ["uno", "dos"] }).query).toBe("uno");
  });
});

describe("customersHref", () => {
  it("omite los valores por defecto para dejar la URL limpia", () => {
    expect(customersHref({ query: "", filter: "todos", sort: "recientes", page: 1 })).toBe("/clientes");
  });

  it("conserva lo que no es por defecto", () => {
    expect(customersHref({ query: "pedro", filter: "compradores", sort: "nombre", page: 3 })).toBe(
      "/clientes?q=pedro&filtro=compradores&orden=nombre&page=3"
    );
  });

  it("codifica la búsqueda", () => {
    expect(customersHref({ query: "kit & arrastre", filter: "todos", sort: "recientes", page: 1 })).toBe(
      "/clientes?q=kit+%26+arrastre"
    );
  });
});

describe("paginación", () => {
  it("traduce la página a un rango de PostgREST", () => {
    expect(pageRange(1)).toEqual({ from: 0, to: CUSTOMERS_PAGE_SIZE - 1 });
    expect(pageRange(3)).toEqual({ from: CUSTOMERS_PAGE_SIZE * 2, to: CUSTOMERS_PAGE_SIZE * 3 - 1 });
  });

  it("cuenta al menos una página aunque no haya resultados", () => {
    expect(totalPages(0)).toBe(1);
    expect(totalPages(1)).toBe(1);
    expect(totalPages(CUSTOMERS_PAGE_SIZE)).toBe(1);
    expect(totalPages(CUSTOMERS_PAGE_SIZE + 1)).toBe(2);
  });
});
