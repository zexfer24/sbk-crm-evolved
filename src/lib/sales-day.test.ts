import { describe, expect, it } from "vitest";
import {
  crmDayKey,
  formatDayKey,
  saleDayKey,
  salesDayHistory,
  shiftDayKey,
  summarizeSalesDay,
  todayKey,
} from "@/lib/sales-day";
import type { Contact, DealStatus, Sale } from "@/lib/types";

const CONTACT: Contact = {
  id: "contact-1",
  phoneNumber: "+584140000000",
  displayName: "Cliente de prueba",
  profileName: null,
  avatarUrl: null,
  tags: [],
  cedulaType: null,
  cedulaNumber: null,
  state: null,
  city: null,
  address: null,
};

let saleSeq = 0;

/** Fabrica una venta mínima; cada llamado pisa solo lo que le importa al test. */
function venta(overrides: Partial<Sale> = {}): Sale {
  saleSeq += 1;
  return {
    id: `sale-${saleSeq}`,
    contact: CONTACT,
    dealStatus: "won" as DealStatus,
    dealClosedAt: "2026-09-09T15:00:00.000Z",
    dealPaymentProofUrl: null,
    dealAmount: 100,
    dealCurrency: "USD",
    dealVerified: false,
    dealVerifiedAt: null,
    dealVerifiedBy: null,
    dealPaymentMethod: null,
    dealClosedBy: null,
    createdAt: "2026-09-09T14:00:00.000Z",
    ...overrides,
  };
}

describe("crmDayKey / saleDayKey", () => {
  it("agrupa por el día de Caracas, no por el día crudo del ISO en UTC", () => {
    // 23:30 en Caracas del 9/9 es 03:30 UTC del 10/9 (Caracas es UTC-4).
    expect(crmDayKey("2026-09-10T03:30:00.000Z")).toBe("2026-09-09");
    // 00:10 en Caracas del 10/9 es 04:10 UTC del mismo 10/9.
    expect(crmDayKey("2026-09-10T04:10:00.000Z")).toBe("2026-09-10");
  });

  it("usa dealClosedAt si existe, y createdAt si la venta todavía no cerró", () => {
    const cerrada = venta({ dealClosedAt: "2026-09-10T03:30:00.000Z", createdAt: "2026-09-08T00:00:00.000Z" });
    expect(saleDayKey(cerrada)).toBe("2026-09-09");

    const sinCerrar = venta({ dealClosedAt: null, createdAt: "2026-09-10T04:10:00.000Z" });
    expect(saleDayKey(sinCerrar)).toBe("2026-09-10");
  });
});

describe("summarizeSalesDay", () => {
  it("cuenta y suma solo las won en USD, aparte las won en VES, y cuenta las devueltas", () => {
    const key = "2026-09-09";
    const sales = [
      venta({ dealStatus: "won", dealCurrency: "USD", dealAmount: 100, dealClosedAt: "2026-09-09T14:00:00.000Z" }),
      venta({ dealStatus: "won", dealCurrency: "USD", dealAmount: 50.555, dealClosedAt: "2026-09-09T15:00:00.000Z" }),
      venta({ dealStatus: "returned", dealAmount: 20, dealClosedAt: "2026-09-09T16:00:00.000Z" }),
      // Won en VES: no debe entrar a amountUsd, sino a amountVes aparte.
      venta({ dealStatus: "won", dealCurrency: "VES", dealAmount: 5000, dealClosedAt: "2026-09-09T17:00:00.000Z" }),
      // Otro día: no debe contar.
      venta({ dealStatus: "won", dealCurrency: "USD", dealAmount: 999, dealClosedAt: "2026-09-08T12:00:00.000Z" }),
    ];

    const summary = summarizeSalesDay(sales, key);

    expect(summary.count).toBe(2);
    expect(summary.amountUsd).toBe(150.56);
    expect(summary.returned).toBe(1);
    expect(summary.amountVes).toBe(5000);
  });

  it("trata dealCurrency null como USD, porque closeSale siempre cierra en dólares", () => {
    const key = "2026-09-09";
    const sales = [
      venta({ dealStatus: "won", dealCurrency: null, dealAmount: 30, dealClosedAt: "2026-09-09T14:00:00.000Z" }),
    ];

    const summary = summarizeSalesDay(sales, key);

    expect(summary.count).toBe(1);
    expect(summary.amountUsd).toBe(30);
    expect(summary.amountVes).toBe(0);
  });
});

describe("salesDayHistory", () => {
  it("salta los días sin ventas, va del más reciente al más viejo y respeta el tope", () => {
    const sales = [
      venta({ dealClosedAt: "2026-09-10T12:00:00.000Z", dealAmount: 10 }),
      venta({ dealClosedAt: "2026-09-08T12:00:00.000Z", dealAmount: 20 }),
      venta({ dealClosedAt: "2026-09-08T13:00:00.000Z", dealAmount: 5 }),
      venta({ dealClosedAt: "2026-09-05T12:00:00.000Z", dealAmount: 7 }),
      // 9/9 no tiene ninguna venta: no debe aparecer una fila para ese día.
    ];

    const history = salesDayHistory(sales);

    expect(history.map((entry) => entry.key)).toEqual(["2026-09-10", "2026-09-08", "2026-09-05"]);
    expect(history[1]).toMatchObject({ key: "2026-09-08", count: 2, amountUsd: 25 });

    const limited = salesDayHistory(sales, 2);
    expect(limited.map((entry) => entry.key)).toEqual(["2026-09-10", "2026-09-08"]);
  });
});

describe("shiftDayKey", () => {
  it("suma y resta días cruzando mes y año", () => {
    expect(shiftDayKey("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("formatDayKey", () => {
  it("escribe la fecha en español, sin correrse de día por la zona del navegador", () => {
    expect(formatDayKey("2026-09-10")).toContain("10 de septiembre de 2026");
  });
});

describe("todayKey", () => {
  it("devuelve la clave de hoy en la zona dada", () => {
    // 23:30 en Caracas del 9/9 (03:30 UTC del 10/9): "hoy" en Caracas es el 9.
    const now = new Date("2026-09-10T03:30:00.000Z");
    expect(todayKey(now)).toBe("2026-09-09");
  });
});
