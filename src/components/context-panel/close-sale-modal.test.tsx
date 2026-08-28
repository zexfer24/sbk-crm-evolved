/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloseSaleModal } from "@/components/context-panel/close-sale-modal";
import type { Agent, Contact, ConversationQuote, Product } from "@/lib/types";

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

const BUJIA: Product = {
  id: "prod-9",
  name: "Bujía CR7HSA",
  brand: "NGK",
  price: 3.25,
  currency: "USD",
  stockQuantity: 40,
  description: null,
  isActive: true,
  updatedAt: "2026-08-22T10:00:00.000Z",
  compatibility: [],
};

const fetchConversationQuotes = vi.fn().mockResolvedValue(QUOTES);
const fetchLatestBcvRate = vi.fn().mockResolvedValue(40);
vi.mock("@/lib/data", () => ({
  fetchConversationQuotes: (...args: unknown[]) => fetchConversationQuotes(...args),
  fetchLatestBcvRate: (...args: unknown[]) => fetchLatestBcvRate(...args),
}));

const searchActiveProducts = vi.fn().mockResolvedValue([BUJIA]);
vi.mock("@/lib/inventory-data", () => ({
  searchActiveProducts: (...args: unknown[]) => searchActiveProducts(...args),
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
  fetchLatestBcvRate.mockClear();
  searchActiveProducts.mockClear();
});

function renderModal() {
  return render(
    <CloseSaleModal
      isOpen
      onOpenChange={() => {}}
      conversationId="conv-1"
      contact={CONTACT}
      agent={AGENT}
      messages={[]}
    />
  );
}

/** Espera a que las cotizaciones del chat estén ofrecidas. */
async function waitForQuotes() {
  await waitFor(() => expect(screen.getByText("Carburador PZ27")).toBeInTheDocument());
}

function submitButton() {
  return screen.getByRole("button", { name: /guardar y cerrar venta/i });
}

/**
 * `userEvent.setup()` por defecto mete un `setTimeout(0)` (salto de
 * macrotarea) entre cada pulsación y hace `pointerEventsCheck` (que sube el
 * árbol con `getComputedStyle`) en cada click. Con la CPU contendida — varios
 * agentes corriendo en paralelo en esta máquina el 28/8/2026 — esos costos
 * multiplicados por decenas de interacciones revientan el timeout de la
 * prueba. Sin usuarios reales de por medio no hace falta simular el delay
 * entre teclas ni repetir el chequeo de puntero en cada click.
 */
function crearUsuario() {
  return userEvent.setup({ delay: null, pointerEventsCheck: 0 });
}

/** Con qué pagó el cliente: sin esto la venta no se puede cerrar. */
async function elegirMétodoDePago(user: ReturnType<typeof userEvent.setup>, valor = "pago_movil") {
  await user.selectOptions(screen.getByLabelText("Método de pago"), valor);
}

function itemsSentToClose() {
  return closeSaleWithContactInfo.mock.calls[0][5];
}

describe("CloseSaleModal — el asesor arma la venta, pero el precio lo pone el catálogo", () => {
  it("no deja cerrar la venta sin un solo renglón", async () => {
    renderModal();
    await waitForQuotes();

    expect(submitButton()).toBeDisabled();
  });

  // La regla que sostiene todo el módulo: el monto de una venta nunca se
  // teclea, sale de un precio real del catálogo.
  it("no ofrece ningún campo para escribir el monto a mano", async () => {
    renderModal();
    await waitForQuotes();

    expect(screen.queryByLabelText(/monto/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/precio/i)).not.toBeInTheDocument();
  });

  it("cierra la venta con la cotización que el asesor tomó del chat", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");
    await elegirMétodoDePago(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(itemsSentToClose()).toEqual([
      {
        id: "q-1",
        origin: "quote",
        productId: "prod-1",
        description: "Carburador PZ27",
        unitPrice: 18,
        quantity: 1,
      },
    ]);
  });

  // Lo que faltaba: el cliente agrega algo al final que nunca pasó por el
  // chat, y antes eso obligaba a no cerrar la venta.
  it("deja agregar un repuesto del inventario que la IA nunca cotizó", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.type(screen.getByLabelText("Buscar repuesto en el inventario"), "bujía");
    await waitFor(() => expect(screen.getByText("Bujía CR7HSA")).toBeInTheDocument());
    await user.click(screen.getByText("Bujía CR7HSA"));

    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");
    await elegirMétodoDePago(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(itemsSentToClose()).toEqual([
      {
        id: "prod-9",
        origin: "inventory",
        productId: "prod-9",
        description: "Bujía CR7HSA",
        unitPrice: 3.25,
        quantity: 1,
      },
    ]);
  });

  it("deja quitar un renglón que ya no lleva el cliente", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.click(screen.getByText("Kit de arrastre"));

    await user.click(screen.getByLabelText("Quitar Carburador PZ27 de la venta"));

    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");
    await elegirMétodoDePago(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    const items = itemsSentToClose();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ description: "Kit de arrastre" });
  });

  it("deja subir la cantidad y el monto la sigue", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.click(screen.getByLabelText("Agregar una unidad de Carburador PZ27"));
    await user.click(screen.getByLabelText("Agregar una unidad de Carburador PZ27"));

    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");
    await elegirMétodoDePago(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(itemsSentToClose()[0]).toMatchObject({ quantity: 3, unitPrice: 18 });
  });

  it("nunca baja de una unidad por más que se reste", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.click(screen.getByLabelText("Restar una unidad de Carburador PZ27"));
    await user.click(screen.getByLabelText("Restar una unidad de Carburador PZ27"));

    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");
    await elegirMétodoDePago(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(itemsSentToClose()[0]).toMatchObject({ quantity: 1 });
  });

  // Antes la tasa salía de la primera cotización, así que una venta armada
  // solo con repuestos del inventario se guardaba con tasa 0 y el monto
  // dejaba de ser trazable.
  it("guarda la venta con la tasa del BCV vigente, aunque no haya cotizaciones", async () => {
    fetchConversationQuotes.mockResolvedValueOnce([]);
    const user = crearUsuario();
    renderModal();

    await user.type(screen.getByLabelText("Buscar repuesto en el inventario"), "bujía");
    await waitFor(() => expect(screen.getByText("Bujía CR7HSA")).toBeInTheDocument());
    await user.click(screen.getByText("Bujía CR7HSA"));

    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");
    await elegirMétodoDePago(user);
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(closeSaleWithContactInfo.mock.calls[0][6]).toBe(40);
  });

  // El método de pago quedaba en el comprobante, es decir, en una imagen que
  // hay que abrir una por una para saber con qué pagó cada cliente.
  it("no deja cerrar la venta sin decir con qué se pagó", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");

    expect(submitButton()).toBeDisabled();
  });

  it("no elige un método por defecto: la mitad de las ventas quedarían mal registradas", async () => {
    renderModal();
    await waitForQuotes();

    expect(screen.getByLabelText("Método de pago")).toHaveValue("");
  });

  it("manda el método elegido junto con el resto de los datos del cliente", async () => {
    const user = crearUsuario();
    renderModal();
    await waitForQuotes();

    await user.click(screen.getByText("Carburador PZ27"));
    await user.type(screen.getByLabelText("Nombre"), "Cliente Demo");
    await elegirMétodoDePago(user, "zelle");
    await user.click(submitButton());

    await waitFor(() => expect(closeSaleWithContactInfo).toHaveBeenCalledTimes(1));
    expect(closeSaleWithContactInfo.mock.calls[0][4]).toMatchObject({ paymentMethod: "zelle" });
  });

  // Quien cierra tiene que ver a nombre de quién queda antes de confirmar,
  // pero no puede cambiarlo: sale de la sesión, no de un campo.
  it("muestra quién cierra la venta y no deja editarlo", async () => {
    renderModal();
    await waitForQuotes();

    const campo = screen.getByLabelText("Cierra la venta");
    expect(campo).toHaveValue(AGENT.displayName);
    expect(campo).toBeDisabled();
  });
});
