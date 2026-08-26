"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownWideNarrow, ArrowUpWideNarrow, Search } from "lucide-react";
import type { Agent, ConversationSummary, InboxFilter, InboxSort, Tag } from "@/lib/types";
import { fetchConversations, searchConversationSummaries } from "@/lib/data";
import { initials } from "@/lib/dashboard";
import {
  applyInboxFilters,
  filtersForRole,
  INBOX_FILTER_LABELS,
  INBOX_SORT_LABELS,
} from "@/lib/inbox-filters";
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

/**
 * Cuánto se espera desde la última tecla antes de consultar la base.
 *
 * Escribir "bujia" son cinco teclas; sin esperar serían cinco consultas para
 * un único resultado que importa. 300 ms es lo que tarda una pausa de dedo.
 */
const MESSAGE_SEARCH_DEBOUNCE_MS = 300;

/** Constante y no `new Map()` en cada render: es dependencia de un useMemo. */
const SIN_COINCIDENCIAS: ReadonlyMap<string, MessageHit> = new Map();

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="crm-list-section">
      <span className="lm-eyebrow">{label}</span>
      <span className="lm-eyebrow lm-num">{count}</span>
      <span className="crm-list-rule" />
    </div>
  );
}

/** Los filtros que separan leídos de no leídos ya vienen partidos: dividirlos otra vez sobraría. */
const SPLIT_READ_UNREAD: InboxFilter[] = ["assigned", "mine"];

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
}: InboxSidebarProps) {
  const availableFilters = useMemo(() => filtersForRole(currentAgent.role), [currentAgent.role]);

  const [filter, setFilter] = useState<InboxFilter>("all");
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
   * "Sin contestar" es el único corte que no se puede resolver sobre la
   * ventana cargada. La bandeja tiene 30 filas en memoria y arriba están las
   * que se movieron hace poco; este filtro busca lo contrario —el chat que
   * lleva días quieto porque nadie lo tocó—, así que justo lo que interesa
   * queda fuera de la ventana. El conjunto se le pide entero a la base.
   */
  const resolvedOnServer = filter === "unanswered";

  /**
   * Lo que contestó la base. Null mientras no se pidió nunca; al volver al
   * filtro se conserva lo anterior hasta que llegue lo nuevo, para no vaciar
   * la lista en el camino.
   */
  const [serverRows, setServerRows] = useState<ConversationSummary[] | null>(null);

  useEffect(() => {
    if (!resolvedOnServer) return;

    // Mismo motivo que en la búsqueda: lo que hay que evitar no es que la
    // respuesta llegue, sino que una vieja pise a una nueva.
    let cancelled = false;
    (async () => {
      // Sin `limit` a propósito: las tres condiciones ya acotan la consulta a
      // la pila de trabajo libre pendiente, que no crece con el histórico.
      const rows = await fetchConversations(supabase, {
        activeOnly: true,
        unassignedOnly: true,
        awaitingReplyOnly: true,
      });
      if (!cancelled) setServerRows(rows);
    })().catch(() => {
      // Si la consulta falla, el filtro sigue valiendo sobre lo cargado: se
      // verán menos chats, no ninguno.
      if (!cancelled) setServerRows([]);
    });

    return () => {
      cancelled = true;
    };
  }, [supabase, resolvedOnServer]);

  // Lo cargado manda: sus filas están al día por realtime. Lo de la base solo
  // aporta las conversaciones que la ventana no tiene —las viejas, que son
  // justo las que estos dos caminos buscan—.
  const searchableConversations = useMemo(() => {
    const extra: ConversationSummary[] = [];
    if (searchIsCurrent) extra.push(...hitState.remote);
    if (resolvedOnServer && serverRows) extra.push(...serverRows);
    if (extra.length === 0) return conversations;

    const seen = new Set(conversations.map((c) => c.id));
    const merged = [...conversations];
    for (const conversation of extra) {
      if (seen.has(conversation.id)) continue;
      seen.add(conversation.id);
      merged.push(conversation);
    }
    return merged;
  }, [conversations, searchIsCurrent, hitState.remote, resolvedOnServer, serverRows]);

  const filterItems = useMemo(
    () => availableFilters.map((value) => ({ value, label: INBOX_FILTER_LABELS[value] })),
    [availableFilters]
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

  const isSplit = SPLIT_READ_UNREAD.includes(filter);
  const unreadGroup = isSplit ? filtered.filter((c) => c.unreadCount > 0) : [];
  const readGroup = isSplit ? filtered.filter((c) => c.unreadCount === 0) : [];

  /**
   * Bajar por la bandeja solo pagina cuando lo que se ve es la bandeja.
   * Buscando, el fondo de la lista son los resultados; en un filtro que
   * resuelve la base, es el conjunto entero. En los dos casos pedir la página
   * siguiente del histórico traería filas que el filtro va a descartar.
   */
  const paginates = Boolean(onLoadMore) && !trimmedSearch && !resolvedOnServer;

  const handleListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!paginates || !hasMore || loadingMore) return;
      const el = event.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) onLoadMore?.();
    },
    [paginates, onLoadMore, hasMore, loadingMore]
  );

  function renderItems(list: ConversationSummary[]) {
    return list.map((conversation) => (
      <ConversationListItem
        key={conversation.id}
        conversation={conversation}
        isSelected={conversation.id === selectedId}
        onSelect={() => onSelect(conversation.id)}
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
        <span style={{ flex: 1 }} />
        <span className="crm-inbox-count lm-num">{filtered.length}</span>
      </header>

      {bcvRate && <BcvRateChip rate={bcvRate} />}

      <div className="crm-inbox-tools">
        {/* El orden vive acá y no junto a los filtros: la bandeja mide 316px
            y esos 38px son la diferencia entre que las cuatro píldoras se
            vean o queden cortadas. */}
        <div className="crm-inbox-search-row">
          <div className="crm-search">
            <Search size={15} aria-hidden="true" />
            <input
              className="crm-search-input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
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

        {/* Aun compactadas, cuatro píldoras van al límite del ancho. El
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
        {isSplit ? (
          <>
            {unreadGroup.length > 0 && (
              <>
                <SectionHeader label="No leídos" count={unreadGroup.length} />
                {renderItems(unreadGroup)}
              </>
            )}
            {readGroup.length > 0 && (
              <>
                <SectionHeader label="Leídos" count={readGroup.length} />
                {renderItems(readGroup)}
              </>
            )}
          </>
        ) : (
          renderItems(filtered)
        )}

        {filtered.length === 0 && (
          <p className="crm-empty">
            {trimmedSearch
              ? "Ninguna conversación coincide con esa búsqueda, ni por contacto ni por lo que se habló."
              : activeTagId
                ? "Ninguna conversación tiene esa categoría."
                : // Sin esto, mientras la consulta viaja la bandeja afirmaría
                  // que no hay nada — y suele haber.
                  resolvedOnServer && serverRows === null
                  ? "Buscando…"
                  : "No hay conversaciones en este filtro."}
          </p>
        )}

        {/* Red de seguridad del scroll: si la lista filtrada quedó corta y no
            genera desplazamiento, el botón sigue ofreciendo el resto. */}
        {hasMore && paginates && (
          <button
            type="button"
            className="crm-pill crm-load-more"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Cargando…" : "Cargar más conversaciones"}
          </button>
        )}
      </div>

      {menu && (
        <ConversationContextMenu
          position={menu.position}
          isUnread={menu.conversation.unreadCount > 0 || menu.conversation.manuallyUnread}
          onMarkUnread={() => onMarkUnread?.(menu.conversation.id)}
          onMarkRead={() => onMarkRead?.(menu.conversation.id)}
          onClose={closeMenu}
        />
      )}
    </>
  );
}
