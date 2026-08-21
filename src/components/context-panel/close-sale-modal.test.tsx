import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloseSaleModal } from "@/components/context-panel/close-sale-modal";
import type { Agent, Contact, ConversationQuote } from "@/lib/types";

const closeSaleWithContactInfo = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/mutations", () => ({
  closeSaleWithContactInfo: (...args: unknown[]) => closeSaleWithContactInfo(...args),
}));

const QUOTES: ConversationQuote[] = [
  {
    id: "q-1",
    productId: "prod-1",
    productName: "Carburador PZ27",
    priceUsd: 18,
    priceBs: 720,
    bcvRate: 40,
    quotedAt: "2026-08-21T12:00:00.000Z",
  },
  {
    id: "q-2",
    productId: "prod-2",
    productName: "Kit de arrastre",
    priceUsd: 32.5,
    priceBs: 1300,
    bcvRate: 40,
    quotedAt: "2026-08-21T11:00:00.000Z",
  },
];

const fetchConversationQuotes = vi.fn().mockResolvedValue(QUOTES);
vi.mock("@/lib/data", () => ({
  fetchConversationQuotes: (...args: unknown[]) => fetchConversationQuotes(...args),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => ({
    storage: { from: vi.fn(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() })) },
  })),
}));

const CONTACT: Contact = {
  id: "contact-1",
  phoneNumber: "+58123456789",
  displayName: "Cliente Demo",
  profileName: "Cliente",
  avatarUrl: null,
  cedulaType: null,
  cedulaNumber: null,
  state: null,
  city: null,
  address: null,
  tags: [],
};

const AGENT: Agent = {
  id: "agent-1",
  displayName: "José Riera",
  fullName: "José Riera",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

beforeEach(() => {
  closeSaleWithContactInfo.mockClear();
  fetchConversationQuotes.mockClear();
});

describe("CloseSaleModal — el monto sale de las cotizaciones reales, no se escribe a mano", () => {
  it("no deja cerrar la venta sin seleccionar al menos una cotización", async () => {
    render(
      <CloseSaleModal
        isOpen
        onOpenChange={() => {}}
        conversationId="conv-1"
        contact={CONTACT}
        agent={AGENT}
        messages={[]}
      />
    );

    await waitFor(() => expect(screen.getByText("Carburador PZ27")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /guardar y cerrar venta/i })).toBeDisabled();
  });

  it("al seleccionar una cotización, cierra la venta con esa línea exacta (producto, precio y cantidad) sin ningún campo de monto manual", async () => {
    const user = userEvent.setup();
    render(
      <CloseSaleModal
        isOpen
        onOpenChange={() => {}}
        conversationId="conv-1"
        contact={CONTACT}
        agent={AGENT}
        messages={[]}
      />
    );

    await waitFor(() => expect(screen.getByText("Carburador PZ27")).toBeInTheDocument());

    // No debe existir ningún input numérico libre para escribir un monto de venta.
    expect(screen.queryByLabelText(/monto/i)).not.toBeInTheDocument();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");

    const submit = screen.getByRole("button", { name: /guardar y cerrar venta/i });
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    const items = closeSaleWithContactInfo.mock.calls[0][5];
    expect(items).toEqual([
      { quoteId: "q-1", productId: "prod-1", description: "Carburador PZ27", unitPrice: 18, quantity: 1 },
    ]);
    const bcvRate = closeSaleWithContactInfo.mock.calls[0][6];
    expect(bcvRate).toBe(40);
  });
});
