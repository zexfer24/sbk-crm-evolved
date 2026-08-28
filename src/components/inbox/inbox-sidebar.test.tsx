/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import type { Agent, Conversation, Tag } from "@/lib/types";
import { fetchConversations } from "@/lib/data";
import { PENDING_STALE_LIMIT } from "@/lib/inbox-sections";
import { InboxSidebar } from "@/components/inbox/inbox-sidebar";

// La bandeja abre un cliente de Supabase para buscar dentro de los mensajes.
// Acá no se prueba esa búsqueda —tiene sus propias pruebas en message-search—,
// solo hace falta que crearlo no explote por falta de variables de entorno.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: vi.fn().mockResolvedValue({ data: [], error: null }) }),
}));

// "Pendientes" le pregunta a la base por el conjunto entero (partido en la
// ventana fresca y la vieja), no a la ventana cargada. Acá se controla qué
// contesta esa consulta.
vi.mock("@/lib/data", () => ({
  fetchConversations: vi.fn().mockResolvedValue([]),
  searchConversationSummaries: vi.fn().mockResolvedValue([]),
}));

beforeEach(() => {
  vi.mocked(fetchConversations).mockReset().mockResolvedValue([]);
});

/**
 * Responde según qué ventana pidió la consulta. Sin esto, dar la misma
 * `mockResolvedValue` a las dos llamadas (fresh y stale) duplicaría cada fila
 * que se quisiera simular: en producción una conversación cae en una sola de
 * las dos ventanas, nunca en las dos.
 */
function mockPending(over: { fresh?: Conversation[]; stale?: Conversation[] } = {}) {
  vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
    if (options?.pendingWindow === "fresh") return over.fresh ?? [];
    if (options?.pendingWindow === "stale") return over.stale ?? [];
    return [];
  });
}

const TAG_VIP: Tag = { id: "t-vip", label: "VIP", color: "accent" };
const TAG_MOROSO: Tag = { id: "t-moroso", label: "Moroso", color: "danger" };
const ALL_TAGS = [TAG_VIP, TAG_MOROSO];

function agent(id: string, role: Agent["role"]): Agent {
  return { id, displayName: id, fullName: null, avatarUrl: null, role, isActive: true };
}

const ANA = agent("ana", "agent");
const JEFA = agent("jefa", "admin");

/**
 * El helper fija `lastMessageAt` en esta fecha, muy anterior a "hoy": toda
 * conversación que la use como `lastCustomerMessageAt` cae del lado
 * "Esperando +24 h" / "stale" sin ambigüedad.
 */
const ESPERANDO = "2026-08-22T10:00:00Z";

function conversation(over: {
  id: string;
  unreadCount?: number;
  manuallyUnread?: boolean;
  assignedAgent?: Agent | null;
  lastCustomerMessageAt?: string | null;
  /**
   * Por defecto igual a `lastCustomerMessageAt` (o a ESPERANDO si tampoco se
   * pidió ese): el último mensaje del hilo es del cliente, nadie contestó —
   * el caso que más se usa en este archivo. Pasar un valor posterior simula
   * que alguien ya le respondió.
   */
  lastMessageAt?: string | null;
  hasReply?: boolean;
  status?: Conversation["status"];
  tags?: Tag[];
}): Conversation {
  return {
    id: over.id,
    status: over.status ?? "open",
    lastCustomerMessageAt: over.lastCustomerMessageAt ?? null,
    lastMessageAt: "lastMessageAt" in over ? (over.lastMessageAt ?? null) : (over.lastCustomerMessageAt ?? ESPERANDO),
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
    lastMessagePreview: "hola",
    lastMessageDirection: "inbound",
    lastMessageStatus: null,
  } as unknown as Conversation;
}

