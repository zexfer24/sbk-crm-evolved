"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownWideNarrow, ArrowUpWideNarrow, Search } from "lucide-react";
import type { Agent, ConversationSummary, InboxFilter, InboxSort, Tag } from "@/lib/types";
import {
  fetchConversations,
  INBOX_PAGE_SIZE,
  searchConversationSummaries,
  type FetchConversationsOptions,
  type InboxCounts,
} from "@/lib/data";
import { mergeById, type ConversationCursor } from "@/lib/inbox-paging";
import { useInboxPager, type InboxPagerView } from "@/lib/use-inbox-pager";
import { initials } from "@/lib/dashboard";
import {
  applyInboxFilters,
  DEFAULT_INBOX_FILTER,
  filtersForRole,
  INBOX_FILTER_LABELS,
  INBOX_SORT_LABELS,
  isUnread,
} from "@/lib/inbox-filters";
import { buildInboxSections } from "@/lib/inbox-sections";
import {
  MESSAGE_SEARCH_MIN_LENGTH,
  searchConversationsByMessage,
  searchTerms,
  type MessageHit,
} from "@/lib/message-search";
import { createClient } from "@/lib/supabase/client";
import { ConversationListItem } from "@/components/inbox/conversation-list-item";
import { ConversationContextMenu } from "@/components/inbox/conversation-context-menu";
import { BcvRateChip, type BcvRateSummary } from "@/components/inbox/bcv-rate-chip";
import { FilterScroller } from "@/components/inbox/filter-scroller";
import { TagFilterMenu } from "@/components/inbox/tag-filter-menu";
import { SlidingPills } from "@/components/sliding-pills";
import { SbkMark } from "@/components/sbk-logo";

/**
 * Cuánto se espera desde la última tecla antes de consultar la base.
 *
 * Escribir "bujia" son cinco teclas; sin esperar serían cinco consultas para
 * un único resultado que importa. 300 ms es lo que tarda una pausa de dedo.
 */
const MESSAGE_SEARCH_DEBOUNCE_MS = 300;

/** Constante y no `new Map()` en cada render: es dependencia de un useMemo. */
const SIN_COINCIDENCIAS: ReadonlyMap<string, MessageHit> = new Map();

/**
 * Arma las opciones de `fetchConversations` para la píldora que resuelve en
 * el servidor: `unreadOnly` para "No leídas", `assignedTo` para "Mías",
 * ambas con el mismo `INBOX_PAGE_SIZE` y, si se pasa cursor, la página
 * siguiente en vez de la primera.
 *
 * Función de módulo y no un ternario repetido en cada llamada a `fetchPage`
 * de `useInboxPager`: antes vivía duplicado entre el efecto de primera
 * página y `loadMoreServerRows` (hallazgo de la revisión de código del
 * 29/8/2026), y que la página 2+ se armara distinto de la página 1 —un
 * campo que uno actualiza y el otro olvida— quedaba a un descuido de
 * distancia. Con un solo lugar es imposible que diverjan.
 */
function pillQueryOptions(
  filter: InboxFilter,
  agentId: string,
  cursor?: ConversationCursor | null
): FetchConversationsOptions {
  const page = { limit: INBOX_PAGE_SIZE, cursor: cursor ?? undefined };
  return filter === "unread" ? { ...page, unreadOnly: true } : { ...page, assignedTo: agentId };
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="crm-list-section">
      <span className="lm-eyebrow">{label}</span>
      <span className="lm-eyebrow lm-num">{count}</span>
      <span className="crm-list-rule" />
    </div>
  );
}

interface InboxSidebarProps {
  conversations: ConversationSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  currentAgent: Agent;
  /** Todas las etiquetas creadas, para la barra de filtro por etiqueta. */
  allTags: Tag[];
  bcvRate: BcvRateSummary | null;
  /** Aparta el chat para volver después. Sin esto no se ofrece el menú. */
  onMarkUnread?: (conversationId: string) => void;
  onMarkRead?: (conversationId: string) => void;
  /** La ventana cargada llegó completa: probablemente haya más detrás. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /**
   * Conteos honestos de cada píldora, contra la base entera y no contra la
   * ventana cargada. Los arma el shell (`fetchInboxCounts`). Solo
   * "No leídas" los usa (ver `filterItems`): sin la prop no muestra número
   * — mentir con el tamaño de la ventana cargada es peor que no mostrar
   * nada.
   */
  counts?: InboxCounts;
  /**
   * Filas de "No leídas" ya resueltas en el servidor, para sembrar el
   * estado que llena esa píldora. Sin esto, la bandeja abre en No leídas
   * mostrando "Buscando…" hasta que responda el efecto de abajo, aunque el
   * servidor ya tuviera los datos a mano.
   */
  initialUnreadRows?: ConversationSummary[];
}

