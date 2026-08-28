/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import type { Agent, Conversation, Tag } from "@/lib/types";
import { fetchConversations } from "@/lib/data";
import { InboxSidebar } from "@/components/inbox/inbox-sidebar";

// La bandeja abre un cliente de Supabase para buscar dentro de los mensajes.
// Acá no se prueba esa búsqueda —tiene sus propias pruebas en message-search—,
// solo hace falta que crearlo no explote por falta de variables de entorno.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: vi.fn().mockResolvedValue({ data: [], error: null }) }),
}));

// "Sin contestar" le pregunta a la base por el conjunto entero, no a la ventana
// cargada. Acá se controla qué contesta esa consulta.
vi.mock("@/lib/data", () => ({
  fetchConversations: vi.fn().mockResolvedValue([]),
  searchConversationSummaries: vi.fn().mockResolvedValue([]),
}));

beforeEach(() => {
  vi.mocked(fetchConversations).mockReset().mockResolvedValue([]);
});

const TAG_VIP: Tag = { id: "t-vip", label: "VIP", color: "accent" };
const TAG_MOROSO: Tag = { id: "t-moroso", label: "Moroso", color: "danger" };
const ALL_TAGS = [TAG_VIP, TAG_MOROSO];

function agent(id: string, role: Agent["role"]): Agent {
  return { id, displayName: id, fullName: null, avatarUrl: null, role, isActive: true };
}

const ANA = agent("ana", "agent");
const JEFA = agent("jefa", "admin");

function conversation(over: {
  id: string;
  unreadCount?: number;
  manuallyUnread?: boolean;
  assignedAgent?: Agent | null;
  lastCustomerMessageAt?: string | null;
  hasReply?: boolean;
  status?: Conversation["status"];
  tags?: Tag[];
}): Conversation {
  return {
    id: over.id,
    status: over.status ?? "open",
    lastCustomerMessageAt: over.lastCustomerMessageAt ?? null,
    hasReply: over.hasReply ?? false,
    contact: {
      id: `c-${over.id}`,
      phoneNumber: "+58 412 000 0000",
      displayName: over.id,
      profileName: null,
      avatarUrl: null,
      cedulaType: null,
      cedulaNumber: null,
      state: null,
      city: null,
      address: null,
      tags: over.tags ?? [],
    },
    unreadCount: over.unreadCount ?? 0,
    manuallyUnread: over.manuallyUnread ?? false,
    assignedAgent: over.assignedAgent ?? null,
    aiEnabled: true,
    lastMessageAt: "2026-08-22T10:00:00Z",
    lastMessagePreview: "hola",
    lastMessageDirection: "inbound",
    lastMessageStatus: null,
  } as unknown as Conversation;
}

/**
 * El helper fija `lastMessageAt` en esta fecha. Pasar la misma como último
 * mensaje del cliente es decir "el último mensaje del hilo es suyo": nadie
 * contestó.
 */
const ESPERANDO = "2026-08-22T10:00:00Z";

const CONVERSATIONS = [
  conversation({ id: "sin-duena", unreadCount: 2, tags: [TAG_VIP] }),
  conversation({
    id: "de-ana",
    assignedAgent: ANA,
    tags: [TAG_MOROSO],
    lastCustomerMessageAt: ESPERANDO,
  }),
  conversation({ id: "de-ana-sin-leer", assignedAgent: ANA, unreadCount: 1 }),
];

function renderSidebar(currentAgent: Agent) {
  return render(
    <InboxSidebar
      conversations={CONVERSATIONS}
      selectedId={null}
      onSelect={() => {}}
      currentAgent={currentAgent}
      allTags={ALL_TAGS}
      bcvRate={null}
    />
  );
}

/** Los nombres visibles de las conversaciones que quedaron en la lista. */
function visibleIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".crm-thread-name")).map(
    (el) => el.textContent ?? ""
  );
}

/**
 * SlidingPills duplica la fila de botones para animar el recorte de la
 * píldora activa, así que cada etiqueta aparece dos veces en el DOM. Lo que
 * importa acá es si está o no, no cuántas copias hay.
 */
function pillLabels(): string[] {
  const filtros = screen.getByRole("group", { name: "Filtrar conversaciones" });
  const vistos = new Set<string>();
  for (const button of within(filtros).getAllByRole("button", { hidden: true })) {
    if (button.textContent) vistos.add(button.textContent);
  }
  return [...vistos];
}

