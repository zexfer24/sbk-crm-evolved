/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Invoice } from "@/lib/types";
import { InvoiceSheet } from "@/components/sales/invoice-sheet";

const BASE_INVOICE: Invoice = {
  id: "inv-1",
  number: 7,
  conversationId: "conv-1",
  orderId: "order-1",
  contactId: "contact-1",
  customer: {
    displayName: "Cliente Demo",
    phoneNumber: "+584121234567",
    cedulaType: "V",
    cedulaNumber: "12345678",
    state: "Barinas",
    city: "Barinas",
    address: "Calle Falsa 123",
  },
  items: [
    { description: "Carburador PZ27", quantity: 1, unitPrice: 18, amount: 18 },
    { description: "Kit de arrastre", quantity: 2, unitPrice: 32.5, amount: 65 },
  ],
  subtotal: 83,
  taxRate: 0,
  taxAmount: 0,
  total: 83,
  currency: "USD",
  bcvRate: 40,
  status: "draft",
  issuedAt: null,
  issuedBy: null,
  voidedAt: null,
  notes: null,
  createdAt: "2026-09-08T12:00:00.000Z",
  updatedAt: "2026-09-08T12:00:00.000Z",
};

describe("InvoiceSheet — pinta ítems, totales y los datos fiscales que faltan", () => {
  it("pinta el correlativo, los renglones y los totales en USD y en Bs", () => {
    render(<InvoiceSheet invoice={BASE_INVOICE} />);

    expect(screen.getByText("SBK-000007")).toBeInTheDocument();
    expect(screen.getByText("Carburador PZ27")).toBeInTheDocument();
    expect(screen.getByText("Kit de arrastre")).toBeInTheDocument();
    // El subtotal y el total coinciden (sin IVA): aparecen dos veces.
    expect(screen.getAllByText("$83.00")).toHaveLength(2);
    // Total en bolívares: 83 * 40 = 3320.00
    expect(screen.getByText("Bs. 3320.00")).toBeInTheDocument();
  });

  it('sin RIF/dirección/teléfono/ciudad del emisor, los muestra como "Por definir" sin inventar nada', () => {
    render(<InvoiceSheet invoice={BASE_INVOICE} />);

    // INVOICE_ISSUER trae los cuatro en null: deben aparecer las cuatro etiquetas "Por definir".
    expect(screen.getAllByText("Por definir")).toHaveLength(4);
  });

  it('sin tasa BCV guardada, el total en bolívares también dice "Por definir" en vez de calcular con una tasa inventada', () => {
    render(<InvoiceSheet invoice={{ ...BASE_INVOICE, bcvRate: null }} />);

    expect(screen.getAllByText("Por definir").length).toBeGreaterThanOrEqual(5);
  });

  it("una factura anulada avisa que fue anulada", () => {
    render(<InvoiceSheet invoice={{ ...BASE_INVOICE, status: "void", voidedAt: "2026-09-08T13:00:00.000Z" }} />);

    expect(screen.getByText("Esta factura fue anulada.")).toBeInTheDocument();
  });
});
