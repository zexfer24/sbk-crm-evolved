/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import type { Agent, Conversation, Tag } from "@/lib/types";
import { fetchConversations, INBOX_PAGE_SIZE } from "@/lib/data";
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
  searchConversationSummaries: vi.fn().mockResolvedValue([]),
  INBOX_PAGE_SIZE: 30,
}));

beforeEach(() => {
  vi.mocked(fetchConversations).mockReset().mockResolvedValue([]);
});

/**
 * Responde según qué píldora pidió la consulta: `unreadOnly` para "No
 * leídas", `assignedTo` para "Mías". Sin esto, dar la misma
 * `mockResolvedValue` a las dos llamadas confundiría cuál fila pertenece a
 * cuál píldora — en producción una fila puede calzar en las dos consultas a
 * la vez (un chat mío y sin leer), pero cada una la trae solo bajo su propia
 * condición.
 */
function mockServerRows(over: { unread?: Conversation[]; mine?: Conversation[] } = {}) {
  vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
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
}): Conversation {
  return {
    id: over.id,
    status: over.status ?? "open",
    lastCustomerMessageAt: null,
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
  it("al administrador le ofrece las tres píldoras, en ese orden", () => {
    renderSidebar(JEFA);
    expect(pillLabels()).toEqual(["No leídas", "Mías", "Todos"]);
  });

  it("al asesor le ofrece las mismas tres píldoras", () => {
    renderSidebar(ANA);
    expect(pillLabels()).toEqual(["No leídas", "Mías", "Todos"]);
  });
});

/**
 * Los cortes viejos (por leído, por asignado, y "Pendientes" —retirado de la
 * bandeja en esta misma reforma—) no tienen botón propio. Reintroducir
 * alguno como píldora es decisión consciente del operador, no un descuido de
 * refactor. Este test vigila BOTONES y no texto suelto en la pantalla porque
 * "Sin leer" sí existe dentro de la bandeja: como encabezado de sección
 * dentro de "Mías" (`inbox-sections.ts`), no como filtro.
 */
describe("InboxSidebar — los cortes viejos no vuelven", () => {
  const RETIRADOS = ["Pendientes", "Sin leer", "Sin asignar", "Asignados", "Míos sin leer"];

  it.each(RETIRADOS)("no ofrece la píldora «%s» al administrador", (nombre) => {
    renderSidebar(JEFA);
    expect(screen.queryByRole("button", { name: nombre })).toBeNull();
  });

  it.each(RETIRADOS)("no ofrece la píldora «%s» al asesor", (nombre) => {
    renderSidebar(ANA);
    expect(screen.queryByRole("button", { name: nombre })).toBeNull();
  });
});