const CONVERSATIONS = [
  // Sin `lastCustomerMessageAt`: `awaitingReply` falla cerrado (false), así
  // que esta conversación nunca cae en "Pendientes" pese a no tener dueño.
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

/**
 * Solo la fila "real" de SlidingPills lleva `aria-pressed` (la copia
 * decorativa no); sirve para saber cuál píldora está activa sin depender del
 * clip-path, que es puramente visual.
 */
function activePillLabel(): string | undefined {
  const filtros = screen.getByRole("group", { name: "Filtrar conversaciones" });
  const boton = within(filtros)
    .getAllByRole("button", { hidden: true })
    .find((b) => b.getAttribute("aria-pressed") === "true");
  return boton?.textContent ?? undefined;
}

function irATodos() {
  const filtros = screen.getByRole("group", { name: "Filtrar conversaciones" });
  fireEvent.click(within(filtros).getAllByRole("button", { name: "Todos" })[0]);
}

describe("InboxSidebar — qué filtros ve cada rol", () => {
  it("al administrador le ofrece las tres píldoras", () => {
    renderSidebar(JEFA);
    expect(pillLabels()).toEqual(["Pendientes", "Míos", "Todos"]);
  });

  it("al asesor le ofrece las mismas tres píldoras", () => {
    renderSidebar(ANA);
    expect(pillLabels()).toEqual(["Pendientes", "Míos", "Todos"]);
  });
});

/**
 * Los cortes viejos (por leído y por asignado) se retiraron con la reforma
 * de píldoras: "Sin leer", "Sin asignar", "Asignados" y "Míos sin leer" ya
 * no tienen botón propio — quedaron fusionados en las sub-secciones de
 * "Pendientes" y "Míos" (`inbox-sections.ts`). Este test existe para que no
 * vuelvan por descuido si alguien reintroduce uno de esos cortes sin darse
 * cuenta de que ya tiene otro lugar.
 */
describe("InboxSidebar — los cortes viejos no vuelven", () => {
  const RETIRADOS = ["Sin leer", "Sin asignar", "Asignados", "Míos sin leer"];

  it.each(RETIRADOS)("no ofrece la píldora «%s» al administrador", (nombre) => {
    renderSidebar(JEFA);
    expect(screen.queryByRole("button", { name: nombre })).toBeNull();
  });

  it.each(RETIRADOS)("no ofrece la píldora «%s» al asesor", (nombre) => {
    renderSidebar(ANA);
    expect(screen.queryByRole("button", { name: nombre })).toBeNull();
  });
});

/**
 * El punto entero del filtro: encontrar el chat pendiente esté o no en las
 * 30 filas que la bandeja tiene cargadas. Filtrar en memoria escondería
 * justo al que se busca — el viejo, el que lleva días esperando. Como
 * "Pendientes" es el filtro por defecto, la consulta sale sola al montar.
 */
describe("InboxSidebar — 'Pendientes' sale a buscar a la base", () => {
  it("consulta la base al montar, porque abre en 'Pendientes'", () => {
    renderSidebar(JEFA);
    expect(fetchConversations).toHaveBeenCalled();
  });

  it("hace dos consultas: la ventana fresca sin tope, la vieja con PENDING_STALE_LIMIT", () => {
    renderSidebar(JEFA);

    expect(fetchConversations).toHaveBeenCalledTimes(2);
    // Sin `unassignedOnly`: un chat asignado al que nadie le respondió sigue
    // siendo pendiente (ver inbox-filters.ts). Sin `neverRepliedOnly`: esa
    // opción vació la píldora en producción el 28/8/2026.
    expect(fetchConversations).toHaveBeenNthCalledWith(1, expect.anything(), {
      activeOnly: true,
      awaitingReplyOnly: true,
      pendingWindow: "fresh",
    });
    expect(fetchConversations).toHaveBeenNthCalledWith(2, expect.anything(), {
      activeOnly: true,
      awaitingReplyOnly: true,
      pendingWindow: "stale",
      limit: PENDING_STALE_LIMIT,
    });
  });

  it("trae el chat libre sin contestar que no estaba en la ventana cargada", async () => {
    const viejo = conversation({ id: "olvidado", lastCustomerMessageAt: ESPERANDO });
    mockPending({ stale: [viejo] });

    const { container } = renderSidebar(JEFA);

    await waitFor(() => expect(visibleIds(container)).toContain("olvidado"));
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
    mockPending({ stale: [vuelveAEscribir] });

    const { container } = renderSidebar(JEFA);

    await waitFor(() => expect(visibleIds(container)).toContain("responde-de-nuevo"));
  });

  /**
   * `page.tsx` resuelve las dos ventanas en el servidor y las pasa como
   * `initialPendingRows` para que la bandeja no abra con el cartel
   * "Buscando…" mientras el efecto de red (arriba) hace el mismo viaje otra
   * vez. La consulta del mock nunca resuelve en este test a propósito: si la
   * fila apareciera solo por la semilla, seguiría visible sin depender de
   * que esa promesa llegue a resolver.
   */
  it("con initialPendingRows, la fila sembrada se ve antes de que la consulta resuelva", () => {
    vi.mocked(fetchConversations).mockImplementation(() => new Promise(() => {}));

    const sembrada = conversation({ id: "sembrada", lastCustomerMessageAt: ESPERANDO });

    const { container } = render(
      <InboxSidebar
        conversations={CONVERSATIONS}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        initialPendingRows={[sembrada]}
      />
    );

    expect(visibleIds(container)).toContain("sembrada");
  });

  /**
   * Lo que llega de la base es una foto; lo cargado está vivo por realtime.
   * Antes esta divergencia se armaba con la asignación (la base decía "sin
   * dueño", lo cargado decía "de Ana"), pero esa condición ya no filtra
   * "Pendientes". La divergencia ahora es que alguien ya respondió: la fila
   * viva tiene nuestra respuesta como último mensaje del hilo —
   * `awaitingReply` da falso— aunque la foto de la base todavía la haya
   * traído como pendiente.
   */
  it("la fila cargada le gana a la que trajo la consulta", async () => {
    const RESPONDIDO = "2026-08-22T11:00:00Z"; // una hora después de ESPERANDO.
    const vivo = conversation({
      id: "de-ana",
      assignedAgent: ANA,
      lastCustomerMessageAt: ESPERANDO,
      lastMessageAt: RESPONDIDO, // el último mensaje del hilo ya es nuestro.
    });
    const fotoVieja = conversation({ id: "de-ana", lastCustomerMessageAt: ESPERANDO }); // sin `lastMessageAt` propio: la base todavía la ve pendiente.
    mockPending({ stale: [fotoVieja] });

    const { container } = render(
      <InboxSidebar
        conversations={[vivo]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );

    await waitFor(() => expect(fetchConversations).toHaveBeenCalled());
    await waitFor(() => expect(visibleIds(container)).toEqual([]));
  });

  /** Con el conjunto entero ya en pantalla, ofrecer "cargar más" es mentir. */
  it("no ofrece cargar más: 'Pendientes' ya trajo todo lo que hay", async () => {
    mockPending({ stale: [conversation({ id: "olvidado", lastCustomerMessageAt: ESPERANDO })] });

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

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /cargar más/i })).toBeNull()
    );
  });
});

