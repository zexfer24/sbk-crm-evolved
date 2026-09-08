import { describe, expect, it } from "vitest";
import type { Contact } from "@/lib/types";
import {
  buildInvoiceDraft,
  computeInvoiceTotals,
  DEFAULT_TAX_RATE,
  formatInvoiceNumber,
  INVOICE_ISSUER,
} from "@/lib/invoices";

describe("formatInvoiceNumber — el correlativo que ve el cliente", () => {
  it("rellena con ceros a la izquierda hasta seis dígitos", () => {
    expect(formatInvoiceNumber(1)).toBe("SBK-000001");
  });

  it("no recorta un correlativo que ya tiene más de seis dígitos", () => {
    expect(formatInvoiceNumber(123456)).toBe("SBK-123456");
    expect(formatInvoiceNumber(1234567)).toBe("SBK-1234567");
  });
});

describe("computeInvoiceTotals — redondeo a centavos, no a la coma flotante", () => {
  it("tres renglones de $0.335 no arrastran el error de 0.335 * 3 (1.0049999999999999)", () => {
    // El caso real que motivó el redondeo por renglón: sumar en USD de coma
    // flotante da 1.0049999999999999, no 1.02. Se deja la prueba de que el
    // problema es real antes de afirmar que el cálculo lo evita.
    expect(0.335 * 3).not.toBe(1.02);

    const totals = computeInvoiceTotals([{ unitPrice: 0.335, quantity: 3 }], 0);

    expect(totals.subtotal).toBe(1.02);
    expect(totals.taxAmount).toBe(0);
    expect(totals.total).toBe(1.02);
  });

  it("no arrastra el error clásico de sumar 0.1 + 0.1 + 0.1", () => {
    const totals = computeInvoiceTotals(
      [
        { unitPrice: 0.1, quantity: 1 },
        { unitPrice: 0.1, quantity: 1 },
        { unitPrice: 0.1, quantity: 1 },
      ],
      0
    );

    expect(totals.subtotal).toBe(0.3);
  });

  it("aplica la tasa de impuesto sobre el subtotal ya redondeado", () => {
    const totals = computeInvoiceTotals([{ unitPrice: 100, quantity: 1 }], 0.16);

    expect(totals.subtotal).toBe(100);
    expect(totals.taxAmount).toBe(16);
    expect(totals.total).toBe(116);
  });

  it("sin renglones, todo da cero", () => {
    expect(computeInvoiceTotals([], DEFAULT_TAX_RATE)).toEqual({ subtotal: 0, taxAmount: 0, total: 0 });
  });
});

describe("INVOICE_ISSUER — sin datos fiscales inventados", () => {
  it("deja RIF, dirección, teléfono y ciudad en null hasta que el operador los defina", () => {
    expect(INVOICE_ISSUER.name).toBe("SBK Motorcycles");
    expect(INVOICE_ISSUER.rif).toBeNull();
    expect(INVOICE_ISSUER.address).toBeNull();
    expect(INVOICE_ISSUER.phone).toBeNull();
    expect(INVOICE_ISSUER.city).toBeNull();
  });
});

const CONTACT: Contact = {
  id: "contact-1",
  phoneNumber: "+584121234567",
  displayName: "Cliente Demo",
  profileName: "Demo WA",
  avatarUrl: null,
  tags: [],
  cedulaType: "V",
  cedulaNumber: "12345678",
  state: "Barinas",
  city: "Barinas",
  address: "Calle Falsa 123",
};

describe("buildInvoiceDraft — snapshot del cliente y de los renglones, no referencias vivas", () => {
  it("copia el contacto y los renglones: editarlos después no toca el borrador ya armado", () => {
    const contact = { ...CONTACT };
    const orderItems = [{ description: "Carburador PZ27", quantity: 1, unitPrice: 18 }];

    const draft = buildInvoiceDraft({
      sale: { id: "conv-1" },
      orderId: "order-1",
      orderItems,
      contact,
      bcvRate: 40,
    });

    // Mutar los objetos originales DESPUÉS de armar el borrador: si el
    // snapshot fuera una referencia viva, esto se vería reflejado.
    contact.displayName = "Otro nombre";
    orderItems[0].description = "Otro repuesto";
    orderItems[0].unitPrice = 999;

    expect(draft.customer.displayName).toBe("Cliente Demo");
    expect(draft.items[0].description).toBe("Carburador PZ27");
    expect(draft.items[0].unitPrice).toBe(18);
  });

  it("arma el subtotal/total a partir de los renglones y guarda la tasa BCV", () => {
    const draft = buildInvoiceDraft({
      sale: { id: "conv-1" },
      orderId: "order-1",
      orderItems: [
        { description: "Carburador PZ27", quantity: 1, unitPrice: 18 },
        { description: "Kit de arrastre", quantity: 2, unitPrice: 32.5 },
      ],
      contact: CONTACT,
      bcvRate: 40,
    });

    expect(draft.conversationId).toBe("conv-1");
    expect(draft.orderId).toBe("order-1");
    expect(draft.contactId).toBe("contact-1");
    expect(draft.items).toEqual([
      { description: "Carburador PZ27", quantity: 1, unitPrice: 18, amount: 18 },
      { description: "Kit de arrastre", quantity: 2, unitPrice: 32.5, amount: 65 },
    ]);
    expect(draft.subtotal).toBe(83);
    expect(draft.taxRate).toBe(DEFAULT_TAX_RATE);
    expect(draft.taxAmount).toBe(0);
    expect(draft.total).toBe(83);
    expect(draft.currency).toBe("USD");
    expect(draft.bcvRate).toBe(40);
  });

  it("sin nombre de contacto, cae al nombre de perfil de WhatsApp antes que a un texto vacío", () => {
    const draft = buildInvoiceDraft({
      sale: { id: "conv-1" },
      orderId: "order-1",
      orderItems: [{ description: "Casco", quantity: 1, unitPrice: 50 }],
      contact: { ...CONTACT, displayName: null },
      bcvRate: null,
    });

    expect(draft.customer.displayName).toBe("Demo WA");
    expect(draft.bcvRate).toBeNull();
  });
});
