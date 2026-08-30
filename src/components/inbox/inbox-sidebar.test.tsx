/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import type { Agent, Conversation, Tag } from "@/lib/types";
import { fetchConversations, fetchUnassignedConversations, INBOX_PAGE_SIZE } from "@/lib/data";
import { InboxSidebar } from "@/components/inbox/inbox-sidebar";

// La bandeja abre un cliente de Supabase para buscar dentro de los mensajes.
// Acá no se prueba esa búsqueda —tiene sus propias pruebas en message-search—,
// solo hace falta que crearlo no explote por falta de variables de entorno.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: vi.fn().mockResolvedValue({ data: [], error: null }) }),
}));

// "No leídas" y "Mías" le preguntan a la base por el conjunto entero, no a
// la ventana cargada; ahora paginan por cursor igual que "Todos" —mismo
// `INBOX_PAGE_SIZE`—, así que el mock necesita el valor real (no el de
// `@/lib/inbox-filters`, que ya no lo tiene) para que las aserciones de
// `limit` calcen con lo que de verdad pide `inbox-sidebar.tsx`.
vi.mock("@/lib/data", () => ({
  fetchConversations: vi.fn().mockResolvedValue([]),
  fetchUnassignedConversations: vi.fn().mockResolvedValue([]),
  searchConversationSummaries: vi.fn().mockResolvedValue([]),
  INBOX_PAGE_SIZE: 30,
}));

beforeEach(() => {
  vi.mocked(fetchConversations).mockReset().mockResolvedValue([]);
  vi.mocked(fetchUnassignedConversations).mockReset().mockResolvedValue([]);
});

/**
 * Responde según qué píldora pidió la consulta: `awaitingReplyOnly` para
 * "Pendientes", `unreadOnly` para "No leídas", `assignedTo` para "Mías". Sin
 * esto, dar la misma `mockResolvedValue` a las tres llamadas confundiría cuál
 * fila pertenece a cuál píldora — en producción una fila puede calzar en más
 * de una consulta a la vez (un chat mío, sin leer y sin responder), pero cada
 * una la trae solo bajo su propia condición.
 */