export function InboxSidebar({
  conversations,
  selectedId,
  onSelect,
  currentAgent,
  allTags,
  bcvRate,
  onMarkUnread,
  onMarkRead,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  counts,
  initialUnreadRows,
}: InboxSidebarProps) {
  const availableFilters = useMemo(() => filtersForRole(currentAgent.role), [currentAgent.role]);

  // La bandeja abre mostrando lo que falta por atender, no todo el ruido.
  const [filter, setFilter] = useState<InboxFilter>(DEFAULT_INBOX_FILTER);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<InboxSort>("recent");
  const [tagId, setTagId] = useState<string | null>(null);

  // Qué conversación abrió el menú y dónde. Se guarda la conversación entera
  // y no solo su id porque el menú necesita saber si ya está sin leer para
  // ofrecer la acción que corresponde.
  const [menu, setMenu] = useState<{
    conversation: ConversationSummary;
    position: { x: number; y: number };
  } | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  const canOpenMenu = Boolean(onMarkUnread && onMarkRead);

  // Coincidencias dentro del historial, resueltas por Postgres. Se guardan por
  // separado de la lista: la lista es la verdad de la bandeja y esto es solo
  // un cedazo más que se le aplica encima.
  //
  // `remote` son las conversaciones que responden a la búsqueda pero no están
  // en la ventana paginada: con la bandeja cargando 30 filas, buscar solo
  // sobre lo cargado escondería justo lo viejo que se busca.
  //
  // Se guarda junto a la búsqueda que las pidió, no sueltas. Al escribir
  // "bujía" sobre una búsqueda anterior de "aceite", los resultados de aceite
  // seguirían filtrando la bandeja durante los 300 ms de espera: la lista
  // mostraría chats que no tienen nada que ver con lo que dice el cuadro.
  const [hitState, setHitState] = useState<{
    query: string;
    hits: ReadonlyMap<string, MessageHit>;
    remote: ConversationSummary[];
  }>({ query: "", hits: SIN_COINCIDENCIAS, remote: [] });

  const supabase = useMemo(() => createClient(), []);

  const trimmedSearch = search.trim();

  useEffect(() => {
    if (trimmedSearch.length < MESSAGE_SEARCH_MIN_LENGTH) return;

    // `cancelled` y no un AbortController: lo que hay que evitar no es que la
    // consulta llegue, sino que una respuesta vieja pise a una nueva cuando
    // dos búsquedas se cruzan en el camino.
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        const hits = await searchConversationsByMessage(supabase, trimmedSearch);
        const remote = await searchConversationSummaries(supabase, trimmedSearch, [...hits.keys()]);
        if (!cancelled) setHitState({ query: trimmedSearch, hits, remote });
      })().catch(() => {
        // Buscar contra la base es un extra: si falla, el buscador sigue
        // encontrando por nombre y por número sobre lo ya cargado.
        if (!cancelled) setHitState({ query: trimmedSearch, hits: SIN_COINCIDENCIAS, remote: [] });
      });
    }, MESSAGE_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [supabase, trimmedSearch]);

  const searchIsCurrent = hitState.query === trimmedSearch;
  const messageHits = searchIsCurrent ? hitState.hits : SIN_COINCIDENCIAS;

  /**
   * "No leídas" y "Mías" son los dos cortes que no se pueden resolver sobre
   * la ventana cargada. La bandeja tiene 30 filas en memoria y arriba están
   * las que se movieron hace poco; los dos filtros buscan también lo que no
   * se movió —un chat sin leer que quedó atrás, o un cliente viejo asignado
   * a este asesor—, así que justo lo que interesa puede quedar fuera de la
   * ventana. El conjunto se le pide a la base (ver el efecto más abajo).
   */
  const resolvedOnServer = filter === "unread" || filter === "mine";

  /**
   * Lo que contestó la base, junto con qué píldora lo pidió. La paginación
   * propia de esa consulta —cursor, candado en vuelo, sesión, `reachedEnd`—
   * ya no vive acá: la lleva `useInboxPager` (ver `serverPager` más abajo).
   * Acá solo queda pintar filas.
   *
   * Guardar el filtro junto a las filas —y no las filas sueltas— es lo que
   * evita que la respuesta de una consulta se muestre bajo la píldora
   * equivocada: sin esto, al pasar de "No leídas" a "Mías" las filas viejas
   * de "No leídas" seguirían pintadas mientras la consulta nueva viaja
   * (mismo motivo que separa `hitState` de la búsqueda por consulta).
   *
   * Arranca sembrado con `initialUnreadRows` cuando el servidor ya trajo
   * esas filas (ver la prop): la bandeja abre en "No leídas" —el filtro por
   * defecto— con datos en vez del cartel "Buscando…". El hook de abajo pide
   * su propia primera página igual y pisa la semilla con lo que responda la
   * base (misma primera página, mismo tamaño: `INBOX_PAGE_SIZE`).
   */
  const [serverRows, setServerRows] = useState<{
    filter: InboxFilter;
    rows: ConversationSummary[];
  } | null>(initialUnreadRows ? { filter: "unread", rows: initialUnreadRows } : null);

  // Solo el estado que corresponde a la píldora activa: si `serverRows`
  // quedó con la respuesta de la píldora anterior (la consulta nueva sigue
  // en vuelo), se trata como si no hubiera nada todavía y la lista muestra
  // "Buscando…" en vez de las filas de la píldora que se acaba de dejar.
  const resolvedState = serverRows?.filter === filter ? serverRows : null;
  const resolvedRows = resolvedState?.rows ?? null;

  /**
   * El único paginador de "No leídas"/"Mías": cursor, candado en vuelo,
   * sesión y `reachedEnd` viven en `useInboxPager` (`src/lib/use-inbox-pager.ts`,
   * que también sirve a "Todos" en el shell) — ahí quedó la historia de las
   * tres carreras que una revisión de código encontró el 29/8/2026 (H1/H2/H3:
   * primera página en vuelo, píldora que vuelve mientras una página vieja
   * sigue viajando, y ráfaga de "cargar más"), y ahí se prueban. Acá solo
   * queda decidir DÓNDE cae cada página: la primera reemplaza `serverRows`
   * entero (una píldora nueva no hereda filas de la anterior); las
   * siguientes se pegan con `mergeById` sobre `current.rows` y NO sobre una
   * copia capturada antes de la llamada — un `patchServerRows` que llegue
   * mientras la página viaja (abrir un chat lo marca leído al instante) vive
   * en `current`, y pegarla sobre la copia vieja desharía ese parche.
   *
   * El hook NO recibe `seed`: `initialUnreadRows` son filas para pintar de
   * una vez, no una página resuelta con cursor. El hook pide su propia
   * primera página igual, y hasta que resuelva no ofrece "cargar más" —antes
   * el botón podía aparecer sobre la semilla mientras la consulta de verdad
   * seguía en vuelo, con el candado neutralizándolo en silencio; ahora
   * simplemente no aparece (ver `pager` más abajo).
   */
  const serverPager = useInboxPager({
    enabled: resolvedOnServer,
    sessionKey: `${filter}:${currentAgent.id}`,
    pageSize: INBOX_PAGE_SIZE,
    fetchPage: (cursor) =>
      fetchConversations(supabase, pillQueryOptions(filter, currentAgent.id, cursor)),
    onPage: (rows, mode) =>
      setServerRows((current) => {
        if (mode === "first") return { filter, rows };
        if (!current || current.filter !== filter) return current;
        return { filter, rows: mergeById(current.rows, rows) };
      }),
  });

  /**
   * Parcha en memoria la fila que solo vive en la consulta del servidor: el
   * estado optimista del shell (`markUnread`/`markRead` en crm-shell.tsx)
   * solo toca su lista `conversations`, y una fila cargada acá por
   * `unreadOnly`/`assignedTo` no está ahí. Sin esto, abrir un chat viejo
   * desde "No leídas" lo dejaría marcado como sin leer hasta el próximo
   * viaje a la base.
   *
   * Efecto deliberado de usarla en `onSelect`: la fila sale sola de "No
   * leídas" al abrirla, sin esperar a que la píldora se vuelva a consultar.
   */
  const patchServerRows = useCallback((id: string, patch: Partial<ConversationSummary>) => {
    setServerRows((current) => {
      if (!current) return current;
      const index = current.rows.findIndex((c) => c.id === id);
      if (index === -1) return current;
      const rows = current.rows.slice();
      rows[index] = { ...rows[index], ...patch };
      return { ...current, rows };
    });
  }, []);

  // Lo cargado manda: sus filas están al día por realtime. Lo de la base solo
  // aporta las conversaciones que la ventana no tiene —las viejas, que son
  // justo las que estos dos caminos buscan—.
  const searchableConversations = useMemo(() => {
    const extra: ConversationSummary[] = [];
    if (searchIsCurrent) extra.push(...hitState.remote);
    if (resolvedOnServer && resolvedRows) extra.push(...resolvedRows);
    if (extra.length === 0) return conversations;

    const seen = new Set(conversations.map((c) => c.id));
    const merged = [...conversations];
    for (const conversation of extra) {
      if (seen.has(conversation.id)) continue;
      seen.add(conversation.id);
      merged.push(conversation);
    }
    return merged;
  }, [conversations, searchIsCurrent, hitState.remote, resolvedOnServer, resolvedRows]);

  // Solo "No leídas" lleva conteo. `counts.mine` existe (D5) pero es volumen
  // histórico del asesor —incluye lo cerrado, lo que archivó hace meses—, no
  // una cola por atender: al lado de la píldora sería ruido, no información.
  // El panel de inicio ya lo enseña bajo su propio nombre ("Tuyas"), que es
  // donde ese número sí responde una pregunta que alguien se está haciendo.
  const filterItems = useMemo(
    () =>
      availableFilters.map((value) => ({
        value,
        label: INBOX_FILTER_LABELS[value],
        count: value === "unread" ? counts?.unread : undefined,
      })),
    [availableFilters, counts]
  );

  // Solo tiene sentido ofrecer las etiquetas que alguien está usando: una
  // barra con etiquetas que no filtran nada es ruido.
  const usedTagIds = useMemo(() => {
    const ids = new Set<string>();
    for (const conversation of conversations) {
      for (const tag of conversation.contact.tags) ids.add(tag.id);
    }
    return ids;
  }, [conversations]);

  const visibleTags = useMemo(
    () => allTags.filter((tag) => usedTagIds.has(tag.id)),
    [allTags, usedTagIds]
  );

  // Una categoría que dejó de usarse no puede quedar filtrando en silencio: la
  // bandeja se vería vacía sin un control visible que lo explique. Se resuelve
  // al leer y no borrando el estado, porque si la categoría vuelve a usarse
  // —alguien la aplica de nuevo a un contacto— el filtro sigue donde estaba.
  const activeTagId =
    tagId !== null && visibleTags.some((tag) => tag.id === tagId) ? tagId : null;

  const messageHitIds = useMemo(() => new Set(messageHits.keys()), [messageHits]);

  const filtered = useMemo(
    () =>
      applyInboxFilters(searchableConversations, {
        filter,
        search,
        tagId: activeTagId,
        sort,
        viewer: currentAgent,
        messageHitIds,
      }),
    [searchableConversations, filter, search, activeTagId, sort, currentAgent, messageHitIds]
  );

  // Las palabras a resaltar en el fragmento. Se calculan una vez por búsqueda
  // y no una por conversación.
  const terms = useMemo(() => searchTerms(trimmedSearch), [trimmedSearch]);

  // Un solo camino para las tres píldoras: `buildInboxSections` decide si hay
  // que partir la lista (mine, en Sin leer/Leídas) o dejarla entera y sin
  // encabezado (unread, all). `new Date()` y no un valor memoizado: la firma
  // se comparte con la reforma anterior aunque ningún caso la use hoy (ver
  // el comentario de `now` en inbox-sections.ts).
  const sections = buildInboxSections(filter, filtered, new Date());

  /**
   * Bajar por la bandeja solo pagina cuando lo que se ve es la bandeja.
   * Buscando, el fondo de la lista son los resultados; los dos caminos de
   * paginación —el de "Todos" (props del shell: `hasMore`/`onLoadMore`/
   * `loadingMore`) y el de "No leídas"/"Mías" (`serverPager`, arriba)— se
   * excluyen entre sí: cada píldora pagina por un solo camino a la vez.
   * Buscar siempre salta el filtro a "Todos" (ver el buscador más arriba) y
   * se queda ahí mientras dura, así que las dos ramas nunca compiten por el
   * mismo filtro al mismo tiempo — no hace falta descartar `trimmedSearch`
   * acá aparte.
   */
  const paginatesLocally = Boolean(onLoadMore) && !trimmedSearch && !resolvedOnServer;

  /** Un solo paginador para el fondo de la lista, venga de donde venga. */
  const pager: InboxPagerView = useMemo(
    () =>
      paginatesLocally
        ? { hasMore, loadingMore, lastPageFailed: false, loadMore: () => onLoadMore?.() }
        : serverPager,
    [paginatesLocally, hasMore, loadingMore, onLoadMore, serverPager]
  );

  /** Está esperando la respuesta del servidor para la píldora activa. */
  const searching = resolvedOnServer && resolvedRows === null;

  /**
   * El único vacío de la bandeja que es una buena noticia: la cola de "No
   * leídas" quedó en cero. Se aísla de los demás vacíos (búsqueda sin
   * resultados, categoría sin uso, "Buscando…") porque es el único que
   * amerita el trato propio de `crm-empty-unread` en crm.css — los otros son
   * ausencias neutras, esta es un cierre.
   */
  const unreadCleared = filter === "unread" && !trimmedSearch && !activeTagId && !searching;

  const handleListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!pager.hasMore || pager.loadingMore) return;
      const el = event.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) pager.loadMore();
    },
    [pager]
  );

  /**
   * Abrir un chat es leerlo. `patchServerRows` adelanta ese efecto sobre la
   * copia que vive en la consulta del servidor —la fila viva de
   * `conversations` ya lo hace por su cuenta en el shell (`markConversationRead`
   * al abrir, en crm-shell.tsx)— para que un chat viejo, visto solo por
   * "No leídas" vía servidor, salga de esa píldora sin esperar a que se
   * vuelva a consultar.
   */
  function handleSelect(conversation: ConversationSummary) {
    patchServerRows(conversation.id, { unreadCount: 0, manuallyUnread: false });
    onSelect(conversation.id);
  }

  function renderItems(list: ConversationSummary[]) {
    return list.map((conversation) => (
      <ConversationListItem
        key={conversation.id}
        conversation={conversation}
        isSelected={conversation.id === selectedId}
        onSelect={() => handleSelect(conversation)}
        onOpenMenu={
          canOpenMenu ? (position) => setMenu({ conversation, position }) : undefined
        }
        messageHit={messageHits.get(conversation.id) ?? null}
        searchTerms={terms}
      />
    ));
  }

  const nextSort: InboxSort = sort === "recent" ? "oldest" : "recent";

  return (
    <>
      <header className="crm-inbox-head">
        <span className="lm-avatar" data-size="sm" aria-hidden="true">
          {initials(currentAgent.displayName)}
        </span>
        <div style={{ minWidth: 0 }}>
          <h1 className="crm-inbox-title lm-display">Bandeja</h1>
        </div>
        {/*
          El conteo de cabecera que había acá contaba `filtered.length`: la
          ventana cargada, no la bandeja real. Con paginación esa cuenta
          mentía apenas se filtraba algo que la base tenía y la ventana no.
          El número honesto ahora vive en la píldora "No leídas" (prop
          `counts`, ver `filterItems`); las demás píldoras se quedan sin
          número antes que repetir la misma mentira.
        */}
        <span style={{ flex: 1 }} />
      </header>

      {bcvRate && <BcvRateChip rate={bcvRate} />}

      <div className="crm-inbox-tools">
        {/* El orden vive acá y no junto a los filtros: la bandeja mide 316px
            y esos 38px son la diferencia entre que las tres píldoras se
            vean o queden cortadas. */}
        <div className="crm-inbox-search-row">
          <div className="crm-search">
            <Search size={15} aria-hidden="true" />
            <input
              className="crm-search-input"
              type="search"
              value={search}
              onChange={(e) => {
                const value = e.target.value;
                setSearch(value);
                // Buscar dentro de un filtro estrecho devuelve vacío sin
                // explicación: un cliente viejo, ya leído, no aparece en
                // "No leídas" aunque exista. Al primer carácter la píldora
                // salta a "Todos" para que la búsqueda mire toda la bandeja,
                // y se queda ahí al limpiar el cuadro — volver sola a
                // "No leídas" escondería de nuevo lo que se acaba de
                // encontrar.
                if (value.length > 0 && filter !== "all") setFilter("all");
              }}
              placeholder="Buscar contacto, número o mensaje"
              aria-label="Buscar contacto, número o mensaje"
            />
          </div>
          {visibleTags.length > 0 && (
            <TagFilterMenu tags={visibleTags} value={activeTagId} onChange={setTagId} />
          )}
          <button
            type="button"
            className="lm-icon-btn crm-sort-btn"
            onClick={() => setSort(nextSort)}
            aria-label={`Ordenar: ${INBOX_SORT_LABELS[nextSort]}`}
            title={INBOX_SORT_LABELS[sort]}
          >
            {sort === "recent" ? <ArrowDownWideNarrow size={16} /> : <ArrowUpWideNarrow size={16} />}
          </button>
        </div>

        {/* Aun compactadas, tres píldoras van al límite del ancho. El
            scroll queda de red de seguridad y el degradado del borde avisa
            de que la fila sigue. */}
        <FilterScroller className="crm-inbox-pills-scroll no-scrollbar">
          <SlidingPills
            items={filterItems}
            value={filter}
            onChange={setFilter}
            ariaLabel="Filtrar conversaciones"
            className="crm-inbox-pills"
          />
        </FilterScroller>
      </div>

      <div className="crm-list" onScroll={handleListScroll}>
        {sections.map((section) => (
          <Fragment key={section.id}>
            {section.label !== null && (
              <SectionHeader label={section.label} count={section.conversations.length} />
            )}
            {renderItems(section.conversations)}
          </Fragment>
        ))}

        {filtered.length === 0 && (
          <p className={unreadCleared ? "crm-empty crm-empty-unread" : "crm-empty"}>
            {trimmedSearch
              ? "Ninguna conversación coincide con esa búsqueda, ni por contacto ni por lo que se habló."
              : activeTagId
                ? "Ninguna conversación tiene esa categoría."
                : // Sin esto, mientras la consulta viaja la bandeja afirmaría
                  // que no hay nada — y suele haber.
                  searching
                  ? "Buscando…"
                  : unreadCleared
                    ? (
                      // Mismo trato que AgentHomePanel (la marca de la casa):
                      // es el momento de recompensa del día del asesor, no un
                      // vacío más. Sin animación de festejo ni color de
                      // "éxito" — el aire extra y la marca ya alcanzan para
                      // que se sienta un cierre.
                      <>
                        <SbkMark size={40} className="crm-empty-mark" />
                        <span>Todo leído. No quedó nada nuevo por revisar.</span>
                      </>
                    )
                    : filter === "mine"
                      ? // Vacío neutro y no festivo: no tener nada asignado no
                        // es un logro del día, a diferencia de vaciar "No
                        // leídas".
                        "No tienes conversaciones asignadas."
                      : "No hay conversaciones en este filtro."}
          </p>
        )}

        {/* Red de seguridad del scroll: si la lista filtrada quedó corta y no
            genera desplazamiento, el botón sigue ofreciendo el resto. Sirve
            a las dos formas de paginar (`pager`, sea local o de servidor):
            "cargar más" ya es la señal visible de que queda más — el cartel
            de recorte que tenía esta línea (`crm-list-truncated`, tarea del
            29/8/2026 anterior a esta) dejó de hacer falta apenas "No leídas"
            y "Mías" también pudieron ofrecerlo. */}
        {pager.hasMore && (
          <button
            type="button"
            className="crm-pill crm-load-more"
            onClick={pager.loadMore}
            disabled={pager.loadingMore}
          >
            {pager.loadingMore ? "Cargando…" : "Cargar más conversaciones"}
          </button>
        )}
      </div>

      {menu && (
        <ConversationContextMenu
          position={menu.position}
          isUnread={isUnread(menu.conversation)}
          onMarkUnread={() => {
            patchServerRows(menu.conversation.id, { manuallyUnread: true });
            onMarkUnread?.(menu.conversation.id);
          }}
          onMarkRead={() => {
            patchServerRows(menu.conversation.id, { unreadCount: 0, manuallyUnread: false });
            onMarkRead?.(menu.conversation.id);
          }}
          onClose={closeMenu}
        />
      )}
    </>
  );
}
