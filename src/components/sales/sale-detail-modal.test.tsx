/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Agent, Invoice, Sale } from "@/lib/types";
import { SaleDetailModal } from "@/components/sales/sale-detail-modal";

const AGENT: Agent = {
  id: "agent-1",
  displayName: "José Riera",
  fullName: "José Riera",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

const SUPERVISOR: Agent = { ...AGENT, id: "sup-1", displayName: "María Supervisora", role: "supervisor" };

const SALE: Sale = {
  id: "conv-1",
  contact: {
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
  },
  dealStatus: "won",
  dealClosedAt: "2026-09-08T12:00:00.000Z",
  dealPaymentProofUrl: null,
  dealAmount: 83,
  dealCurrency: "USD",
  dealVerified: false,
  dealVerifiedAt: null,
  dealVerifiedBy: null,
  dealPaymentMethod: "pago_movil",
  dealClosedBy: null,
  createdAt: "2026-09-08T11:00:00.000Z",
};

const INVOICE: Invoice = {
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
  items: [{ description: "Carburador PZ27", quantity: 1, unitPrice: 18, amount: 18 }],
  subtotal: 18,
  taxRate: 0,
  taxAmount: 0,
  total: 18,
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

function baseProps() {
  return {
    isOpen: true,
    onOpenChange: vi.fn(),
    sale: SALE,
    busy: false,
    confirmingDelete: false,
    onVerify: vi.fn(),
    onReturn: vi.fn(),
    onDelete: vi.fn(),
    invoiceBusy: false,
    onGenerateInvoice: vi.fn(),
    onIssueInvoice: vi.fn(),
    onVoidInvoice: vi.fn(),
  };
}

describe("SaleDetailModal — sección Factura", () => {
  it('sin factura todavía, muestra "Generar factura" y lo pide con el id de la venta', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const props = baseProps();

    render(<SaleDetailModal {...props} currentAgent={AGENT} invoice={null} />);

    const boton = screen.getByRole("button", { name: /generar factura/i });
    await user.click(boton);

    expect(props.onGenerateInvoice).toHaveBeenCalledWith("conv-1");
  });

  it("mientras se busca la factura, no ofrece el botón de generar", () => {
    render(<SaleDetailModal {...baseProps()} currentAgent={AGENT} invoice={undefined} />);

    expect(screen.queryByRole("button", { name: /generar factura/i })).not.toBeInTheDocument();
    expect(screen.getByText(/buscando factura/i)).toBeInTheDocument();
  });

  it("con factura, muestra el número formateado, el estado y el enlace para imprimir", () => {
    render(<SaleDetailModal {...baseProps()} currentAgent={AGENT} invoice={INVOICE} />);

    expect(screen.getByText("SBK-000007")).toBeInTheDocument();
    expect(screen.getByText("Borrador")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /ver e imprimir/i });
    expect(link).toHaveAttribute("href", "/ventas/factura/inv-1");
  });

  it("a un asesor común le esconde Emitir y Anular", () => {
    render(<SaleDetailModal {...baseProps()} currentAgent={AGENT} invoice={INVOICE} />);

    expect(screen.queryByRole("button", { name: /^emitir$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^anular$/i })).not.toBeInTheDocument();
  });

  it("a un supervisor le muestra Emitir y Anular, y los pide con el id de la venta y de la factura", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const props = baseProps();

    render(<SaleDetailModal {...props} currentAgent={SUPERVISOR} invoice={INVOICE} />);

    await user.click(screen.getByRole("button", { name: /^emitir$/i }));
    expect(props.onIssueInvoice).toHaveBeenCalledWith("conv-1", "inv-1");

    await user.click(screen.getByRole("button", { name: /^anular$/i }));
    expect(props.onVoidInvoice).toHaveBeenCalledWith("conv-1", "inv-1");
  });

  it("una factura ya emitida no ofrece Emitir de nuevo, pero sí Anular", () => {
    render(
      <SaleDetailModal
        {...baseProps()}
        currentAgent={SUPERVISOR}
        invoice={{ ...INVOICE, status: "issued", issuedAt: "2026-09-08T13:00:00.000Z" }}
      />
    );

    expect(screen.queryByRole("button", { name: /^emitir$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^anular$/i })).toBeInTheDocument();
  });

  it("una factura anulada no ofrece ni Emitir ni Anular", () => {
    render(
      <SaleDetailModal
        {...baseProps()}
        currentAgent={SUPERVISOR}
        invoice={{ ...INVOICE, status: "void", voidedAt: "2026-09-08T13:00:00.000Z" }}
      />
    );

    expect(screen.queryByRole("button", { name: /^emitir$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^anular$/i })).not.toBeInTheDocument();
  });
});