function mockServerRows(
  over: { pending?: Conversation[]; unread?: Conversation[]; mine?: Conversation[] } = {}
) {
  vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
    if (options?.awaitingReplyOnly) return over.pending ?? [];
    if (options?.unreadOnly) return over.unread ?? [];
    if (options?.assignedTo) return over.mine ?? [];
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

function conversation(over: {
  id: string;
  unreadCount?: number;
  manuallyUnread?: boolean;
  assignedAgent?: Agent | null;
  status?: Conversation["status"];
  tags?: Tag[];
  lastMessageAt?: string | null;
  /**
   * Sin fecha del cliente, `awaitingReply` (dashboard.ts) da `false` por
   * definición: por eso ninguna conversación de este constructor satisface
   * el corte de "Pendientes" salvo que se pase explícitamente. Los tests que
   * sí necesitan pasar ese corte usan `pendingConversation` (más abajo) en
   * vez de fijar este campo a mano en cada caso.
   */
  lastCustomerMessageAt?: string | null;
}): Conversation {
  return {
    id: over.id,
    status: over.status ?? "open",
    lastCustomerMessageAt: over.lastCustomerMessageAt ?? null,
    lastMessageAt: "lastMessageAt" in over ? (over.lastMessageAt ?? null) : "2026-08-20T10:00:00Z",
    hasReply: false,
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

/**
 * Atajo para una conversación que SÍ satisface `awaitingReply` (dashboard.ts)
 * — el mismo predicado que `matchesFilter` (inbox-filters.ts) vuelve a
 * comprobar en memoria para la píldora "Pendientes", incluso sobre filas que
 * ya vienen filtradas del servidor. `lastCustomerMessageAt` igual a
 * `lastMessageAt` (el default de `conversation()`) alcanza: la igualdad
 * cuenta como "todavía esperando" (`<=`, no `<`).
 */
function pendingConversation(over: Parameters<typeof conversation>[0]): Conversation {
  const base = conversation(over);
  return {
    ...base,
    lastCustomerMessageAt: over.lastCustomerMessageAt ?? base.lastMessageAt ?? "2026-08-20T10:00:00Z",
  } as Conversation;
}

const CONVERSATIONS = [
  conversation({ id: "con-vip", unreadCount: 2, tags: [TAG_VIP] }),
  conversation({ id: "de-ana", assignedAgent: ANA, tags: [TAG_MOROSO] }),
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

function irA(nombre: string) {
  const filtros = screen.getByRole("group", { name: "Filtrar conversaciones" });
  fireEvent.click(within(filtros).getAllByRole("button", { name: nombre })[0]);
}

function irATodos() {
  irA("Todos");
}

describe("InboxSidebar — qué filtros ve cada rol", () => {
  it("al administrador le ofrece las cinco píldoras, en ese orden", () => {
    renderSidebar(JEFA);
    expect(pillLabels()).toEqual(["Pendientes", "Sin dueño", "No leídas", "Mías", "Todos"]);
  });

  it("al asesor le ofrece las mismas cinco píldoras", () => {
    renderSidebar(ANA);
    expect(pillLabels()).toEqual(["Pendientes", "Sin dueño", "No leídas", "Mías", "Todos"]);
  });
});

/**
 * Los cortes viejos por leído y por asignado no tienen botón propio.
 * Reintroducir alguno como píldora es decisión consciente del operador, no
 * un descuido de refactor. "Pendientes" salió de esta lista de retirados: la
 * reforma del 30/8/2026 la trajo de vuelta como píldora real (ver `case
 * "pending"` en inbox-filters.ts para el dato que la justifica) — tiene su
 * propia cobertura más abajo. Este test vigila BOTONES y no texto suelto en
 * la pantalla porque "Sin leer" sí existe dentro de la bandeja: como
 * encabezado de sección dentro de "Mías" y de "Pendientes"
 * (`inbox-sections.ts`), no como filtro.
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

describe("InboxSidebar — 'Pendientes', 'No leídas' y 'Mías' salen a buscar a la base", () => {
  it("al pasar a 'No leídas', pide unreadOnly con la primera página", () => {
    renderSidebar(JEFA);
    irA("No leídas");

    expect(fetchConversations).toHaveBeenCalledWith(expect.anything(), {
      unreadOnly: true,
      limit: INBOX_PAGE_SIZE,
    });
  });

  it("al pasar a 'Mías', pide assignedTo con el id de quien mira y la misma primera página", () => {
    renderSidebar(JEFA);
    irA("Mías");

    expect(fetchConversations).toHaveBeenCalledWith(expect.anything(), {
      assignedTo: JEFA.id,
      limit: INBOX_PAGE_SIZE,
    });
  });

  /**
   * El bug que motiva la reforma: antes "Míos" filtraba solo la ventana de
   * ~30 filas en memoria, así que un cliente viejo asignado a este asesor
   * pero fuera de esa ventana desaparecía de su propia píldora. Ahora "Mías"
   * le pregunta a la base por el conjunto entero.
   */
  it("el chat asignado y viejo aparece en 'Mías' vía servidor aunque no esté en memoria", async () => {
    const viejoDeAna = conversation({ id: "viejo-de-ana", assignedAgent: ANA });
    mockServerRows({ mine: [viejoDeAna] });

    const { container } = renderSidebar(ANA);
    irA("Mías");

    await waitFor(() => expect(visibleIds(container)).toContain("viejo-de-ana"));
  });

  /** Cerrar una conversación no es leerla. */
  it("una conversación cerrada con mensajes sin leer aparece en 'No leídas'", async () => {
    const cerrada = conversation({ id: "cerrada-sin-leer", unreadCount: 3, status: "closed" });
    const { container } = render(
      <InboxSidebar
        conversations={[cerrada]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );
    // El filtro por defecto pasó a "Pendientes" (30/8/2026), que excluye lo
    // cerrado (`status !== "closed"`); hay que entrar a "No leídas" a
    // propósito para probar SU regla, que es la contraria.
    irA("No leídas");

    await waitFor(() => expect(visibleIds(container)).toContain("cerrada-sin-leer"));
  });

  /** Apartar a mano cuenta igual que tener mensajes sin abrir (`isUnread`). */
  it("una conversación apartada a mano, con el contador en cero, aparece en 'No leídas'", async () => {
    const apartada = conversation({ id: "apartada", manuallyUnread: true, unreadCount: 0 });
    const { container } = render(
      <InboxSidebar
        conversations={[apartada]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );
    irA("No leídas");

    await waitFor(() => expect(visibleIds(container)).toContain("apartada"));
  });

  /**
   * `crm-shell.tsx` resuelve la consulta de "Pendientes" —el filtro por
   * defecto desde el 30/8/2026— en el servidor y la pasa como
   * `initialPendingRows` para que la bandeja no abra con el cartel
   * "Buscando…" mientras el efecto de red (arriba) hace el mismo viaje otra
   * vez. La consulta del mock nunca resuelve en este test a propósito: si la
   * fila apareciera solo por la semilla, seguiría visible sin depender de
   * que esa promesa llegue a resolver. `pendingConversation` y no
   * `conversation`: la fila sembrada también pasa por `matchesFilter` en
   * memoria (inbox-filters.ts), así que tiene que satisfacer `awaitingReply`
   * para que la semilla se vea.
   */
  it("con initialPendingRows, la fila sembrada se ve antes de que la consulta resuelva", () => {
    vi.mocked(fetchConversations).mockImplementation(() => new Promise(() => {}));

    const sembrada = pendingConversation({ id: "sembrada", unreadCount: 1 });

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
   * `useInboxPager` nunca llama a `onPage` cuando la primera página falla
   * (`status: "error"`, sin tocar `reachedEnd` ni las filas ya pintadas —
   * ver el comentario grande de `use-inbox-pager.ts` sobre el bug "Todo
   * leído" del 29/8/2026). Acá se verifica el efecto que le importa a quien
   * mira la bandeja: una falla de red no borra lo que la semilla ya trajo.
   */
  it("el fallo de la primera página no borra las filas sembradas", async () => {
    vi.mocked(fetchConversations).mockRejectedValue(new Error("network"));

    const sembradaQueSobrevive = pendingConversation({ id: "sembrada-que-sobrevive", unreadCount: 1 });

    const { container } = render(
      <InboxSidebar
        conversations={CONVERSATIONS}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        initialPendingRows={[sembradaQueSobrevive]}
      />
    );

    expect(visibleIds(container)).toContain("sembrada-que-sobrevive");

    await waitFor(() => expect(fetchConversations).toHaveBeenCalled());
    // Deja correr las microtasks del `.catch` sin que nada más pise el
    // estado: la fila sembrada sigue ahí después de que la falla resuelve.
    await Promise.resolve();
    await Promise.resolve();

    expect(visibleIds(container)).toContain("sembrada-que-sobrevive");
  });

  /**
   * Lo que llega de la base es una foto; lo cargado está vivo por realtime.
   * Acá la foto vieja todavía trae la conversación con un contador de sin
   * leer, mientras la fila viva ya la tiene en cero: si la fila viva
   * perdiera, "de-ana-sin-leer" seguiría en la lista.
   */
  it("cuando una conversación está en memoria y en la consulta del servidor, manda la de memoria", async () => {
    const vivo = conversation({
      id: "de-ana-sin-leer",
      assignedAgent: ANA,
      unreadCount: 0,
      manuallyUnread: false,
    });
    const fotoVieja = conversation({ id: "de-ana-sin-leer", assignedAgent: ANA, unreadCount: 5 });
    mockServerRows({ unread: [fotoVieja] });

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
    irA("No leídas");

    await waitFor(() => expect(fetchConversations).toHaveBeenCalled());
    await waitFor(() => expect(visibleIds(container)).toEqual([]));
  });
});

/**
 * `SERVER_FILTER_LIMIT` recortaba en silencio la consulta de "No leídas"/
 * "Mías": esas dos píldoras no ofrecían "cargar más" — la consulta ya había
 * traído todo lo que el tope de 200 dejaba traer —, así que una cola que
 * llegara al tope perdía gente sin que nadie se enterara (el aviso de
 * `serverFilterTruncated`, ya retirado). La reforma del 29/8/2026 las pasa a
 * paginar por cursor (`inbox-paging.ts`), igual que "Todos": ahora SÍ
 * ofrecen "cargar más", y el cursor de la página siguiente es la última fila
 * ACUMULADA (`cursorAfterPage`), no la de la página que acaba de llegar sola.
 * "Pendientes" se suma a las dos con la reforma del 30/8/2026: usa el mismo
 * `serverPager` (ver `pillQueryOptions` en inbox-sidebar.tsx), así que
 * hereda la paginación por cursor sin código propio — su cobertura vive en
 * el describe de "Pendientes" más abajo.
 */
describe("InboxSidebar — 'No leídas' y 'Mías' paginan por cursor", () => {
  /** `INBOX_PAGE_SIZE` filas, para forzar una página llena: la que sí ofrece "cargar más". */
  function paginaLlena(prefix: string, count = INBOX_PAGE_SIZE): Conversation[] {
    const base = new Date("2026-08-20T12:00:00Z").getTime();
    return Array.from({ length: count }, (_, i) =>
      conversation({
        id: `${prefix}-${i}`,
        unreadCount: 1,
        lastMessageAt: new Date(base - i * 60_000).toISOString(),
      })
    );
  }

  it("la primera página no lleva cursor; 'cargar más' aparece cuando vino llena", async () => {
    mockServerRows({ unread: paginaLlena("u") });

    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );
    irA("No leídas");

    await waitFor(() => expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE));
    expect(fetchConversations).toHaveBeenCalledWith(expect.anything(), {
      unreadOnly: true,
      limit: INBOX_PAGE_SIZE,
    });
    expect(screen.getByRole("button", { name: /cargar más/i })).toBeTruthy();
  });

  it("al pedir más, la llamada lleva el cursor de la última fila acumulada, y las páginas se acumulan sin repetir ni perder filas", async () => {
    const primera = paginaLlena("u");
    const segunda = [conversation({ id: "u-extra-1", unreadCount: 1 })];
    let segundaLlamada: unknown;

    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (!options?.unreadOnly) return [];
      if (!options.cursor) return primera;
      segundaLlamada = options;
      return segunda;
    });

    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );
    irA("No leídas");

    await waitFor(() => expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE));

    fireEvent.click(screen.getByRole("button", { name: /cargar más/i }));

    // El cursor es la última fila ACUMULADA (la última de la primera
    // página), no un valor sacado de otro lado.
    const última = primera[primera.length - 1];
    await waitFor(() =>
      expect(segundaLlamada).toMatchObject({
        unreadOnly: true,
        limit: INBOX_PAGE_SIZE,
        cursor: { lastMessageAt: última.lastMessageAt, id: última.id },
      })
    );

    // Las 30 de la primera página siguen, más la de la segunda: nada se
    // repite ni se pierde.
    await waitFor(() => expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE + 1));
    expect(visibleIds(container)).toContain("u-extra-1");
  });

  it("página corta: 'reachedEnd' no ofrece 'cargar más' ni vuelve a pedir", async () => {
    const pocas = [conversation({ id: "una-de-pocas", unreadCount: 1 })];
    mockServerRows({ unread: pocas });

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
    irA("No leídas");

    // Dos llamadas en total: la de "Pendientes" —filtro por defecto, en
    // vuelo con la respuesta vacía de `mockServerRows` para lo que no pidió
    // `unreadOnly`— más la de "No leídas" tras el clic. Se cuentan las que sí
    // llevan `unreadOnly` para que la de "Pendientes" no ensucie lo que este
    // test vigila: que `reachedEnd` no dispare una SEGUNDA llamada a
    // "No leídas".
    await waitFor(() => {
      const llamadasUnread = vi
        .mocked(fetchConversations)
        .mock.calls.filter(([, options]) => options?.unreadOnly);
      expect(llamadasUnread).toHaveLength(1);
    });
    expect(screen.queryByRole("button", { name: /cargar más/i })).toBeNull();
  });

  it("'Mías' pide la página siguiente con assignedTo y el mismo cursor acumulado", async () => {
    const primera = paginaLlena("m");
    let segundaLlamada: unknown;

    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (!options?.assignedTo) return [];
      if (!options.cursor) return primera;
      segundaLlamada = options;
      return [];
    });

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
    irA("Mías");

    await waitFor(() => expect(screen.getByRole("button", { name: /cargar más/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /cargar más/i }));

    const última = primera[primera.length - 1];
    await waitFor(() =>
      expect(segundaLlamada).toMatchObject({
        assignedTo: JEFA.id,
        limit: INBOX_PAGE_SIZE,
        cursor: { lastMessageAt: última.lastMessageAt, id: última.id },
      })
    );
  });
});

