/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextPanel } from "@/components/context-panel/context-panel";
import type { Agent, Conversation, ConversationCartItem, Product, Tag } from "@/lib/types";
import type { BcvRateSummary } from "@/components/inbox/bcv-rate-chip";

/**
 * T6, plan "El mostrador busca sin salir del chat" (27/9/2026, D4/D5).
 *
 * Hasta esta corrida el panel pintaba, debajo de las etiquetas aplicadas,
 * una segunda lista con TODAS las etiquetas disponibles como botones "+" —
 * eso era lo que le quitaba el espacio a la búsqueda de inventario que pide
 * el dueño. `ManageTagsModal` se mockea entero: sus propios tests (T6,
 * `manage-tags-modal.test.tsx`) cubren aplicar/quitar de verdad: acá solo
 * importa que `ContextPanel` YA NO ofrezca esa acción por su cuenta y que le
 * pase al modal lo que necesita para hacerlo.
 */

const manageTagsModalProps = vi.fn();
vi.mock("@/components/context-panel/manage-tags-modal", () => ({
  ManageTagsModal: (props: unknown) => {
    manageTagsModalProps(props);
    return null;
  },
}));

const closeSaleModalProps = vi.fn();
vi.mock("@/components/context-panel/close-sale-modal", () => ({
  CloseSaleModal: (props: unknown) => {
    closeSaleModalProps(props);
    return null;
  },
}));

const inventoryLookupProps = vi.fn();
vi.mock("@/components/context-panel/inventory-lookup", () => ({
  InventoryLookup: (props: unknown) => {
    inventoryLookupProps(props);
    return <div data-testid="inventory-lookup-stub" />;
  },
}));

const removeTagFromContactMock = vi.fn().mockResolvedValue(undefined);
const addToCartMock = vi.fn().mockResolvedValue(undefined);
const setCartQuantityMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/mutations", () => ({
  addNote: vi.fn(),
  addTagToContact: vi.fn(),
  deleteNote: vi.fn(),
  removeTagFromContact: (...args: unknown[]) => removeTagFromContactMock(...args),
  updateNote: vi.fn(),
  // T8 (28/9/2026): el carrito de la conversación.
  addToCart: (...args: unknown[]) => addToCartMock(...args),
  addQuotesToCart: vi.fn(),
  setCartQuantity: (...args: unknown[]) => setCartQuantityMock(...args),
  removeFromCart: vi.fn(),
}));

vi.mock("@/lib/data", () => ({ fetchConversationQuotes: vi.fn().mockResolvedValue([]) }));

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn(() => ({})) }));

function buildConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    contact: {
      id: "contact-1",
      phoneNumber: "+58123456789",
      displayName: "Cliente de Prueba",
      profileName: "Cliente",
      avatarUrl: null,
      cedulaType: null,
      cedulaNumber: null,
      state: null,
      city: null,
      address: null,
      tags: [{ id: "tag-1", label: "VIP", color: "accent" }],
    },
    channel: {
      id: "channel-1",
      label: "Principal",
      phoneNumber: "+58000000000",
      phoneNumberId: "phone-id-1",
      status: "connected",
    },
    status: "open",
    unreadCount: 0,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: false,
    dealStatus: "none",
    dealClosedAt: null,
    dealPaymentProofUrl: null,
    dealAmount: null,
    dealCurrency: null,
    dealVerified: false,
    dealVerifiedAt: null,
    dealVerifiedBy: null,
    dealPaymentMethod: null,
    dealClosedBy: null,
    lastCustomerMessageAt: new Date().toISOString(),
    lastReplyAt: null,
    lastReplySender: null,
    hasReply: false,
    lastMessageAt: new Date().toISOString(),
    lastMessagePreview: null,
    lastMessageDirection: null,
    lastMessageStatus: null,
    createdAt: new Date().toISOString(),
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    referral: null,
    ...overrides,
  };
}

const ALL_TAGS: Tag[] = [
  { id: "tag-1", label: "VIP", color: "accent" },
  { id: "tag-2", label: "Mayorista", color: "success" },
  { id: "tag-3", label: "Moroso", color: "danger" },
];