describe("InboxSidebar — secciones de 'Pendientes'", () => {
  it("pinta los dos encabezados de sección, cada uno con su conteo", () => {
    const ahora = Date.now();
    const nuevo = conversation({
      id: "nuevo",
      lastCustomerMessageAt: new Date(ahora - 60_000).toISOString(),
      lastMessageAt: new Date(ahora - 60_000).toISOString(),
    });
    const viejo = conversation({ id: "viejo", lastCustomerMessageAt: ESPERANDO });

    render(
      <InboxSidebar
        conversations={[nuevo, viejo]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );

    expect(screen.getByText("Nuevos · últimas 24 h")).toBeTruthy();
    expect(screen.getByText("Esperando +24 h")).toBeTruthy();

    const conteos = Array.from(document.querySelectorAll(".crm-list-section .lm-num")).map(
      (el) => el.textContent
    );
    expect(conteos).toEqual(["1", "1"]);
  });

  it("oculta el encabezado de la sección que queda vacía", () => {
    const nuevo = conversation({
      id: "nuevo",
      lastCustomerMessageAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    });

    render(
      <InboxSidebar
        conversations={[nuevo]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );

    expect(screen.getByText("Nuevos · últimas 24 h")).toBeTruthy();
    expect(screen.queryByText("Esperando +24 h")).toBeNull();
  });
});

describe("InboxSidebar — conteo de la píldora 'Pendientes'", () => {
  it("viene de la prop counts, no de las filas visibles", () => {
    const { container } = render(
      <InboxSidebar
        conversations={CONVERSATIONS}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        counts={{ pending: 42, pendingStale: 10, mine: 3 }}
      />
    );

    // Solo "de-ana" está cargada como pendiente (1 fila): si el número
    // viniera de lo visible, nunca aparecería "42".
    const conteos = Array.from(container.querySelectorAll(".lm-pill-count")).map(
      (el) => el.textContent
    );
    expect(conteos).toContain("42");
  });

  it("sin la prop counts, ninguna píldora muestra número", () => {
    const { container } = renderSidebar(JEFA);

    expect(container.querySelectorAll(".lm-pill-count")).toHaveLength(0);
  });
});

describe("InboxSidebar — vacío de 'Pendientes'", () => {
  it("dice que no queda nadie esperando respuesta", async () => {
    render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );

    expect(
      await screen.findByText("Todo contestado. No quedó nadie esperando respuesta.")
    ).toBeTruthy();
  });
});

/**
 * Buscar dentro de un filtro estrecho devuelve vacío sin explicación: un
 * chat que no es "Pendientes" ni "Míos" no aparece aunque el nombre o el
 * mensaje coincidan. Al primer carácter la píldora salta a "Todos".
 */
describe("InboxSidebar — buscar mueve la píldora activa a 'Todos'", () => {
  it("al escribir el primer carácter, si el filtro no era 'Todos', salta a 'Todos'", () => {
    renderSidebar(ANA);
    expect(activePillLabel()).toBe("Pendientes");

    fireEvent.change(screen.getByPlaceholderText("Buscar contacto, número o mensaje"), {
      target: { value: "a" },
    });

    expect(activePillLabel()).toBe("Todos");
  });

  it("se queda en 'Todos' al borrar la búsqueda", () => {
    renderSidebar(ANA);

    const buscador = screen.getByPlaceholderText("Buscar contacto, número o mensaje");
    fireEvent.change(buscador, { target: { value: "ana" } });
    fireEvent.change(buscador, { target: { value: "" } });

    expect(activePillLabel()).toBe("Todos");
  });

  it("si ya estaba en 'Todos', escribir no toca el filtro", () => {
    renderSidebar(ANA);
    irATodos();

    fireEvent.change(screen.getByPlaceholderText("Buscar contacto, número o mensaje"), {
      target: { value: "a" },
    });

    expect(activePillLabel()).toBe("Todos");
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
    // El filtro por categoría se prueba sobre "Todos": el default
    // "Pendientes" ya excluiría "sin-duena" (sin `lastCustomerMessageAt`)
    // antes incluso de aplicar la etiqueta.
    irATodos();

    fireEvent.click(within(abrirMenúDeCategorías()).getByText("VIP"));

    expect(visibleIds(container)).toEqual(["sin-duena"]);
  });

  it("elegir de nuevo la categoría activa quita el filtro", () => {
    const { container } = renderSidebar(JEFA);
    irATodos();

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
    // Estas conversaciones no tienen `lastCustomerMessageAt`, así que bajo
    // el filtro por defecto ("Pendientes") no se verían — lo que se prueba
    // acá es el menú contextual, no el filtro, así que se mira sobre "Todos".
    irATodos();
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