/**
 * Cobertura propia de "Pendientes" (reforma del 30/8/2026): la píldora que
 * abre la bandeja por defecto, medida contra producción — "No leídas" es
 * subconjunto estricto de "Pendientes" (282 filas contra 51), así que los
 * 231 chats leídos-y-sin-responder solo vivían en "Todos" hasta esta
 * reforma. El resto del contrato con el servidor (paginación por cursor,
 * carreras, pulso vivo) ya lo comparte con "No leídas"/"Mías" vía el mismo
 * `serverPager`/`pillQueryOptions` — esta sección no lo repite, solo prueba
 * lo que es propio de esta píldora: qué pide, y el caso que la trajo de
 * vuelta.
 */
describe("InboxSidebar — 'Pendientes' resuelve en el servidor y parte en dos secciones", () => {
  it("al abrir en 'Pendientes' (filtro por defecto), pide activeOnly y awaitingReplyOnly con la primera página", () => {
    renderSidebar(JEFA);

    expect(fetchConversations).toHaveBeenCalledWith(expect.anything(), {
      activeOnly: true,
      awaitingReplyOnly: true,
      limit: INBOX_PAGE_SIZE,
    });
  });

  /**
   * Mismo patrón que "No leídas"/"Mías" (ver el describe de paginación por
   * cursor): "Pendientes" pasa por el mismo `serverPager`, así que hereda la
   * paginación por cursor sin código propio. Alcanza con un caso, no los tres
   * H1/H2/H3 — esos ya prueban el mecanismo genérico, no algo específico de
   * esta píldora.
   */
  it("pagina por cursor: la página llena ofrece 'cargar más' y la siguiente pide el cursor de la última fila acumulada", async () => {
    function paginaLlenaPendiente(prefix: string, count = INBOX_PAGE_SIZE): Conversation[] {
      const base = new Date("2026-08-20T12:00:00Z").getTime();
      return Array.from({ length: count }, (_, i) =>
        pendingConversation({
          id: `${prefix}-${i}`,
          lastMessageAt: new Date(base - i * 60_000).toISOString(),
        })
      );
    }

    const primera = paginaLlenaPendiente("p");
    const segunda = [pendingConversation({ id: "p-extra-1" })];
    let segundaLlamada: unknown;

    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (!options?.awaitingReplyOnly) return [];
      if (!options.cursor) return primera;
      segundaLlamada = options;
      return segunda;
    });

    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );

    await waitFor(() => expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE));
    fireEvent.click(screen.getByRole("button", { name: /cargar más/i }));

    const última = primera[primera.length - 1];
    await waitFor(() =>
      expect(segundaLlamada).toMatchObject({
        activeOnly: true,
        awaitingReplyOnly: true,
        limit: INBOX_PAGE_SIZE,
        cursor: { lastMessageAt: última.lastMessageAt, id: última.id },
      })
    );

    await waitFor(() => expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE + 1));
    expect(visibleIds(container)).toContain("p-extra-1");
  });

  it("las dos secciones se pintan: 'Sin abrir' (con lo sin leer) y 'Leídas sin responder'", async () => {
    const sinAbrir = pendingConversation({ id: "pendiente-sin-abrir", unreadCount: 2 });
    const leidaSinResponder = pendingConversation({ id: "pendiente-leida-sin-responder" });
    mockServerRows({ pending: [sinAbrir, leidaSinResponder] });

    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );

    await waitFor(() => expect(visibleIds(container)).toHaveLength(2));
    const encabezados = Array.from(
      container.querySelectorAll(".crm-list-section .lm-eyebrow:not(.lm-num)")
    ).map((el) => el.textContent);
    expect(encabezados).toEqual(["Sin abrir", "Leídas sin responder"]);
  });

  /**
   * El caso que motiva la reforma entera: antes de esta tarea, una
   * conversación ya LEÍDA (nada sin abrir) pero sin responder no aparecía en
   * ninguna píldora — "No leídas" la excluye por estar leída, y no había
   * ninguna otra que mirara `awaiting_reply`. Vive en "Pendientes" desde el
   * 30/8/2026.
   */
  it("una conversación LEÍDA y sin responder aparece en 'Pendientes' — antes no aparecía en ninguna píldora", async () => {
    const leidaSinResponder = pendingConversation({
      id: "leida-y-sin-responder",
      unreadCount: 0,
      manuallyUnread: false,
    });
    mockServerRows({ pending: [leidaSinResponder] });

    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );

    await waitFor(() => expect(visibleIds(container)).toContain("leida-y-sin-responder"));
  });
});

