/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SalesView } from "@/components/sales/sales-view";
import type { Agent, Contact, DealStatus, Sale } from "@/lib/types";

/**
 * T6, corrida "Los números del día" (10/9/2026): Ventas resume el día
 * elegido (tarjetas) y deja navegar a cualquier otro con las flechas, el
 * input de fecha o el histórico. El corte por día es en memoria
 * (`salesOnDay`/`summarizeSalesDay`/`salesDayHistory` de `@/lib/sales-day`,
 * ya probado aparte) — acá se prueba que la vista los conecta bien.
 *
 * Se mockean los vecinos pesados (AppRail tira de next/navigation,
 * SaleDetailModal de @heroui/react) siguiendo el patrón de
 * agent-control-view.test.tsx: nada de eso se prueba acá.
 */

vi.mock("@/components/app-rail", () => ({ AppRail: () => null, AppTopNav: () => null }));
vi.mock("@/components/sales/sale-detail-modal", () => ({ SaleDetailModal: () => null }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({}),
}));

const refreshSalesMock = vi.fn(async () => {});
let liveSales: Sale[] = [];
vi.mock("@/lib/use-live-sales", () => ({
  useLiveSales: (..._args: unknown[]) => {
    void _args;
    return { sales: liveSales, refreshSales: refreshSalesMock };
  },
}));

vi.mock("@/lib/mutations", () => ({
  createInvoiceForSale: vi.fn(async () => null),
  deleteSale: vi.fn(async () => {}),
  issueInvoice: vi.fn(async () => null),
  returnSale: vi.fn(async () => {}),
  verifySale: vi.fn(async () => {}),
  voidInvoice: vi.fn(async () => null),
}));

vi.mock("@/lib/invoices-data", () => ({
  fetchInvoicesForSale: vi.fn(async () => []),
}));

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

const AGENT: Agent = {
  id: "agent-1",
  displayName: "Asesor Demo",
  fullName: "Asesor Demo",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

let saleSeq = 0;

function venta(overrides: Partial<Sale> = {}): Sale {
  saleSeq += 1;
  return {
    id: `sale-${saleSeq}`,
    contact: { ...CONTACT, displayName: `Cliente ${saleSeq}` },
    dealStatus: "won" as DealStatus,
    dealClosedAt: "2026-09-10T14:00:00.000Z",
    dealPaymentProofUrl: null,
    dealAmount: 100,
    dealCurrency: "USD",
    dealVerified: false,
    dealVerifiedAt: null,
    dealVerifiedBy: null,
    dealPaymentMethod: null,
    dealClosedBy: null,
    createdAt: "2026-09-10T13:00:00.000Z",
    ...overrides,
  };
}

// 15:00 UTC del 10/9 es 11:00 en Caracas (UTC-4): "hoy" es sin ambigüedad
// el 10/9 en la zona del equipo.
const HOY = new Date("2026-09-10T15:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ now: HOY });
});

afterEach(() => {
  vi.useRealTimers();
  liveSales = [];
  saleSeq = 0;
  refreshSalesMock.mockClear();
});

describe("SalesView / los números del día", () => {
  it("resume solo las ventas de hoy en las tarjetas y en la lista", () => {
    liveSales = [
      venta({ dealAmount: 100, dealClosedAt: "2026-09-10T13:00:00.000Z" }),
      venta({ dealAmount: 50, dealClosedAt: "2026-09-10T14:30:00.000Z" }),
      // De ayer: no debe contar ni aparecer en la lista de hoy.
      venta({ dealAmount: 999, dealClosedAt: "2026-09-09T14:00:00.000Z" }),
    ];

    render(<SalesView currentAgent={AGENT} initialSales={liveSales} bcvRate={40} />);

    expect(screen.getByText("Ventas de hoy")).toBeInTheDocument();
    expect(screen.getByText("2 en el día")).toBeInTheDocument();

    const ventasDelDia = screen.getByText("Ventas del día").closest(".cli-stat");
    expect(ventasDelDia).not.toBeNull();
    expect(ventasDelDia?.textContent).toContain("2");

    const vendidoElDia = screen.getByText("Vendido el día").closest(".cli-stat");
    expect(vendidoElDia?.textContent).toMatch(/150,00/);

    // Solo dos filas: la de ayer no se pinta.
    expect(screen.getAllByText(/^Cliente \d$/).length).toBe(2);
    expect(screen.queryByText("Cliente 3")).not.toBeInTheDocument();
  });

  it("cambiar el input de fecha a ayer deja solo esa venta y actualiza las tarjetas", () => {
    liveSales = [
      venta({ dealAmount: 100, dealClosedAt: "2026-09-10T13:00:00.000Z" }),
      venta({ dealAmount: 30, dealClosedAt: "2026-09-09T14:00:00.000Z" }),
    ];

    render(<SalesView currentAgent={AGENT} initialSales={liveSales} bcvRate={40} />);

    fireEvent.change(screen.getByLabelText("Elegir día"), { target: { value: "2026-09-09" } });

    expect(screen.getByText("1 en el día")).toBeInTheDocument();
    expect(screen.getByText("Cliente 2")).toBeInTheDocument();
    expect(screen.queryByText("Cliente 1")).not.toBeInTheDocument();

    const ventasDelDia = screen.getByText("Ventas del día").closest(".cli-stat");
    expect(ventasDelDia?.textContent).toContain("1");
  });

  it("un clic en una fila del histórico selecciona ese día", () => {
    liveSales = [
      venta({ dealAmount: 100, dealClosedAt: "2026-09-10T13:00:00.000Z" }),
      venta({ dealAmount: 30, dealClosedAt: "2026-09-08T14:00:00.000Z" }),
    ];

    render(<SalesView currentAgent={AGENT} initialSales={liveSales} bcvRate={40} />);

    const filaAnterior = screen.getByText("8 sep").closest(".sales-history-row");
    expect(filaAnterior).not.toBeNull();
    expect(filaAnterior).not.toHaveAttribute("aria-current", "true");

    fireEvent.click(filaAnterior as HTMLElement);

    expect(filaAnterior).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Cliente 2")).toBeInTheDocument();
    expect(screen.queryByText("Cliente 1")).not.toBeInTheDocument();
  });

  it("una devuelta de hoy cuenta en Devueltas y no suma en Vendido", () => {
    liveSales = [
      venta({ dealStatus: "won", dealAmount: 100, dealClosedAt: "2026-09-10T13:00:00.000Z" }),
      venta({ dealStatus: "returned", dealAmount: 20, dealClosedAt: "2026-09-10T14:00:00.000Z" }),
    ];

    render(<SalesView currentAgent={AGENT} initialSales={liveSales} bcvRate={40} />);

    const devueltas = screen.getByText("Devueltas").closest(".cli-stat");
    expect(devueltas?.textContent).toContain("1");

    const vendidoElDia = screen.getByText("Vendido el día").closest(".cli-stat");
    // Solo la venta ganada (100), la devuelta no suma.
    expect(vendidoElDia?.textContent).toMatch(/100,00/);
  });

  it("el botón de día siguiente está deshabilitado en hoy", () => {
    liveSales = [venta({ dealClosedAt: "2026-09-10T13:00:00.000Z" })];

    render(<SalesView currentAgent={AGENT} initialSales={liveSales} bcvRate={40} />);

    expect(screen.getByLabelText("Día siguiente")).toBeDisabled();
    expect(screen.getByText("Hoy")).toBeDisabled();
  });
});
