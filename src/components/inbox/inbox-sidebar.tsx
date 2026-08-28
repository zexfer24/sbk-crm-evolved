"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownWideNarrow, ArrowUpWideNarrow, Search } from "lucide-react";
import type { Agent, ConversationSummary, InboxFilter, InboxSort, Tag } from "@/lib/types";
import { fetchConversations, searchConversationSummaries } from "@/lib/data";
import { initials } from "@/lib/dashboard";
import {
  applyInboxFilters,
  DEFAULT_INBOX_FILTER,
  filtersForRole,
  INBOX_FILTER_LABELS,
  INBOX_SORT_LABELS,
} from "@/lib/inbox-filters";
import { buildInboxSections, PENDING_STALE_LIMIT } from "@/lib/inbox-sections";
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
   * ventana cargada. Los arma el shell (`fetchInboxCounts`, otra tarea); sin
   * la prop, la píldora "Pendientes" no muestra número — mentir con el
   * tamaño de la ventana cargada es peor que no mostrar nada.
   */
  counts?: { pending: number; pendingStale: number; mine: number };
  /**
   * Filas de "Pendientes" (fresh + stale) ya resueltas en el servidor, para
   * sembrar el estado que llena esa píldora. Sin esto, la bandeja abre en
   * Pendientes mostrando "Buscando…" hasta que responda el efecto de abajo,
   * aunque el servidor ya tuviera los datos a mano.
   */
  initialPendingRows?: ConversationSummary[];
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
  initialPendingRows,
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
   * "Pendientes" es el único corte que no se puede resolver sobre la ventana
   * cargada. La bandeja tiene 30 filas en memoria y arriba están las que se
   * movieron hace poco; este filtro busca lo contrario —el chat que lleva
   * horas o días quieto porque nadie lo tocó—, así que justo lo que interesa
   * queda fuera de la ventana. El conjunto se le pide a la base, partido en
   * las dos ventanas de `inbox-sections.ts` (ver el efecto más abajo).
   */
  const resolvedOnServer = filter === "pending";

  /**
   * Lo que contestó la base. Al volver al filtro se conserva lo anterior
   * hasta que llegue lo nuevo, para no vaciar la lista en el camino.
   *
   * Arranca sembrado con `initialPendingRows` cuando el servidor ya trajo
   * esas filas (ver la prop): la bandeja abre en Pendientes con datos en vez
   * del cartel "Buscando…". Sin semilla arranca en `[]`, no en `null` —el
   * caso sin prop ya no distingue "nunca se pidió" de "la base contestó
   * vacío", pero con `page.tsx` resolviendo siempre las dos ventanas en el
   * servidor ese matiz dejó de hacer falta en el uso real. El efecto de red
   * de abajo corre igual y pisa la semilla con lo que responda la base.
   */
  const [serverRows, setServerRows] = useState<ConversationSummary[] | null>(
    initialPendingRows ?? []
  );

  useEffect(() => {
    if (!resolvedOnServer) return;

    // Mismo motivo que en la búsqueda: lo que hay que evitar no es que la
    // respuesta llegue, sino que una vieja pise a una nueva.
    let cancelled = false;
    (async () => {
      // Dos consultas en paralelo, una por sección de `buildInboxSections`:
      //
      // - "fresh" (dentro de la ventana de 24h de Meta): sin `limit` a
      //   propósito, la acota el tráfico de un solo día, que no crece con el
      //   histórico.
      // - "stale" (fuera de la ventana): sí puede crecer con el histórico si
      //   algo queda sin tocar por mucho tiempo, así que lleva
      //   `PENDING_STALE_LIMIT` como tope conservador.
      //
      // Sin `unassignedOnly`: esta reforma retira la condición de "sin
      // dueño" del filtro `pending` (ver el comentario en
      // inbox-filters.ts) — un chat asignado al que nadie le respondió es
      // pendiente igual.
      //
      // Sin `neverRepliedOnly`: la opción sigue existiendo en data.ts para
      // otro uso, pero acá vaciaba el filtro en producción (ver el
      // comentario del case `pending` en inbox-filters.ts).
      const [fresh, stale] = await Promise.all([
        fetchConversations(supabase, {
          activeOnly: true,
          awaitingReplyOnly: true,
          pendingWindow: "fresh",
        }),
        fetchConversations(supabase, {
          activeOnly: true,
          awaitingReplyOnly: true,
          pendingWindow: "stale",
          limit: PENDING_STALE_LIMIT,
        }),
      ]);
      if (!cancelled) setServerRows([...fresh, ...stale]);
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

  // Solo "Pendientes" lleva conteo: es la única píldora que no se puede
  // deducir de lo cargado (ver `counts` en las props). Las demás se quedan
  // sin número antes que mostrar uno que solo cuenta la ventana en memoria.
  const filterItems = useMemo(
    () =>
      availableFilters.map((value) => ({
        value,
        label: INBOX_FILTER_LABELS[value],
        count: value === "pending" ? counts?.pending : undefined,
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
  // que partir la lista (pending, mine) o dejarla entera y sin encabezado
  // (all). `new Date()` y no un valor memoizado: la ventana de 24 h de
  // "Nuevos" se recalcula en cada render, igual que hace `awaitingReply`.
  const sections = buildInboxSections(filter, filtered, new Date());

  /**
   * Bajar por la bandeja solo pagina cuando lo que se ve es la bandeja.
   * Buscando, el fondo de la lista son los resultados; en un filtro que
   * resuelve la base, es el conjunto entero. En los dos casos pedir la página
   * siguiente del histórico traería filas que el filtro va a descartar.
   */
  const paginates = Boolean(onLoadMore) && !trimmedSearch && !resolvedOnServer;

  /**
   * El único vacío de la bandeja que es una buena noticia: la cola de
   * "Pendientes" quedó en cero. Se aísla de los demás vacíos (búsqueda sin
   * resultados, categoría sin uso, "Buscando…") porque es el único que
   * amerita el trato propio de `crm-empty-pending` en crm.css — los otros
   * son ausencias neutras, esta es un cierre.
   */
  const pendingCleared =
    filter === "pending" && !trimmedSearch && !activeTagId && !(resolvedOnServer && serverRows === null);

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
        {/*
          El conteo de cabecera que había acá contaba `filtered.length`: la
          ventana cargada, no la bandeja real. Con paginación esa cuenta
          mentía apenas se filtraba algo que la base tenía y la ventana no.
          El número honesto ahora vive en la píldora "Pendientes" (prop
          `counts`, ver `filterItems`); las demás píldoras se quedan sin
          número antes que repetir la misma mentira.
        */}
        <span style={{ flex: 1 }} />
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
              onChange={(e) => {
                const value = e.target.value;
                setSearch(value);
                // Buscar dentro de un filtro estrecho devuelve vacío sin
                // explicación: "sin-duena" preguntando por Ana no está en
                // "Pendientes" aunque exista. Al primer carácter la píldora
                // salta a "Todos" para que la búsqueda mire toda la bandeja,
                // y se queda ahí al limpiar el cuadro — volver sola a
                // "Pendientes" escondería de nuevo lo que se acaba de
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
        {sections.map((section) => (
          <Fragment key={section.id}>
            {section.label !== null && (
              <SectionHeader label={section.label} count={section.conversations.length} />
            )}
            {renderItems(section.conversations)}
          </Fragment>
        ))}

        {filtered.length === 0 && (
          <p className={pendingCleared ? "crm-empty crm-empty-pending" : "crm-empty"}>
            {trimmedSearch
              ? "Ninguna conversación coincide con esa búsqueda, ni por contacto ni por lo que se habló."
              : activeTagId
                ? "Ninguna conversación tiene esa categoría."
                : // Sin esto, mientras la consulta viaja la bandeja afirmaría
                  // que no hay nada — y suele haber.
                  resolvedOnServer && serverRows === null
                  ? "Buscando…"
                  : pendingCleared
                    ? (
                      // Mismo trato que AgentHomePanel (la marca de la casa):
                      // es el momento de recompensa del día del asesor, no un
                      // vacío más. Sin animación de festejo ni color de
                      // "éxito" — el aire extra y la marca ya alcanzan para
                      // que se sienta un cierre.
                      <>
                        <SbkMark size={40} className="crm-empty-mark" />
                        <span>Todo contestado. No quedó nadie esperando respuesta.</span>
                      </>
                    )
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