/**
 * Tres carreras de la revisión de código del 29/8/2026 (H1/H2/H3). Ya no
 * las cierra una máquina propia de `inbox-sidebar.tsx`: las cierra
 * `useInboxPager` (`src/lib/use-inbox-pager.ts`, con sus propios tests) —
 * sesión por corrida de primera página + candado síncrono para "cargar más".
 * Lo que queda acá es integración: que el sidebar, montado de verdad, se
 * comporte como el hook promete.
 */
describe("InboxSidebar — carreras de servidor (revisión de código 29/8/2026)", () => {
  /**
   * `INBOX_PAGE_SIZE` filas, para forzar una página llena.
   *
   * `pendingConversation` y no `conversation`: H1 (más abajo) siembra sobre
   * la píldora por defecto, que desde el 30/8/2026 es "Pendientes" y no
   * "No leídas" — sin esto las filas de H1 no pasarían `matchesFilter` en
   * memoria y el test vería la lista vacía en vez de la semilla. H3 y H2
   * navegan a "No leídas" antes de mirar la lista, así que para esos dos da
   * igual: `unreadCount: 1` alcanza para `isUnread` con o sin la fecha extra.
   */
  function paginaLlena(prefix: string, count = INBOX_PAGE_SIZE): Conversation[] {
    const base = new Date("2026-08-20T12:00:00Z").getTime();
    return Array.from({ length: count }, (_, i) =>
      pendingConversation({
        id: `${prefix}-${i}`,
        unreadCount: 1,
        lastMessageAt: new Date(base - i * 60_000).toISOString(),
      })
    );
  }

  /** Promesa controlada a mano: simula una respuesta que tarda en llegar. */
  function diferida<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("H3 — dos disparos de 'cargar más' en ráfaga piden UNA sola página 2", async () => {
    const primera = paginaLlena("u");
    let segundaLlamadas = 0;
    const segunda = diferida<Conversation[]>();

    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (!options?.unreadOnly) return [];
      if (!options.cursor) return primera;
      segundaLlamadas += 1;
      return segunda.promise;
    });

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
    irA("No leídas");

    const botón = await screen.findByRole("button", { name: /cargar más/i });
    // Dos eventos de scroll (o scroll + clic) en el mismo frame: los dos
    // disparan antes de que React repinte `loadingMore`.
    fireEvent.click(botón);
    fireEvent.click(botón);

    await waitFor(() => expect(segundaLlamadas).toBe(1));

    // Deja la promesa resuelta para no ensuciar el próximo test con una
    // actualización de estado fuera de acto.
    segunda.resolve([]);
    await waitFor(() => expect(fetchConversations).toHaveBeenCalled());
  });

  /**
   * H1 se prueba sobre la píldora que abre por defecto —"Pendientes" desde
   * el 30/8/2026, antes "No leídas"— porque es justo la interacción entre
   * la semilla (`initialPendingRows`) y el primer render lo que está en
   * juego: si el test navegara a otra píldora primero, `useInboxPager`
   * abriría una sesión nueva SIN semilla, y dejaría de probar lo que dice el
   * título.
   */
  it("H1 — con la primera página aún en vuelo no ofrece 'cargar más'; al resolver con página llena, aparece y funciona", async () => {
    const primeraPágina = diferida<Conversation[]>();
    let segundaLlamadas = 0;

    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (!options?.awaitingReplyOnly) return [];
      if (options.cursor) {
        segundaLlamadas += 1;
        return [];
      }
      return primeraPágina.promise;
    });

    // Sembrada con página llena: antes el botón "Cargar más" ya aparecía
    // sobre la semilla mientras la consulta real seguía en vuelo, y un
    // candado lo neutralizaba en silencio si alguien llegaba a tocarlo.
    // `useInboxPager` arranca la píldora en estado "loading" (no recibe
    // `seed`) y no ofrece nada hasta que esa primera página resuelve de
    // verdad — el botón ahora ni aparece.
    render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        initialPendingRows={paginaLlena("sem")}
      />
    );

    expect(screen.queryByRole("button", { name: /cargar más/i })).toBeNull();
    expect(segundaLlamadas).toBe(0);

    primeraPágina.resolve(paginaLlena("fresca"));
    const botón = await screen.findByRole("button", { name: /cargar más/i });

    fireEvent.click(botón);
    await waitFor(() => expect(segundaLlamadas).toBe(1));
  });

  it("H2 — al volver a 'No leídas', una respuesta vieja de 'cargar más' no pisa la página fresca ni envenena reachedEnd", async () => {
    const primeraUnread = paginaLlena("u1");
    const fresca = paginaLlena("u2");
    const páginaViejaDeMás = diferida<Conversation[]>();
    let noCursorLlamadas = 0;

    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (options?.assignedTo) return [];
      if (!options?.unreadOnly) return [];
      if (options.cursor) return páginaViejaDeMás.promise;
      noCursorLlamadas += 1;
      return noCursorLlamadas === 1 ? primeraUnread : fresca;
    });

    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );
    irA("No leídas");

    const botón = await screen.findByRole("button", { name: /cargar más/i });
    fireEvent.click(botón); // pide la página 2 de "No leídas"; queda diferida.

    irA("Mías");
    await waitFor(() =>
      expect(screen.queryByText("No tienes conversaciones asignadas.")).toBeTruthy()
    );

    irA("No leídas");
    await waitFor(() => expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE));
    // Solo la página fresca ("u2-*"), nada de la vieja ("u1-*") todavía sin
    // resolver.
    expect(visibleIds(container).every((id) => id.startsWith("u2-"))).toBe(true);

    // La respuesta vieja de "cargar más" llega recién ahora, con una sesión
    // que ya no es la vigente (se abrieron dos sesiones nuevas: "Mías" y el
    // regreso a "No leídas").
    páginaViejaDeMás.resolve([conversation({ id: "vieja-que-no-debe-verse" })]);
    await Promise.resolve();
    await Promise.resolve();

    // No se coló ni pisó la lista fresca.
    expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE);
    expect(visibleIds(container)).not.toContain("vieja-que-no-debe-verse");

    // `reachedEnd` no quedó envenenado por la página vieja (que hubiera sido
    // corta y hubiera apagado "Cargar más"): la página fresca vino llena, así
    // que el botón sigue ofreciéndose.
    expect(screen.getByRole("button", { name: /cargar más/i })).toBeTruthy();
  });
});