describe("InboxSidebar — qué filtros ve cada rol", () => {
  it("al administrador le ofrece los cortes de toda la bandeja", () => {
    renderSidebar(JEFA);
    expect(pillLabels()).toEqual([
      "Todos",
      "Sin contestar",
      "Sin leer",
      "Sin asignar",
      "Asignados",
    ]);
  });

  it("al asesor le ofrece lo suyo y el trabajo libre, sin los cortes de administración", () => {
    renderSidebar(ANA);
    expect(pillLabels()).toEqual(["Todos", "Sin contestar", "Míos", "Míos sin leer"]);
  });
});

/**
 * El punto entero del filtro: encontrar el chat libre que nadie contestó,
 * esté o no en las 30 filas que la bandeja tiene cargadas. Filtrar en memoria
 * escondería justo al que se busca — el viejo, el que lleva días esperando.
 */
describe("InboxSidebar — 'Sin contestar' sale a buscar a la base", () => {
  function elegirSinContestar() {
    const filtros = screen.getByRole("group", { name: "Filtrar conversaciones" });
    fireEvent.click(within(filtros).getAllByRole("button", { name: "Sin contestar" })[0]);
  }

  it("trae el chat libre sin contestar que no estaba en la ventana cargada", async () => {
    const viejo = conversation({ id: "olvidado", lastCustomerMessageAt: ESPERANDO });
    vi.mocked(fetchConversations).mockResolvedValue([viejo]);

    const { container } = renderSidebar(JEFA);
    elegirSinContestar();

    await waitFor(() => expect(visibleIds(container)).toEqual(["olvidado"]));
    expect(fetchConversations).toHaveBeenCalledWith(expect.anything(), {
      activeOnly: true,
      unassignedOnly: true,
      awaitingReplyOnly: true,
    });
  });

  /**
   * `hasReply` es un flag vitalicio (lo enciende la IA, el asesor o hasta la
   * plantilla de bienvenida automática, y nunca se apaga) que el backfill dejó
   * encendido en casi todo el histórico. Antes se sumaba `neverRepliedOnly` a
   * la consulta para no repetir acá el chat que un asesor ya había atendido a
   * mano, pero eso vació la píldora en producción el 28/8/2026: el chat que la
   * IA contestó hace días y al que el cliente volvió a escribir —trabajo
   * pendiente de verdad— quedaba oculto para siempre. Lo que importa es que
   * el último mensaje del hilo vuelva a ser del cliente, no si alguna vez
   * hubo respuesta.
   */
  it("muestra el hilo que trae la consulta aunque el cliente ya haya recibido respuesta antes", async () => {
    const vuelveAEscribir = conversation({
      id: "responde-de-nuevo",
      hasReply: true,
      lastCustomerMessageAt: ESPERANDO,
    });
    vi.mocked(fetchConversations).mockResolvedValue([vuelveAEscribir]);

    const { container } = renderSidebar(JEFA);
    elegirSinContestar();

    await waitFor(() => expect(visibleIds(container)).toEqual(["responde-de-nuevo"]));
  });

  it("no consulta mientras el filtro no está elegido", () => {
    renderSidebar(JEFA);
    expect(fetchConversations).not.toHaveBeenCalled();
  });

  /**
   * Lo que llega de la base es una foto; lo cargado está vivo por realtime. Si
   * alguien toma el chat mientras la lista está abierta, la fila viva manda y
   * la conversación sale del filtro sola.
   */
  it("la fila cargada le gana a la que trajo la consulta", async () => {
    // La base la devolvió libre, pero para cuando llegó la respuesta Ana ya la
    // había tomado y realtime actualizó la fila cargada. Manda esa: si ganara
    // la foto de la base, "de-ana" aparecería en la lista.
    const fotoVieja = conversation({ id: "de-ana", lastCustomerMessageAt: ESPERANDO });
    vi.mocked(fetchConversations).mockResolvedValue([fotoVieja]);

    const { container } = renderSidebar(JEFA);
    elegirSinContestar();

    await waitFor(() => expect(fetchConversations).toHaveBeenCalled());
    expect(visibleIds(container)).toEqual([]);
  });

  /** Con el conjunto entero ya en pantalla, ofrecer "cargar más" es mentir. */
  it("no ofrece cargar más: la consulta ya trajo todo lo que hay", async () => {
    vi.mocked(fetchConversations).mockResolvedValue([
      conversation({ id: "olvidado", lastCustomerMessageAt: ESPERANDO }),
    ]);

    render(
      <InboxSidebar
        conversations={CONVERSATIONS}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        hasMore
        onLoadMore={() => {}}
      />
    );

    expect(screen.getByRole("button", { name: /cargar más/i })).toBeTruthy();
    elegirSinContestar();

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /cargar más/i })).toBeNull()
    );
  });
});

