/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Agent, ConversationSummary, Tag } from "@/lib/types";

/**
 * La vista del tablero de «Casos» (T7, plan "La ronda del cliente",
 * 30/9/2026). Lo que se prueba acá es el contrato del arrastre: soltar una
 * tarjeta PONE la etiqueta de destino ANTES de quitar la de origen (así un
 * fallo a mitad de camino nunca deja al contacto sin ninguna), la tarjeta se
 * mueve al instante y, si la base falla, vuelve a su columna con un aviso.
 */

const { addTagToContact, removeTagFromContact, calls, toast, refreshConversations } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    addTagToContact: vi.fn(async (_s: unknown, contactId: string, tagId: string) => {
      calls.push(`add:${contactId}:${tagId}`);
    }),
    removeTagFromContact: vi.fn(async (_s: unknown, contactId: string, tagId: string) => {
      calls.push(`remove:${contactId}:${tagId}`);
    }),
    toast: Object.assign(vi.fn(), { success: vi.fn(), danger: vi.fn(), info: vi.fn(), warning: vi.fn() }),
    refreshConversations: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/mutations", () => ({ addTagToContact, removeTagFromContact }));

vi.mock("@/lib/data", () => ({
  fetchCaseBoard: vi.fn(async () => ({ conversations: [], truncated: false })),
  fetchConversationRow: vi.fn(async () => null),
  fetchTags: vi.fn(async () => []),
}));

vi.mock("@/lib/supabase/client", () => {
  const channel = { on: () => channel, subscribe: () => channel };
  return { createClient: () => ({ channel: () => channel, removeChannel: vi.fn() }) };
});

// El hook real abre realtime; acá alcanza con el estado que devuelve y con
// `setConversations`, que es por donde pasa la actualización optimista.
vi.mock("@/lib/use-live-conversations", async () => {
  const React = await import("react");
  return {
    useLiveConversations: (_supabase: unknown, initial: ConversationSummary[]) => {
      const [conversations, setConversations] = React.useState(initial);
      return { conversations, setConversations, refreshConversations };
    },
  };
});

// El rail se prueba en app-rail.test.tsx; acá solo estorba (router, sesión).
vi.mock("@/components/app-rail", () => ({
  AppRail: () => <nav aria-label="Secciones" />,
  AppTopNav: () => <nav aria-label="Navegación principal" />,
}));

vi.mock("@heroui/react", () => ({ toast }));

import { CaseBoardView } from "@/components/casos/case-board-view";

const TAGS: Tag[] = [
  { id: "t-reclamo", label: "Reclamo", color: "danger" },
  { id: "t-cashea", label: "Cashea", color: "success" },
];

const AGENT: Agent = {
  id: "ana",
  displayName: "Ana",
  fullName: null,
  avatarUrl: null,
  role: "agent",
  isActive: true,
};

function conv(id: string, name: string, tags: Tag[], phone = "+584141234567"): ConversationSummary {
  return {
    id,
    contact: { id: `c-${id}`, phoneNumber: phone, displayName: name, profileName: null, avatarUrl: null, tags },
    status: "open",
    unreadCount: 2,
    manuallyUnread: false,
    assignedAgent: null,
    aiEnabled: true,
    dealStatus: "none",
    dealVerified: false,
    lastCustomerMessageAt: null,
    lastMessageAt: "2026-09-30T14:00:00Z",
    lastReplyAt: "2026-09-30T14:00:00Z",
    lastReplySender: "ai",
    hasReply: true,
    createdAt: "2026-09-29T10:00:00Z",
    journeyStage: null,
    intent: null,
    activeTool: null,
    welcomeSentAt: null,
    lastMessagePreview: "¿Tienen el asiento de la SBR?",
    lastMessageDirection: "inbound",
    lastMessageStatus: null,
  };
}

function renderBoard(opts: { conversations?: ConversationSummary[]; truncated?: boolean } = {}) {
  const conversations = opts.conversations ?? [
    conv("a", "José Pérez", [TAGS[0]]),
    conv("b", "María Gómez", [], "+584249998877"),
  ];
  return render(
    <CaseBoardView
      currentAgent={AGENT}
      initialConversations={conversations}
      truncated={opts.truncated ?? false}
      tags={TAGS}
      agents={[AGENT]}
    />
  );
}