/**
 * El hallazgo de la revisión de código del 29/8/2026: `serverRows` es
 * invisible para realtime — una conversación de "No leídas"/"Mías"
 * modificada por otro asesor se quedaba con los datos viejos hasta que se
 * reentraba a la píldora, porque `patchServerRows` solo cubre lo que hace
 * ESTE asesor. El eco del pulso vivo del shell (`livePulse`, ver el efecto
 * junto a `serverRows` en inbox-sidebar.tsx) es lo que cierra ese hueco: al
 * subir, la píldora activa vuelve a pedir su cabecera y la reconcilia con
 * `reconcileHead`.
 */
describe("InboxSidebar — el pulso vivo reconcilia las píldoras de servidor", () => {
  // Los cuatro tests de este bloque prueban "No leídas" en concreto (título
  // de cada uno): el filtro por defecto pasó a "Pendientes" (30/8/2026), así
  // que cada uno entra a "No leídas" a propósito antes de la primera
  // aserción — el mecanismo del pulso es genérico (cualquier píldora de
  // servidor lo usa), pero estos casos fijan uno para no probar tres cosas
  // en simultáneo.
  /** `INBOX_PAGE_SIZE` filas, para forzar una página llena. */
  function paginaLlena(prefix: string, count = INBOX_PAGE_SIZE): Conversation[] {
    const base = new Date("2026-08-20T12:00:00Z").getTime();
    return Array.from({ length: count }, (_, i) =>
      conversation({
        id: `${prefix}-${i}`,
        unreadCount: 1,
        lastMessageAt: new Date(base - i * 60_000).toISOString(),
      })
    );
  }

  it("una fila que otro asesor leyó desaparece de 'No leídas' sin que el asesor cambie de píldora", async () => {
    const conv1 = conversation({ id: "conv-1", unreadCount: 1 });
    const conv2 = conversation({ id: "conv-2", unreadCount: 1 });
    // Ancla, no relleno: `reconcileHead` (`inbox-paging.ts`) reconoce que
    // "conv-2" salió del conjunto porque "conv-3" —más profundo en lo
    // acumulado— SIGUE viniendo en la cabecera fresca. Sin una fila más
    // profunda que la cabecera todavía traiga, la posición de "conv-2" (la
    // última de lo acumulado) sería indistinguible de una fila que solo se
    // hundió más allá de lo que esta cabecera —del tamaño de una página—
    // alcanza a ver, y `reconcileHead` la conserva a propósito ante esa
    // duda (ver su comentario grande y su test "cabecera sin ninguna fila
    // conocida").
    const conv3 = conversation({ id: "conv-3", unreadCount: 1 });
    let llamadas = 0;
    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (!options?.unreadOnly) return [];
      llamadas += 1;
      // Primera llamada: la primera página, con las tres filas. Segunda
      // llamada (el pulso): la cabecera fresca, donde "conv-2" ya no viene
      // — alguien más la leyó — pero "conv-3" sigue.
      return llamadas === 1 ? [conv1, conv2, conv3] : [conv1, conv3];
    });

    const { container, rerender } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        livePulse={0}
      />
    );
    irA("No leídas");

    await waitFor(() => expect(visibleIds(container)).toEqual(["conv-1", "conv-2", "conv-3"]));

    rerender(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        livePulse={1}
      />
    );

    // El asesor se queda en "No leídas": nada lo saca del filtro.
    expect(activePillLabel()).toBe("No leídas");
    await waitFor(() => expect(visibleIds(container)).toEqual(["conv-1", "conv-3"]));
  });

  it("una fila que solo se hundió (sigue en el conjunto, más abajo) no se pierde", async () => {
    // Página llena (30 filas): hay más abajo que la cabecera fresca —de
    // tamaño igual a una sola página— no puede ver entera.
    const primera = paginaLlena("u");
    const nueva = conversation({ id: "nueva", unreadCount: 1 });
    let llamadas = 0;
    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (!options?.unreadOnly) return [];
      llamadas += 1;
      if (llamadas === 1) return primera;
      // La cabecera fresca del pulso: una fila nueva empujó a la primera de
      // la página original una posición hacia abajo, pero esa primera fila
      // sigue estando — no salió del conjunto, solo se hundió.
      return [nueva, primera[0]];
    });

    const { container, rerender } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        livePulse={0}
      />
    );
    irA("No leídas");

    await waitFor(() => expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE));

    rerender(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        livePulse={1}
      />
    );

    await waitFor(() => expect(visibleIds(container)).toContain("nueva"));
    // Las 30 originales siguen todas: ninguna se perdió por hundirse.
    for (const fila of primera) {
      expect(visibleIds(container)).toContain(fila.contact.displayName);
    }
    expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE + 1);
  });

  it("con varias páginas bajadas, el pulso no borra las filas de abajo", async () => {
    const primera = paginaLlena("u");
    const segunda = [conversation({ id: "u-extra-1", unreadCount: 1 })];
    let llamadasSinCursor = 0;

    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (!options?.unreadOnly) return [];
      if (options.cursor) return segunda; // "cargar más": la página 2.
      llamadasSinCursor += 1;
      // Primera llamada: primera página. Pulso: la misma cabecera de
      // siempre (nadie cambió nada) — la página 2, ya bajada, no vuelve a
      // pedirse ni debe desaparecer.
      return primera;
    });

    const { container, rerender } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        livePulse={0}
      />
    );
    irA("No leídas");

    await waitFor(() => expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE));
    fireEvent.click(screen.getByRole("button", { name: /cargar más/i }));
    await waitFor(() => expect(visibleIds(container)).toContain("u-extra-1"));
    expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE + 1);

    rerender(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        livePulse={1}
      />
    );

    await waitFor(() => expect(llamadasSinCursor).toBe(2));
    // La fila de la página 2, más profunda que lo que la cabecera del pulso
    // alcanza a ver, se conserva.
    expect(visibleIds(container)).toContain("u-extra-1");
    expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE + 1);
  });

  it("cambiar de píldora mientras la cabecera del pulso viaja no pinta la respuesta vieja", async () => {
    const conv1 = conversation({ id: "conv-1", unreadCount: 1 });
    const { promise: cabeceraDelPulso, resolve: resolverCabeceraDelPulso } = (() => {
      let resolve!: (value: Conversation[]) => void;
      const promise = new Promise<Conversation[]>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();

    let llamadasSinCursorUnread = 0;
    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (options?.assignedTo) return [];
      if (!options?.unreadOnly) return [];
      llamadasSinCursorUnread += 1;
      if (llamadasSinCursorUnread === 1) return [conv1];
      // Segunda llamada, y SOLO la segunda: el pulso pide la cabecera
      // fresca y se queda colgada, el asesor cambia de píldora antes de que
      // resuelva. Atarla a la cuenta exacta —y no a "cualquier llamada
      // después de la primera"— importa: al volver a "No leídas" más abajo,
      // `useInboxPager` dispara SU PROPIA primera página de esa nueva
      // sesión (cambia `sessionKey`), una consulta legítima e
      // independiente del pulso que colgó. Sin este corte, esa consulta
      // agarraría la misma promesa ya resuelta con el valor viejo del
      // pulso —dos peticiones distintas no pueden compartir una sola
      // promesa— y el test fallaría por un defecto del mock, no del
      // código bajo prueba.
      if (llamadasSinCursorUnread === 2) return cabeceraDelPulso;
      return [conv1];
    });

    const { container, rerender } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        livePulse={0}
      />
    );
    irA("No leídas");

    await waitFor(() => expect(visibleIds(container)).toEqual(["conv-1"]));

    rerender(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        livePulse={1}
      />
    );
    await waitFor(() => expect(llamadasSinCursorUnread).toBe(2));

    // El asesor cambia de píldora antes de que la cabecera del pulso resuelva.
    irA("Mías");
    await waitFor(() =>
      expect(screen.queryByText("No tienes conversaciones asignadas.")).toBeTruthy()
    );

    // La cabecera vieja llega tarde, ya sin dueño.
    resolverCabeceraDelPulso([conversation({ id: "vieja-que-no-debe-verse", unreadCount: 1 })]);
    await Promise.resolve();
    await Promise.resolve();

    // "Mías" sigue vacía: la respuesta de "No leídas" no se coló acá.
    expect(screen.queryByText("No tienes conversaciones asignadas.")).toBeTruthy();
    expect(visibleIds(container)).not.toContain("vieja-que-no-debe-verse");

    // Y al volver a "No leídas", tampoco quedó pisada por la respuesta vieja.
    irA("No leídas");
    await waitFor(() => expect(visibleIds(container)).toEqual(["conv-1"]));
    expect(visibleIds(container)).not.toContain("vieja-que-no-debe-verse");
  });
});

