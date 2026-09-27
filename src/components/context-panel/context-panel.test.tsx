/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextPanel } from "@/components/context-panel/context-panel";
import type { Agent, Conversation, Tag } from "@/lib/types";
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

vi.mock("@/components/context-panel/close-sale-modal", () => ({
  CloseSaleModal: () => null,
}));

const inventoryLookupProps = vi.fn();
vi.mock("@/components/context-panel/inventory-lookup", () => ({
  InventoryLookup: (props: unknown) => {
    inventoryLookupProps(props);
    return <div data-testid="inventory-lookup-stub" />;
  },
}));

vi.mock("@/lib/mutations", () => ({
  addNote: vi.fn(),
  addTagToContact: vi.fn(),
  deleteNote: vi.fn(),
  removeTagFromContact: vi.fn(),
  updateNote: vi.fn(),
}));

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
});

function renderPanel(overrides: Partial<Conversation> = {}) {
  const conversation = buildConversation(overrides);
  return render(
    <ContextPanel
      conversation={conversation}
      messages={[]}
      notes={[]}
      allTags={ALL_TAGS}
      currentAgent={AGENT}
      bcvRate={RATE}
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