describe("InboxSidebar — 'No leídas' y 'Mías' salen a buscar a la base", () => {
  it("al abrir en 'No leídas' (filtro por defecto), pide unreadOnly con la primera página", () => {
    renderSidebar(JEFA);

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

    await waitFor(() => expect(visibleIds(container)).toContain("apartada"));
  });

  /**
   * `page.tsx` resuelve la consulta de "No leídas" en el servidor y la pasa
   * como `initialUnreadRows` para que la bandeja no abra con el cartel
   * "Buscando…" mientras el efecto de red (arriba) hace el mismo viaje otra
   * vez. La consulta del mock nunca resuelve en este test a propósito: si la
   * fila apareciera solo por la semilla, seguiría visible sin depender de
   * que esa promesa llegue a resolver.
   */
  it("con initialUnreadRows, la fila sembrada se ve antes de que la consulta resuelva", () => {
    vi.mocked(fetchConversations).mockImplementation(() => new Promise(() => {}));

    const sembrada = conversation({ id: "sembrada", unreadCount: 1 });

    const { container } = render(
      <InboxSidebar
        conversations={CONVERSATIONS}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        initialUnreadRows={[sembrada]}
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

    const sembradaQueSobrevive = conversation({ id: "sembrada-que-sobrevive", unreadCount: 1 });

    const { container } = render(
      <InboxSidebar
        conversations={CONVERSATIONS}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        initialUnreadRows={[sembradaQueSobrevive]}
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

    await waitFor(() => expect(fetchConversations).toHaveBeenCalledTimes(1));
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
 * Tres carreras de la revisión de código del 29/8/2026 (H1/H2/H3). Ya no
 * las cierra una máquina propia de `inbox-sidebar.tsx`: las cierra
 * `useInboxPager` (`src/lib/use-inbox-pager.ts`, con sus propios tests) —
 * sesión por corrida de primera página + candado síncrono para "cargar más".
 * Lo que queda acá es integración: que el sidebar, montado de verdad, se
 * comporte como el hook promete.
 */
describe("InboxSidebar — carreras de servidor (revisión de código 29/8/2026)", () => {
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

  it("H1 — con la primera página aún en vuelo no ofrece 'cargar más'; al resolver con página llena, aparece y funciona", async () => {
    const primeraPágina = diferida<Conversation[]>();
    let segundaLlamadas = 0;

    vi.mocked(fetchConversations).mockImplementation(async (_supabase, options) => {
      if (!options?.unreadOnly) return [];
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
        initialUnreadRows={paginaLlena("sem")}
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

describe("InboxSidebar — 'Buscando…' al cambiar de píldora", () => {
  it("muestra 'Buscando…' al pasar a 'Mías' mientras esa consulta no resuelve", async () => {
    renderSidebar(JEFA); // "No leídas" resuelve enseguida: el mock por defecto contesta [].
    await waitFor(() => expect(fetchConversations).toHaveBeenCalled());

    vi.mocked(fetchConversations).mockImplementation(() => new Promise(() => {}));
    irA("Mías");

    expect(screen.getByText("Buscando…")).toBeTruthy();
  });
});

describe("InboxSidebar — conteo de la píldora 'No leídas'", () => {
  it("viene de counts.unread, y no aparece en ninguna otra píldora aunque counts.mine exista", async () => {
    const { container } = render(
      <InboxSidebar
        conversations={CONVERSATIONS}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        counts={{ pending: 5, pendingStale: 2, mine: 3, unread: 42 }}
      />
    );
    await waitFor(() => expect(fetchConversations).toHaveBeenCalled());

    // SlidingPills duplica la fila de botones para animar el recorte (ver
    // `pillLabels`): el número real aparece dos veces en el DOM, una por
    // copia. Lo que importa es que sea siempre "42" y nunca el de otra
    // píldora.
    const conteos = Array.from(container.querySelectorAll(".lm-pill-count")).map(
      (el) => el.textContent
    );
    expect(conteos).toEqual(["42", "42"]);
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

    const recuperada = conversation({ id: "recuperada-tras-reintentar", unreadCount: 1 });
    vi.mocked(fetchConversations).mockResolvedValueOnce([recuperada]);

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));

    await waitFor(() => expect(visibleIds(container)).toContain("recuperada-tras-reintentar"));
    expect(screen.queryByText("No se pudo traer la bandeja.")).toBeNull();
  });

  it("con filas ya sembradas, el fallo de la primera página las deja en pantalla y avisa sin taparlas", async () => {
    vi.mocked(fetchConversations).mockRejectedValue(new Error("network"));

    const sembradaQueSobrevive = conversation({ id: "sembrada-que-sobrevive-2", unreadCount: 1 });

    const { container } = render(
      <InboxSidebar
        conversations={CONVERSATIONS}
        selectedId={null}
        onSelect={() => {}}
        currentAgent={JEFA}
        allTags={ALL_TAGS}
        bcvRate={null}
        initialUnreadRows={[sembradaQueSobrevive]}
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
    expect(activePillLabel()).toBe("No leídas");

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
    // El filtro por categoría se prueba sobre "Todos": el default "No
    // leídas" ya excluiría "de-ana" (leída, sin apartar) antes incluso de
    // aplicar la etiqueta.
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
    // "leido" no tiene nada sin leer: bajo el filtro por defecto ("No
    // leídas") no se vería — lo que se prueba acá es el menú contextual, no
    // el filtro, así que se mira sobre "Todos".
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