describe("InboxSidebar — 'Buscando…' al cambiar de píldora", () => {
  it("muestra 'Buscando…' al pasar a 'Mías' mientras esa consulta no resuelve", async () => {
    renderSidebar(JEFA); // "Pendientes" (filtro por defecto) resuelve enseguida: el mock por defecto contesta [].
    await waitFor(() => expect(fetchConversations).toHaveBeenCalled());

    vi.mocked(fetchConversations).mockImplementation(() => new Promise(() => {}));
    irA("Mías");

    expect(screen.getByText("Buscando…")).toBeTruthy();
  });
});

describe("InboxSidebar — conteo de las píldoras 'Pendientes' y 'No leídas'", () => {
  it("vienen de counts.pending y counts.unread; 'Mías' y 'Todos' se quedan sin número", async () => {
    const { container } = render(
      <InboxSidebar
        conversations={CONVERSATIONS}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        counts={{ pending: 5, pendingStale: 2, mine: 3, unread: 42, unassigned: 0 }}
      />
    );
    await waitFor(() => expect(fetchConversations).toHaveBeenCalled());

    // SlidingPills duplica la fila de botones para animar el recorte (ver
    // `pillLabels`): cada número real aparece dos veces en el DOM, una por
    // copia. Orden de las píldoras: Pendientes, Sin dueño, No leídas, Mías,
    // Todos — las dos últimas no llevan `count`, así que no aportan ningún
    // `<span>`; ni `counts.mine` (3) ni `counts.pendingStale` (2) deben
    // colarse acá.
    //
    // "Sin dueño" muestra 0 y no se esconde a propósito: un cero ahí es una
    // afirmación —"no hay ningún lead suelto"— y es justo el número que la
    // reforma quiere que el equipo pueda mirar de un vistazo. Esconderlo
    // haría que "todo en orden" y "todavía no cargó" se vieran igual.
    const conteos = Array.from(container.querySelectorAll(".lm-pill-count")).map(
      (el) => el.textContent
    );
    expect(conteos).toEqual(["5", "0", "42", "5", "0", "42"]);
  });

  it("sin la prop counts, ninguna píldora muestra número", () => {
    const { container } = renderSidebar(JEFA);
    expect(container.querySelectorAll(".lm-pill-count")).toHaveLength(0);
  });
});

describe("InboxSidebar — vacío de 'No leídas'", () => {
  it("dice que todo quedó leído, con la clase celebratoria", async () => {
    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );
    irA("No leídas");

    expect(await screen.findByText("Todo leído. No quedó nada nuevo por revisar.")).toBeTruthy();
    expect(container.querySelector(".crm-empty-unread")).toBeTruthy();
  });
});

describe("InboxSidebar — vacío de 'Mías'", () => {
  it("dice que no tiene nada asignado, sin la clase celebratoria", async () => {
    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );
    irA("Mías");

    expect(await screen.findByText("No tienes conversaciones asignadas.")).toBeTruthy();
    expect(container.querySelector(".crm-empty-unread")).toBeNull();
  });
});

/**
 * A.T5 (revisión de código del 29/8/2026): antes de esta reforma, un fallo
 * transitorio de la primera página se disfrazaba de "Todo leído" —
 * `useInboxPager` ya cierra la mitad del bug (`reachedEnd` nunca se
 * enciende en un camino de error, ver `use-inbox-pager.ts`), lo que falta
 * probar acá es que el sidebar cuenta la verdad: cartel propio, sin festejo,
 * con salida.
 *
 * Se prueba sobre el filtro por defecto sin navegar a ningún otro —
 * "Pendientes" desde el 30/8/2026— porque es justo la primera página de ESE
 * pager la que falla al montar; por eso `recuperada`/`sembradaQueSobrevive`
 * usan `pendingConversation` y no `conversation`.
 */
describe("InboxSidebar — fallo de la primera página (A.T5)", () => {
  it("avisa que no se pudo traer la bandeja, sin festejar 'Todo leído', y Reintentar vuelve a pedir", async () => {
    vi.mocked(fetchConversations).mockRejectedValueOnce(new Error("network"));

    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );

    expect(await screen.findByText("No se pudo traer la bandeja.")).toBeTruthy();
    expect(screen.queryByText("Todo leído. No quedó nada nuevo por revisar.")).toBeNull();
    expect(container.querySelector(".crm-empty-unread")).toBeNull();

    const recuperada = pendingConversation({ id: "recuperada-tras-reintentar", unreadCount: 1 });
    vi.mocked(fetchConversations).mockResolvedValueOnce([recuperada]);

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));

    await waitFor(() => expect(visibleIds(container)).toContain("recuperada-tras-reintentar"));
    expect(screen.queryByText("No se pudo traer la bandeja.")).toBeNull();
  });

  it("con filas ya sembradas, el fallo de la primera página las deja en pantalla y avisa sin taparlas", async () => {
    vi.mocked(fetchConversations).mockRejectedValue(new Error("network"));

    const sembradaQueSobrevive = pendingConversation({ id: "sembrada-que-sobrevive-2", unreadCount: 1 });

    const { container } = render(
      <InboxSidebar
        conversations={CONVERSATIONS}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        initialPendingRows={[sembradaQueSobrevive]}
      />
    );

    expect(visibleIds(container)).toContain("sembrada-que-sobrevive-2");

    expect(await screen.findByText("No se pudo traer la bandeja.")).toBeTruthy();
    // El aviso no reemplaza la lista: la fila sembrada sigue ahí al lado.
    expect(visibleIds(container)).toContain("sembrada-que-sobrevive-2");
    expect(screen.queryByText("Todo leído. No quedó nada nuevo por revisar.")).toBeNull();
  });
});