/** El filtro por categoría vive en un menú: abrirlo es parte del gesto. */
function abrirMenúDeCategorías(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /categoría/i }));
  return screen.getByRole("menu", { name: "Filtrar por categoría" });
}

describe("InboxSidebar — filtrar por categoría", () => {
  it("solo ofrece las categorías que alguna conversación está usando", () => {
    render(
      <InboxSidebar
        conversations={[conversation({ id: "sola", tags: [TAG_VIP] })]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );

    const menú = abrirMenúDeCategorías();
    expect(within(menú).getByText("VIP")).toBeTruthy();
    expect(within(menú).queryByText("Moroso")).toBeNull();
  });

  it("al elegir una categoría deja solo las conversaciones que la llevan", () => {
    const { container } = renderSidebar(JEFA);

    fireEvent.click(within(abrirMenúDeCategorías()).getByText("VIP"));

    expect(visibleIds(container)).toEqual(["sin-duena"]);
  });

  it("elegir de nuevo la categoría activa quita el filtro", () => {
    const { container } = renderSidebar(JEFA);

    fireEvent.click(within(abrirMenúDeCategorías()).getByText("VIP"));
    fireEvent.click(within(abrirMenúDeCategorías()).getByText("VIP"));

    expect(visibleIds(container)).toHaveLength(3);
  });

  it("el menú se cierra al elegir, para no tapar la lista que acaba de filtrar", () => {
    renderSidebar(JEFA);

    fireEvent.click(within(abrirMenúDeCategorías()).getByText("VIP"));

    expect(screen.queryByRole("menu", { name: "Filtrar por categoría" })).toBeNull();
  });

  it("sin categorías en uso no ofrece el botón: un menú vacío no filtra nada", () => {
    render(
      <InboxSidebar
        conversations={[conversation({ id: "pelada" })]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );

    expect(screen.queryByRole("button", { name: /categoría/i })).toBeNull();
  });
});

describe("InboxSidebar — orden", () => {
  it("el botón de orden alterna entre más recientes y más viejos", () => {
    renderSidebar(JEFA);

    // Arranca en "más recientes": el botón ofrece cambiar a lo viejo.
    const botón = screen.getByRole("button", { name: "Ordenar: Más viejos primero" });
    fireEvent.click(botón);

    expect(screen.getByRole("button", { name: "Ordenar: Más recientes primero" })).toBeTruthy();
  });
});

/** El hilo entero: click derecho sobre un chat, elegir la acción, y que llegue. */
describe("apartar un chat desde el menú de la bandeja", () => {
  function renderWithMenu(over: { onMarkUnread?: (id: string) => void; onMarkRead?: (id: string) => void } = {}) {
    const onMarkUnread = vi.fn();
    const onMarkRead = vi.fn();
    render(
      <InboxSidebar
        conversations={[
          conversation({ id: "leido" }),
          conversation({ id: "apartado", manuallyUnread: true }),
        ]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        onMarkUnread={over.onMarkUnread ?? onMarkUnread}
        onMarkRead={over.onMarkRead ?? onMarkRead}
      />
    );
    return { onMarkUnread, onMarkRead };
  }

  function threadNamed(id: string): HTMLElement {
    return screen.getByText(id).closest("button") as HTMLElement;
  }

  it("no hay ningún menú abierto hasta que alguien lo pide", () => {
    renderWithMenu();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("el click derecho sobre un chat leído ofrece apartarlo, y apartarlo llega con su id", () => {
    const { onMarkUnread } = renderWithMenu();

    fireEvent.contextMenu(threadNamed("leido"));
    fireEvent.click(screen.getByRole("menuitem", { name: /marcar como no leído/i }));

    expect(onMarkUnread).toHaveBeenCalledWith("leido");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("sobre un chat ya apartado, el menú ofrece lo contrario", () => {
    const { onMarkRead } = renderWithMenu();

    fireEvent.contextMenu(threadNamed("apartado"));
    fireEvent.click(screen.getByRole("menuitem", { name: /^marcar como leído$/i }));

    expect(onMarkRead).toHaveBeenCalledWith("apartado");
  });

  it("el menú se abre sobre el chat que se pidió, no sobre el anterior", () => {
    const { onMarkUnread } = renderWithMenu();

    fireEvent.contextMenu(threadNamed("leido"));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.contextMenu(threadNamed("apartado"));
    fireEvent.click(screen.getByRole("menuitem", { name: /^marcar como leído$/i }));

    expect(onMarkUnread).not.toHaveBeenCalled();
  });
});