const AGENT: Agent = {
  id: "agent-1",
  displayName: "José",
  fullName: "José Riera",
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

const RATE: BcvRateSummary = { rate: 40, rateDate: "2026-09-27", isStale: false };

beforeEach(() => {
  manageTagsModalProps.mockClear();
  inventoryLookupProps.mockClear();
  removeTagFromContactMock.mockClear();
  closeSaleModalProps.mockClear();
  addToCartMock.mockClear();
  setCartQuantityMock.mockClear();
});

const PRODUCTO: Product = {
  id: "prod-1",
  name: "Bujía CR7HSA",
  brand: "NGK",
  price: 3.25,
  currency: "USD",
  stockQuantity: 10,
  description: null,
  isActive: true,
  updatedAt: "2026-09-29T00:00:00.000Z",
  compatibility: [],
  weightKg: null,
  saintCode: null,
  saintAddedAt: null,
  saintRemovedAt: null,
};

const RENGLON: ConversationCartItem = {
  id: "cart-1",
  conversationId: "conv-1",
  productId: "prod-1",
  quantity: 2,
  origin: "inventory",
  quoteId: null,
  quotedPriceUsd: null,
  addedBy: "agent-1",
  createdAt: "2026-09-29T10:00:00.000Z",
  updatedAt: "2026-09-29T10:00:00.000Z",
  product: PRODUCTO,
};

function renderPanel(
  overrides: Partial<Conversation> = {},
  onContactTagsChanged?: () => void,
  cart: ConversationCartItem[] = [],
  onCartChanged: () => void = () => {}
) {
  const conversation = buildConversation(overrides);
  return render(
    <ContextPanel
      conversation={conversation}
      messages={[]}
      notes={[]}
      allTags={ALL_TAGS}
      currentAgent={AGENT}
      bcvRate={RATE}
      cart={cart}
      onCartChanged={onCartChanged}
      onContactTagsChanged={onContactTagsChanged}
    />
  );
}

describe("ContextPanel — etiquetas recogidas e Inventario en su lugar (D4/D5)", () => {
  it("sigue mostrando las etiquetas ya aplicadas, con su botón de quitar", () => {
    renderPanel();
    expect(screen.getByText("VIP")).toBeInTheDocument();
    expect(screen.getByLabelText("Quitar etiqueta VIP")).toBeInTheDocument();
  });

  it("ya no ofrece botones para aplicar una etiqueta disponible", () => {
    renderPanel();
    // "Mayorista" y "Moroso" están disponibles (el contacto no las lleva) —
    // antes salían como botones "+ Mayorista"/"+ Moroso"; ahora no deben
    // aparecer en ningún lado del panel.
    expect(screen.queryByText("Mayorista")).not.toBeInTheDocument();
    expect(screen.queryByText("Moroso")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\+ Mayorista/i })).not.toBeInTheDocument();
  });

  it("Gestionar sigue abriendo el modal, que recibe el contacto y sus etiquetas", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderPanel();

    await user.click(screen.getByRole("button", { name: /gestionar/i }));

    expect(manageTagsModalProps).toHaveBeenCalled();
    const lastCall = manageTagsModalProps.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({
      isOpen: true,
      contactId: "contact-1",
      tags: ALL_TAGS,
    });
    expect(lastCall.contactTags).toEqual([{ id: "tag-1", label: "VIP", color: "accent" }]);
  });

  it("pinta la sección Inventario (el stub) entre Etiquetas y Notas internas, con la tasa BCV", () => {
    renderPanel();

    expect(inventoryLookupProps).toHaveBeenCalledWith(expect.objectContaining({ bcvRate: RATE }));

    // `InventoryLookup` va mockeado (su propio orden interno lo prueba
    // `inventory-lookup.test.tsx`): acá solo importa DÓNDE lo monta
    // `ContextPanel` respecto a las otras dos secciones — se compara la
    // posición real en el DOM, no una lista de `.lm-eyebrow` (el stub no
    // pinta ninguno).
    const etiquetas = screen.getByText("Etiquetas");
    const inventoryStub = screen.getByTestId("inventory-lookup-stub");
    const notas = screen.getByText("Notas internas");

    // Node.DOCUMENT_POSITION_FOLLOWING (4): el segundo argumento va DESPUÉS del primero.
    expect(etiquetas.compareDocumentPosition(inventoryStub) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(inventoryStub.compareDocumentPosition(notas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

/**
 * Hallazgo 1, `code-review high` sobre d38a7e1..HEAD (27/9/2026): el canal
 * `contact-tags-<id>` filtrado por `contact_id` no entrega DELETE filtrados
 * (Realtime no manda el registro viejo completo salvo `REPLICA IDENTITY
 * FULL`), así que la propia acción del asesor no puede depender de ese canal
 * para verse reflejada — necesita avisar de una vez, con su propio callback.
 */
describe("ContextPanel — quitar una etiqueta avisa al shell (hallazgo 1)", () => {
  it("el × de 'Etiquetas' llama a onContactTagsChanged tras quitar con éxito", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onContactTagsChanged = vi.fn();
    renderPanel({}, onContactTagsChanged);

    await user.click(screen.getByLabelText("Quitar etiqueta VIP"));

    await waitFor(() => expect(removeTagFromContactMock).toHaveBeenCalledTimes(1));
    expect(onContactTagsChanged).toHaveBeenCalledTimes(1);
  });

  it("un fallo al quitar NO llama a onContactTagsChanged", async () => {
    removeTagFromContactMock.mockRejectedValueOnce(new Error("fail"));
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onContactTagsChanged = vi.fn();
    renderPanel({}, onContactTagsChanged);

    await user.click(screen.getByLabelText("Quitar etiqueta VIP"));

    await waitFor(() => expect(removeTagFromContactMock).toHaveBeenCalledTimes(1));
    expect(onContactTagsChanged).not.toHaveBeenCalled();
  });

  it("ManageTagsModal recibe el mismo onContactTagsChanged para 'En este chat'", () => {
    const onContactTagsChanged = vi.fn();
    renderPanel({}, onContactTagsChanged);

    const lastCall = manageTagsModalProps.mock.calls.at(-1)?.[0];
    expect(lastCall.onContactTagsChanged).toBe(onContactTagsChanged);
  });
});

/**
 * T8, plan "Seba encuentra, no insiste, y el mostrador no deja a nadie
 * esperando" (28/9/2026): el carrito vive en la conversación. El panel pinta
 * «Lo que lleva el cliente» entre la búsqueda y las notas, la búsqueda ofrece
 * «Agregar», y el modal de cierre recibe el MISMO carrito.
 */
describe("ContextPanel — el carrito de la conversación (T8)", () => {
  it("pinta «Lo que lleva el cliente» entre la búsqueda de inventario y las Notas internas", () => {
    renderPanel();

    const inventoryStub = screen.getByTestId("inventory-lookup-stub");
    const carrito = screen.getByText("Lo que lleva el cliente");
    const notas = screen.getByText("Notas internas");

    expect(inventoryStub.compareDocumentPosition(carrito) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(carrito.compareDocumentPosition(notas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("muestra los renglones del carrito que le llegan por props, con su precio vigente", () => {
    renderPanel({}, undefined, [RENGLON]);

    expect(screen.getByText("Bujía CR7HSA")).toBeInTheDocument();
    // 2 x $3.25 = $6.50
    expect(screen.getByTestId("cart-total")).toHaveTextContent("$6.50");
  });

  it("el «Agregar» de la búsqueda escribe en el carrito de ESTA conversación y refresca", async () => {
    const onCartChanged = vi.fn();
    renderPanel({}, undefined, [], onCartChanged);

    const props = inventoryLookupProps.mock.calls.at(-1)?.[0] as { onAdd: (p: Product) => void };
    expect(typeof props.onAdd).toBe("function");
    props.onAdd(PRODUCTO);

    await waitFor(() => expect(addToCartMock).toHaveBeenCalledTimes(1));
    expect(addToCartMock.mock.calls[0][1]).toEqual({
      conversationId: "conv-1",
      productId: "prod-1",
      quantity: 1,
      origin: "inventory",
    });
    await waitFor(() => expect(onCartChanged).toHaveBeenCalled());
  });

  it("cambiar la cantidad de un renglón escribe en la base", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderPanel({}, undefined, [RENGLON]);

    await user.click(screen.getByRole("button", { name: "Agregar una unidad de Bujía CR7HSA" }));

    await waitFor(() => expect(setCartQuantityMock).toHaveBeenCalledTimes(1));
    expect(setCartQuantityMock.mock.calls[0].slice(1)).toEqual(["cart-1", 3]);
  });

  it("el modal de cierre recibe el mismo carrito y el mismo aviso de cambio", () => {
    const onCartChanged = vi.fn();
    renderPanel({}, undefined, [RENGLON], onCartChanged);

    const props = closeSaleModalProps.mock.calls.at(-1)?.[0];
    expect(props.cart).toEqual([RENGLON]);
    expect(props.onCartChanged).toBe(onCartChanged);
    expect(props.conversationId).toBe("conv-1");
  });
});