function column(label: string) {
  return screen.getByRole("region", { name: new RegExp(`^${label}`) });
}

/** Un `DataTransfer` mínimo: jsdom no trae uno propio. */
function fakeDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "all",
    dropEffect: "none",
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
    clearData: () => store.clear(),
  };
}

function drag(from: HTMLElement, to: HTMLElement) {
  const dataTransfer = fakeDataTransfer();
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragEnter(to, { dataTransfer });
  fireEvent.dragOver(to, { dataTransfer });
  fireEvent.drop(to, { dataTransfer });
  fireEvent.dragEnd(from, { dataTransfer });
}

function card(inColumn: string, name: string) {
  return within(column(inColumn)).getByText(name).closest("[draggable='true']") as HTMLElement;
}

beforeEach(() => {
  calls.length = 0;
  addTagToContact.mockClear();
  removeTagFromContact.mockClear();
  toast.success.mockClear();
  toast.danger.mockClear();
  refreshConversations.mockClear();
});

describe("CaseBoardView", () => {
  it("pinta una columna por etiqueta, «Sin etiqueta» al final, con sus conteos", () => {
    renderBoard();

    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("data-column-id"));
    expect(regions).toEqual(["t-cashea", "t-reclamo", "sin-etiqueta"]);
    expect(within(column("Reclamo")).getByText("José Pérez")).toBeTruthy();
    expect(within(column("Sin etiqueta")).getByText("María Gómez")).toBeTruthy();
    expect(column("Reclamo").querySelector(".cb-column-count")?.textContent).toBe("1");
    expect(column("Cashea").querySelector(".cb-column-count")?.textContent).toBe("0");
    expect(within(column("Cashea")).getByText("Arrastra aquí un chat")).toBeTruthy();
    expect(screen.getByText(/2 chats abiertos/)).toBeTruthy();
  });

  it("la tarjeta lleva al chat en la bandeja", () => {
    renderBoard();
    const link = within(column("Reclamo")).getByRole("link", { name: /José Pérez/ });
    expect(link.getAttribute("href")).toBe("/inbox?conversation=a");
  });

  it("soltar en otra columna PONE la de destino y DESPUÉS quita la de origen, y la tarjeta cambia de columna", async () => {
    renderBoard();

    drag(card("Reclamo", "José Pérez"), column("Cashea"));

    await waitFor(() => expect(calls).toEqual(["add:c-a:t-cashea", "remove:c-a:t-reclamo"]));
    expect(within(column("Cashea")).getByText("José Pérez")).toBeTruthy();
    expect(within(column("Reclamo")).queryByText("José Pérez")).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Movido a Cashea");
  });

  it("desde «Sin etiqueta» solo pone la etiqueta", async () => {
    renderBoard();

    drag(card("Sin etiqueta", "María Gómez"), column("Reclamo"));

    await waitFor(() => expect(calls).toEqual(["add:c-b:t-reclamo"]));
    expect(removeTagFromContact).not.toHaveBeenCalled();
    expect(within(column("Reclamo")).getByText("María Gómez")).toBeTruthy();
  });

  it("si la base falla, la tarjeta vuelve a su columna y avisa", async () => {
    addTagToContact.mockRejectedValueOnce(new Error("sin red"));
    renderBoard();

    drag(card("Reclamo", "José Pérez"), column("Cashea"));

    await waitFor(() => expect(toast.danger).toHaveBeenCalled());
    expect(removeTagFromContact).not.toHaveBeenCalled();
    expect(within(column("Reclamo")).getByText("José Pérez")).toBeTruthy();
    expect(within(column("Cashea")).queryByText("José Pérez")).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("si falla al quitar la de origen también vuelve atrás y avisa", async () => {
    removeTagFromContact.mockRejectedValueOnce(new Error("sin red"));
    renderBoard();

    drag(card("Reclamo", "José Pérez"), column("Cashea"));

    await waitFor(() => expect(toast.danger).toHaveBeenCalled());
    expect(within(column("Reclamo")).getByText("José Pérez")).toBeTruthy();
    // Poner la de destino sí pudo haber llegado a la base: se vuelve a leer
    // la verdad en vez de suponer.
    expect(refreshConversations).toHaveBeenCalled();
  });

  it("soltar en la misma columna no toca la base", async () => {
    renderBoard();

    drag(card("Reclamo", "José Pérez"), column("Reclamo"));

    await act(async () => {});
    expect(addTagToContact).not.toHaveBeenCalled();
    expect(removeTagFromContact).not.toHaveBeenCalled();
  });

  it("«Mover a…» aplica las mismas reglas que el arrastre", async () => {
    renderBoard();

    fireEvent.click(within(column("Reclamo")).getByRole("button", { name: "Mover a…" }));
    const menu = screen.getByRole("menu");
    // La columna en la que ya está no se ofrece.
    expect(within(menu).queryByRole("menuitem", { name: /Reclamo/ })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Cashea/ }));

    await waitFor(() => expect(calls).toEqual(["add:c-a:t-cashea", "remove:c-a:t-reclamo"]));
    expect(within(column("Cashea")).getByText("José Pérez")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("«Mover a…» se cierra con Escape sin mover nada", () => {
    renderBoard();

    fireEvent.click(within(column("Reclamo")).getByRole("button", { name: "Mover a…" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(addTagToContact).not.toHaveBeenCalled();
  });

  it("la búsqueda filtra por nombre sin acentos y por teléfono", () => {
    renderBoard();
    const search = screen.getByRole("searchbox", { name: /Buscar/ });

    fireEvent.change(search, { target: { value: "jose" } });
    expect(screen.queryByText("María Gómez")).toBeNull();
    expect(screen.getByText("José Pérez")).toBeTruthy();

    fireEvent.change(search, { target: { value: "0424 999" } });
    expect(screen.queryByText("José Pérez")).toBeNull();
    expect(screen.getByText("María Gómez")).toBeTruthy();

    fireEvent.change(search, { target: { value: "nadie así" } });
    expect(screen.getByText(/Ningún chat abierto coincide/)).toBeTruthy();
  });

  it("filtra por asesor y por «Sin asesor»", () => {
    const conAna = { ...conv("a", "José Pérez", [TAGS[0]]), assignedAgent: { id: "ana", displayName: "Ana" } };
    renderBoard({ conversations: [conAna, conv("b", "María Gómez", [])] });
    const select = screen.getByRole("combobox", { name: /asesor/i });

    fireEvent.change(select, { target: { value: "none" } });
    expect(screen.queryByText("José Pérez")).toBeNull();
    expect(screen.getByText("María Gómez")).toBeTruthy();

    fireEvent.change(select, { target: { value: "ana" } });
    expect(screen.getByText("José Pérez")).toBeTruthy();
    expect(screen.queryByText("María Gómez")).toBeNull();
  });

  it("los chats que se cierran salen del tablero; los `pending` se quedan (abierto = no cerrado)", () => {
    const cerrado = { ...conv("z", "Cerrado", []), status: "closed" as const };
    const pendiente = { ...conv("p", "Pendiente", []), status: "pending" as const };
    renderBoard({ conversations: [cerrado, pendiente, conv("b", "María Gómez", [])] });
    expect(screen.queryByText("Cerrado")).toBeNull();
    expect(screen.getByText("Pendiente")).toBeTruthy();
    expect(screen.getByText(/2 chats abiertos/)).toBeTruthy();
  });

  it("avisa cuando el tablero no trae todos los chats abiertos", () => {
    renderBoard({ truncated: true });
    expect(screen.getByText(/Mostrando los 500 chats abiertos más recientes/)).toBeTruthy();
  });

  it("sin corte no hay aviso", () => {
    renderBoard();
    expect(screen.queryByText(/Mostrando los 500/)).toBeNull();
  });
});