/**
 * A.T4: `useInboxPager` ya distinguía este caso (`lastPageFailed`, ver el
 * comentario grande de `use-inbox-pager.ts`) desde A.T5, pero hasta esta
 * tarea nadie lo leía — el pie de la bandeja seguía diciendo "Cargar más
 * conversaciones" como si la petición nunca hubiera fallado.
 */
describe("InboxSidebar — fallo de una página siguiente (A.T4)", () => {
  function paginaLlena(prefix: string, count = INBOX_PAGE_SIZE): Conversation[] {
    const base = new Date("2026-08-20T12:00:00Z").getTime();
    return Array.from({ length: count }, (_, i) =>
      conversation({
        id: `${prefix}-${i}`,
        unreadCount: 1,
        lastMessageAt: new Date(base - i * 60_000).toISOString(),
      })
    );
  }

  /**
   * Vía "No leídas" (resuelve por `serverPager`). Reintentar debe pedir la
   * MISMA página: el cursor no se movió porque la respuesta que falló nunca
   * llegó a actualizarlo (ver el comentario grande de `use-inbox-pager.ts`).
   */
  it("con filas ya cargadas, si la página siguiente falla el pie avisa y ofrece reintentar en vez de 'Cargar más'; reintentar pide la misma página y las filas nuevas aparecen", async () => {
    const primera = paginaLlena("u");
    const segunda = [conversation({ id: "u-extra-1", unreadCount: 1 })];
    const cursoresConCursor: unknown[] = [];

    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (!options?.unreadOnly) return [];
      if (!options.cursor) return primera;
      cursoresConCursor.push(options.cursor);
      if (cursoresConCursor.length === 1) throw new Error("network");
      return segunda;
    });

    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );
    irA("No leídas");

    await waitFor(() => expect(visibleIds(container)).toHaveLength(INBOX_PAGE_SIZE));

    fireEvent.click(screen.getByRole("button", { name: /cargar más/i }));

    expect(await screen.findByText("No se pudo traer la página siguiente.")).toBeTruthy();
    expect(screen.queryByText("Cargar más conversaciones")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));

    await waitFor(() => expect(visibleIds(container)).toContain("u-extra-1"));
    expect(screen.queryByText("No se pudo traer la página siguiente.")).toBeNull();

    // Las dos llamadas que llevaron cursor pidieron la MISMA página.
    expect(cursoresConCursor).toHaveLength(2);
    expect(cursoresConCursor[0]).toEqual(cursoresConCursor[1]);
  });

  /**
   * "Todos" pagina localmente (props `hasMore`/`loadingMore`/`onLoadMore`
   * del shell): la decisión (b) del plan hace que el shell también pase
   * `lastPageFailed` (de su propio `allPager`) para que este camino avise
   * igual que "No leídas"/"Mías". Acá se prueba la mitad que le toca al
   * sidebar — que la prop, en `true`, se pinta y que reintentar llama
   * `onLoadMore` (en producción, `allPager.loadMore`) y no alguna función de
   * reintentar-primera-página, que no aplica en este caso.
   */
  it("en 'Todos' (paginación local), con hasMore y lastPageFailed el pie avisa y Reintentar llama a onLoadMore", () => {
    const onLoadMore = vi.fn();
    render(
      <InboxSidebar
        conversations={CONVERSATIONS}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        hasMore
        loadingMore={false}
        lastPageFailed
        onLoadMore={onLoadMore}
      />
    );
    irATodos();

    expect(screen.getByText("No se pudo traer la página siguiente.")).toBeTruthy();
    expect(screen.queryByText("Cargar más conversaciones")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

/**
 * Buscar dentro de un filtro estrecho devuelve vacío sin explicación: un
 * chat ya leído no aparece en "No leídas" aunque el nombre o el mensaje
 * coincidan. Al primer carácter la píldora salta a "Todos".
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

/**
 * Abrir un chat es leerlo. `patchServerRows` (inbox-sidebar.tsx) adelanta
 * ese efecto sobre la fila que solo vive en la consulta del servidor, para
 * que salga de "No leídas" sin esperar a que se vuelva a consultar.
 */
describe("InboxSidebar — abrir un chat de servidor lo saca de 'No leídas'", () => {
  it("la fila que solo llegó por la consulta desaparece de la lista al seleccionarla", async () => {
    const soloEnServidor = conversation({ id: "solo-en-servidor", unreadCount: 3 });
    mockServerRows({ unread: [soloEnServidor] });

    const onSelect = vi.fn();
    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={onSelect}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );
    irA("No leídas");

    await waitFor(() => expect(visibleIds(container)).toContain("solo-en-servidor"));

    fireEvent.click(screen.getByText("solo-en-servidor"));

    expect(onSelect).toHaveBeenCalledWith("solo-en-servidor");
    await waitFor(() => expect(visibleIds(container)).not.toContain("solo-en-servidor"));
  });
});

/** El filtro por categoría vive en un menú: abrirlo es parte del gesto. */
function abrirMenúDeCategorías(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /categoría/i }));
  return screen.getByRole("menu", { name: "Filtrar por categoría" });
}

describe("InboxSidebar — filtrar por categoría", () => {
  /**
   * Reforma del 30/8/2026 (`inbox-sidebar.tsx:499` de la versión previa a
   * esta tarea): antes este test se llamaba "solo ofrece las categorías que
   * alguna conversación está usando" y el componente mismo derivaba "en uso"
   * recorriendo `conversations` —la ventana cargada, ~30 filas—, así que
   * "Moroso" (sin ninguna conversación cargada que la lleve) no aparecía en
   * el menú. Ese filtrado se movió a `fetchTagsInUse` (`src/lib/data.ts`,
   * fuera del alcance de esta tarea): `allTags` YA llega resuelto contra la
   * base entera, sembrado desde `page.tsx`, y el componente ofrece
   * exactamente lo que recibe ahí. Es el corazón del arreglo: una etiqueta
   * que solo usan conversaciones fuera de la ventana —el caso típico de las
   * que aplica la IA sola, más abajo en la lista— antes no aparecía nunca en
   * la barra.
   */
  it("ofrece una etiqueta aunque ninguna conversación cargada la tenga", () => {
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
    // "Moroso" no la lleva ninguna conversación de `conversations` (arriba):
    // sigue apareciendo porque viene en `allTags`, sin importar qué hay
    // cargado en pantalla.
    expect(within(menú).getByText("Moroso")).toBeTruthy();
  });

  it("al elegir una categoría deja solo las conversaciones que la llevan", () => {
    const { container } = renderSidebar(JEFA);
    // El filtro por categoría se prueba sobre "Todos": el default
    // "Pendientes" ya excluiría "de-ana" (sin fecha de cliente, no cuenta
    // como esperando respuesta) antes incluso de aplicar la etiqueta.
    irATodos();

    fireEvent.click(within(abrirMenúDeCategorías()).getByText("VIP"));

    expect(visibleIds(container)).toEqual(["con-vip"]);
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

  /**
   * Mismo cambio de contrato que el test de arriba: antes decía "sin
   * categorías en uso" y probaba conversaciones sin etiqueta con `allTags`
   * no vacío (el componente vaciaba el menú por su cuenta). Ahora el vacío
   * lo decide quien llama —`allTags` mismo, no las conversaciones cargadas—
   * así que el escenario que prueba "menú vacío" es `allTags={[]}`.
   */
  it("con allTags vacío no ofrece el botón: un menú vacío no filtra nada", () => {
    render(
      <InboxSidebar
        conversations={[conversation({ id: "pelada" })]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={[]}
        bcvRate={null}
      />
    );

    expect(screen.queryByRole("button", { name: /categoría/i })).toBeNull();
  });
});

describe("InboxSidebar — etiqueta activa resuelve en el servidor", () => {
  /**
   * Decisión del 30/8/2026: con etiqueta activa, TODAS las píldoras se
   * resuelven en el servidor, incluida "Todos" — antes `pillQueryOptions`
   * lanzaba para `"all"` a propósito, y esa píldora paginaba solo en
   * memoria sobre `conversations` (la ventana cargada). Sin este cambio,
   * "Todos" + etiqueta seguiría mostrando nada más que las etiquetas de esa
   * ventana, el mismo sesgo que la reforma de la barra le saca al filtro.
   */
  it("elegir una etiqueta pide al servidor una consulta que incluye ese tagId", async () => {
    renderSidebar(JEFA);
    irATodos();

    fireEvent.click(within(abrirMenúDeCategorías()).getByText("VIP"));

    await waitFor(() =>
      expect(fetchConversations).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tagId: "t-vip" })
      )
    );
  });

  it("'Todos' + etiqueta se resuelve en servidor, no en memoria sobre la ventana cargada", async () => {
    // Con la etiqueta activa, solo la consulta "Todos + tagId" (sin
    // `awaitingReplyOnly`/`unreadOnly`/`assignedTo`) trae esta fila — no
    // está en `CONVERSATIONS` (la ventana cargada de `renderSidebar`), así
    // que solo puede aparecer si la petición viajó de verdad al servidor.
    const deServidor = conversation({ id: "de-servidor", tags: [TAG_VIP] });
    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      const esTodosConEtiqueta =
        options?.tagId === "t-vip" &&
        !options?.awaitingReplyOnly &&
        !options?.unreadOnly &&
        !options?.assignedTo;
      return esTodosConEtiqueta ? [deServidor] : [];
    });

    const { container } = renderSidebar(JEFA);
    irATodos();

    fireEvent.click(within(abrirMenúDeCategorías()).getByText("VIP"));

    await waitFor(() => expect(visibleIds(container)).toContain("de-servidor"));
  });

  /**
   * `sessionKey` de `useInboxPager` lleva la etiqueta activa (`${filter}:
   * ${currentAgent.id}:${activeTagId ?? ""}`): cambiar de etiqueta abre
   * sesión nueva y la primera página de la etiqueta que entra REEMPLAZA
   * `serverRows` entero, no se pega a lo que ya había. Sin la etiqueta en el
   * `sessionKey`, cambiar de "VIP" a "Moroso" sin cambiar de píldora no
   * abriría sesión nueva y la fila de "VIP" seguiría en `serverRows` hasta
   * la próxima "cargar más".
   */
  it("cambiar de etiqueta no arrastra las filas de la anterior", async () => {
    const deVip = conversation({ id: "de-vip-servidor", tags: [TAG_VIP] });
    const deMoroso = conversation({ id: "de-moroso-servidor", tags: [TAG_MOROSO] });
    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (options?.tagId === "t-vip") return [deVip];
      if (options?.tagId === "t-moroso") return [deMoroso];
      return [];
    });

    const { container } = renderSidebar(JEFA);
    irATodos();

    fireEvent.click(within(abrirMenúDeCategorías()).getByText("VIP"));
    await waitFor(() => expect(visibleIds(container)).toContain("de-vip-servidor"));

    fireEvent.click(within(abrirMenúDeCategorías()).getByText("Moroso"));
    await waitFor(() => expect(visibleIds(container)).toContain("de-moroso-servidor"));
    expect(visibleIds(container)).not.toContain("de-vip-servidor");
  });

  /**
   * "Sin dueño" es el punto que más fácil se queda sin etiquetar, porque no
   * pasa por `pillQueryOptions`: tiene su propia vía,
   * `fetchUnassignedConversations`.
   *
   * Lo que se afirma acá es que la etiqueta llega hasta LA CONSULTA, no que
   * las filas de más se escondan al pintar. La diferencia importa: como
   * `matchesTag` filtra igual en memoria (`applyInboxFilters`), un test que
   * solo mirara la lista visible se quedaría en verde aunque la etiqueta
   * nunca saliera del navegador — y entonces esta píldora se traería el
   * conjunto entero de "Sin dueño" en cada pulso vivo para descartar la
   * mayor parte, dejando además filas que no se van a pintar dando vueltas
   * por `serverRows`.
   */
  it("'Sin dueño' + etiqueta baja la etiqueta hasta la consulta", async () => {
    const conDueVip = conversation({ id: "sin-dueno-vip", tags: [TAG_VIP] });
    const sinEtiqueta = conversation({ id: "sin-dueno-pelado" });
    vi.mocked(fetchUnassignedConversations).mockResolvedValue([conDueVip, sinEtiqueta]);

    const { container } = render(
      <InboxSidebar
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
      />
    );
    irA("Sin dueño");

    await waitFor(() => expect(visibleIds(container)).toContain("sin-dueno-pelado"));
    // Sin etiqueta elegida, la consulta no lleva ninguna.
    expect(vi.mocked(fetchUnassignedConversations).mock.calls.at(-1)?.[1]).toEqual({
      tagId: undefined,
    });

    vi.mocked(fetchUnassignedConversations).mockResolvedValue([conDueVip]);
    fireEvent.click(within(abrirMenúDeCategorías()).getByText("VIP"));

    await waitFor(() =>
      expect(vi.mocked(fetchUnassignedConversations).mock.calls.at(-1)?.[1]).toEqual({
        tagId: TAG_VIP.id,
      })
    );
    await waitFor(() => expect(visibleIds(container)).toEqual(["sin-dueno-vip"]));
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
    // "leido" no tiene fecha de cliente ni nada sin leer: bajo el filtro por
    // defecto ("Pendientes") no se vería — lo que se prueba acá es el menú
    // contextual, no el filtro, así que se mira sobre "Todos".
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
