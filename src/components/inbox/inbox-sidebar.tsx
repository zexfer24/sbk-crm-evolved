"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownWideNarrow, ArrowUpWideNarrow, CalendarDays, History, Search, UserPlus } from "lucide-react";
import type {
  Agent,
  ConversationSummary,
  InboxDayScope,
  InboxFilter,
  InboxSort,
  Tag,
} from "@/lib/types";
import {
  fetchConversations,
  fetchPinnedIds,
  fetchUnassignedConversations,
  INBOX_PAGE_SIZE,
  searchConversationSummaries,
  type FetchConversationsOptions,
  type InboxCounts,
} from "@/lib/data";
import { pinConversation, unpinConversation } from "@/lib/mutations";
import { mergeById, reconcileHead, type ConversationCursor } from "@/lib/inbox-paging";
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
import { NewContactModal } from "@/components/inbox/new-contact-modal";

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
 * Dónde vive la preferencia de píldora y orden de CADA agente (T2.2 del plan
 * "La bandeja que no pierde", 5/9/2026). Por agente y no una sola clave
 * global: dos personas turnándose el mismo navegador (un puesto compartido)
 * no deberían pisarse la píldora que cada una prefiere.
 */
function inboxPrefsStorageKey(agentId: string): string {
  return `sbk:inbox:${agentId}`;
}

/** Lo que se guarda bajo `inboxPrefsStorageKey`. */
interface StoredInboxPrefs {
  filter?: string;
  sort?: string;
}

/**
 * Arma las opciones de `fetchConversations` para la píldora que resuelve en
 * el servidor: `activeOnly` + `awaitingReplyOnly` para "Pendientes",
 * `unreadOnly` para "No leídas", `assignedTo` para "Mías", las tres con el
 * mismo `INBOX_PAGE_SIZE` y, si se pasa cursor, la página siguiente en vez
 * de la primera.
 *
 * Función de módulo y no un ternario repetido en cada llamada a `fetchPage`
 * de `useInboxPager`: antes vivía duplicado entre el efecto de primera
 * página y `loadMoreServerRows` (hallazgo de la revisión de código del
 * 29/8/2026), y que la página 2+ se armara distinto de la página 1 —un
 * campo que uno actualiza y el otro olvida— quedaba a un descuido de
 * distancia. Con un solo lugar es imposible que diverjan.
 *
 * `switch` exhaustivo y no el ternario de antes (reforma del 30/8/2026, al
 * sumar `pending` al union `InboxFilter`): el ternario de dos ramas mandaba
 * cualquier filtro que no fuera `"unread"` a la rama `assignedTo` —con
 * `pending` nuevo, hubiera caído ahí en silencio, pidiendo la cola de un
 * asesor cuando lo que se quería era la cola de todo el equipo, y `tsc` no
 * tiene forma de avisar de un ternario que "siempre" tiene una rama para
 * cubrir el resto. Un `switch` sin `default` sobre un union sí lo caza: el
 * día que se sume una quinta píldora, falta un `case` y la build no
 * compila.
 *
 * `tagId` (reforma del 30/8/2026, barra de etiquetas) viaja en `page` y de
 * ahí a CADA rama que sí construye una consulta: la etiqueta activa no
 * reemplaza el corte de la píldora, se le suma — "Pendientes" + etiqueta
 * sigue siendo pendiente Y con esa etiqueta. `"all"` es la excepción: ahí la
 * etiqueta ES el único corte (ver ese caso, abajo).
 *
 * `sort` (T1.3 del plan "Bandeja que no pierde", 5/9/2026, píldora "Más
 * antiguas") viaja igual que `tagId`: en `page`, para las cuatro ramas —
 * "Pendientes" + "Más antiguas" tiene que traer la conversación pendiente
 * más VIEJA de toda la base, no solo invertir el orden de lo ya cargado.
 * `fetchConversations` (`src/lib/data.ts`) entiende `order: "recent" |
 * "oldest"` y arma el cursor de continuación en el sentido que corresponda.
 *
 * `since` (T1 del plan "Seis frentes del buzón", 8/9/2026, "habló hoy")
 * viaja igual: el corte de "hoy" ya calculado (`useInboxDay`, en el shell)
 * se le suma a CUALQUIER píldora, `undefined` con el interruptor "Ver todo".
 * `undefined` y no un default propio acá: mismo motivo que `cursor`/`tagId`
 * arriba, para no tocar cada `toHaveBeenCalledWith` existente que no conoce
 * el día.
 */
function pillQueryOptions(
  filter: InboxFilter,
  agentId: string,
  cursor: ConversationCursor | null | undefined,
  tagId: string | null,
  sort: InboxSort,
  since: string | undefined
): FetchConversationsOptions {
  const page = {
    limit: INBOX_PAGE_SIZE,
    cursor: cursor ?? undefined,
    tagId: tagId ?? undefined,
    // `undefined` y no `sort` a secas cuando es `"recent"`: mismo patrón que
    // `cursor`/`tagId` acá arriba — `"recent"` es el default de
    // `fetchConversations` (`src/lib/data.ts`), así que mandarlo explícito no
    // cambiaría nada en la consulta pero SÍ en cada `toHaveBeenCalledWith`
    // existente que compara el objeto de opciones exacto.
    order: sort === "oldest" ? ("oldest" as const) : undefined,
    since,
  };
  switch (filter) {
    case "pending":
      return { ...page, activeOnly: true, awaitingReplyOnly: true };
    case "unread":
      return { ...page, unreadOnly: true };
    case "mine":
      return { ...page, assignedTo: agentId };
    // "Escaladas" (T1.5, 5/9/2026): `escalatedOnly` arma en `data.ts` el
    // mismo predicado que vuelve a comprobar `matchesFilter`
    // (inbox-filters.ts) en memoria — journey_stage/ai_enabled/status/
    // last_reply_sender/awaiting_reply, columnas todas de `conversations`,
    // así que a diferencia de "unassigned" (más abajo) sí pasa por acá.
    case "escalated":
      return { ...page, escalatedOnly: true };
    case "unassigned":
      // No pasa por acá: "Sin dueño" no es un corte de columnas de
      // `conversations` sino de la última fila de `conversation_handoffs`, y
      // lo resuelve `fetchUnassignedConversations` en una consulta propia
      // (ver `fetchPage` más abajo) que NO acepta `tagId` — se compone en
      // memoria ahí mismo. Misma razón que "all" sin etiqueta ni orden
      // invertido para lanzar en vez de devolver una consulta mal armada.
      throw new Error('pillQueryOptions: "unassigned" se resuelve con fetchUnassignedConversations');
    case "all":
      // Reforma del 30/8/2026: `resolvedOnServer` (más abajo) deja pasar
      // `"all"` hasta acá SOLO cuando hay etiqueta activa — sin eso, "Todos"
      // + etiqueta seguiría filtrando en memoria nada más que las ~30 filas
      // de la ventana cargada (`conversations`, props del shell), exactamente
      // el sesgo que esta reforma le saca a la barra de etiquetas. Con
      // etiqueta, la etiqueta ES el único corte real de esta consulta —
      // "Todos" no tiene ningún otro—, y ya viaja en `page`.
      //
      // T1.3 (5/9/2026) suma la segunda vía: con `sort === "oldest"`,
      // "Todos" también resuelve acá aunque no haya etiqueta — mismo motivo,
      // "Todos" + "Más antiguas" necesita la conversación más vieja de TODA
      // la base, y la ventana cargada localmente solo tiene las ~30 más
      // recientes. `page.order` ya lleva el sentido invertido.
      //
      // Sin etiqueta y con `sort === "recent"`, "Todos" sigue paginando
      // localmente y nunca llega hasta acá: la rama sigue lanzando ante esa
      // llamada fuera de contrato, más honesto que devolver una consulta sin
      // ningún corte real. Existe igual porque el `switch` es exhaustivo a
      // propósito (ver el comentario de arriba).
      if (!tagId && sort !== "oldest") {
        throw new Error(
          'pillQueryOptions: "all" solo resuelve en el servidor con una etiqueta activa o con sort "oldest"'
        );
      }
      return page;
  }
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
  /**
   * Las etiquetas EN USO (`fetchTagsInUse`, `src/lib/data.ts`), para la barra
   * de filtro por etiqueta — no todas las creadas: una barra con etiquetas
   * que no filtran nada es ruido. Se resuelve contra la base entera y no
   * contra `conversations` (la ventana cargada abajo): antes de la reforma
   * del 30/8/2026 este componente derivaba "en uso" recorriendo esa ventana,
   * y una etiqueta aplicada a un contacto fuera de ella no aparecía nunca en
   * la barra — el sesgo se notaba con las conversaciones que atiende sola la
   * IA, que suelen quedar más abajo en la lista.
   */
  allTags: Tag[];
  bcvRate: BcvRateSummary | null;
  /** Aparta el chat para volver después. Sin esto no se ofrece el menú. */
  onMarkUnread?: (conversationId: string) => void;
  onMarkRead?: (conversationId: string) => void;
  /**
   * Cerrar/reabrir desde el menú contextual (T2.1, 5/9/2026). Opcionales,
   * igual que `onMarkUnread`/`onMarkRead`: sin el callback correspondiente
   * `ConversationContextMenu` simplemente no ofrece esa acción.
   */
  onCloseConversation?: (conversationId: string) => void;
  onReopenConversation?: (conversationId: string) => void;
  /** La ventana cargada llegó completa: probablemente haya más detrás. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /**
   * La página siguiente de "Todos" falló (A.T4, 29/8/2026). El shell la
   * expone acá desde `allPager.lastPageFailed` —el mismo `useInboxPager` que
   * ya presta `hasMore`/`onLoadMore`— para que el pie de la lista pueda
   * avisar y ofrecer reintentar en vez de seguir diciendo "Cargar más" como
   * si la petición nunca hubiera fallado. "Pendientes"/"No leídas"/"Mías" no
   * la necesitan: cada una tiene su propio `serverPager` con el mismo campo
   * (ver `pager` más abajo). Por defecto `false`: un consumidor que no la
   * pasa nunca ve el aviso, igual que antes de esta tarea.
   */
  lastPageFailed?: boolean;
  /**
   * Conteos honestos de cada píldora, contra la base entera y no contra la
   * ventana cargada. Los arma el shell (`fetchInboxCounts`). Solo
   * "Pendientes" y "No leídas" los usan (ver `filterItems`): sin la prop no
   * muestran número — mentir con el tamaño de la ventana cargada es peor que
   * no mostrar nada.
   */
  counts?: InboxCounts;
  /**
   * Filas de "Pendientes" ya resueltas en el servidor, para sembrar el
   * estado que llena esa píldora. Sin esto, la bandeja abre en "Pendientes"
   * —el filtro por defecto desde la reforma del 30/8/2026— mostrando
   * "Buscando…" hasta que responda el efecto de abajo, aunque el servidor ya
   * tuviera los datos a mano.
   */
  initialPendingRows?: ConversationSummary[];
  /**
   * Se incrementa cada vez que el pulso vivo del shell (`fetchInboxHead` en
   * crm-shell.tsx) trae una cabecera fresca para "Todos". Es el eco que usan
   * "Pendientes"/"No leídas"/"Mías" para saber que algo cambió en la base y
   * volver a consultar SU propia cabecera (ver el efecto junto a
   * `serverRows` más abajo) — sin esto quedan con datos viejos hasta que el
   * asesor sale y reentra al filtro. Opcional y con valor por defecto para
   * no obligar a cada instancia existente de `InboxSidebar` a conocerlo (p.
   * ej. tests que no ejercitan este camino).
   */
  livePulse?: number;
  /**
   * "Agregar contacto" (T6, 8/9/2026): sube al padre el id de la
   * conversación que acaba de crear/reutilizar `NewContactModal`, para que
   * el shell la seleccione y abra el chat. Opcional -- sin el callback el
   * botón de la cabecera igual crea la conversación (queda en la bandeja
   * apenas llegue el próximo refresco), solo no la abre sola.
   */
  onContactCreated?: (conversationId: string) => void;
  /**
   * El corte "habló hoy" (T1, 8/9/2026): `dayScope` decide qué pinta el
   * interruptor (icono y texto), `dayStart` es el instante YA CALCULADO
   * (`useInboxDay`, en el shell — misma fuente que usan las consultas y los
   * seis contadores) que este componente le pasa tal cual a
   * `applyInboxFilters`/`pillQueryOptions`/`fetchUnassignedConversations`.
   * `onDayScopeChange` es lo que dispara el toggle; sin él —tests que no
   * conocen esta tarea— el botón no se pinta y `dayStart` cae a `null` (sin
   * corte), igual que el comportamiento de antes de esta tarea.
   */
  dayScope?: InboxDayScope;
  dayStart?: string | null;
  onDayScopeChange?: (scope: InboxDayScope) => void;
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
  onCloseConversation,
  onReopenConversation,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  lastPageFailed = false,
  counts,
  initialPendingRows,
  livePulse = 0,
  onContactCreated,
  dayScope = "all",
  dayStart = null,
  onDayScopeChange,
}: InboxSidebarProps) {
  const [isNewContactOpen, setIsNewContactOpen] = useState(false);
  const availableFilters = useMemo(() => filtersForRole(currentAgent.role), [currentAgent.role]);

  // La bandeja abre mostrando lo que falta por atender, no todo el ruido.
  const [filter, setFilter] = useState<InboxFilter>(DEFAULT_INBOX_FILTER);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<InboxSort>("recent");
  const [tagId, setTagId] = useState<string | null>(null);

  /**
   * Recordar la píldora y el orden entre sesiones (T2.2, 5/9/2026). Se lee
   * UNA sola vez al montar, en un efecto y nunca en el render: el servidor
   * (SSR de este "use client") no tiene `localStorage`, así que leerlo
   * durante el render reventaría ahí. `didLoadPrefsRef` deja que el efecto
   * de ESCRITURA (más abajo) se salte por completo su primera pasada — sin
   * esto, ese efecto escribiría los defaults de vuelta al storage un
   * instante antes de que este efecto de lectura alcance a restaurar el
   * valor guardado, porque los dos corren en el mismo commit inicial con el
   * estado todavía viejo.
   */
  const didLoadPrefsRef = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(inboxPrefsStorageKey(currentAgent.id));
      if (raw) {
        const stored = JSON.parse(raw) as StoredInboxPrefs;
        // `INBOX_FILTER_LABELS` ya conoce las seis píldoras válidas: es más
        // confiable que `availableFilters` para esto, porque una preferencia
        // guardada con un rol no debería quedar huérfana si el rol cambia.
        if (stored.filter && Object.prototype.hasOwnProperty.call(INBOX_FILTER_LABELS, stored.filter)) {
          // Sincroniza React con lo que ya vive en localStorage al montar —
          // no hay otra forma de traer un valor externo adentro salvo un
          // setState directo acá; mismo caso que use-inbox-pager.ts:167.
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setFilter(stored.filter as InboxFilter);
        }
        if (stored.sort === "recent" || stored.sort === "oldest") {
          setSort(stored.sort);
        }
      }
    } catch {
      // Modo incógnito o almacenamiento bloqueado: se queda en
      // DEFAULT_INBOX_FILTER/"recent", que ya trae useState de arriba.
    }
  }, [currentAgent.id]);

  useEffect(() => {
    if (!didLoadPrefsRef.current) {
      // Primera pasada: es la que corresponde al montaje, y lo que hay que
      // hacer en el montaje es LEER (efecto de arriba), no escribir. Todas
      // las pasadas siguientes sí son un cambio real (restaurado o elegido a
      // mano) y sí se guardan.
      didLoadPrefsRef.current = true;
      return;
    }
    try {
      localStorage.setItem(
        inboxPrefsStorageKey(currentAgent.id),
        JSON.stringify({ filter, sort } satisfies StoredInboxPrefs)
      );
    } catch {
      // Sin almacenamiento, la preferencia vale solo para esta pestaña.
    }
  }, [currentAgent.id, filter, sort]);

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

  /**
   * Hasta tres conversaciones fijadas por el agente que mira (T2.2, 5/9/2026,
   * `conversation_pins`). Se resuelve acá y no en `crm-shell.tsx` porque es
   * autocontenido: no hay ninguna columna nueva en `ConversationSummary` que
   * el shell tenga que empezar a cargar, alcanza con este `Set` de ids.
   */
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    fetchPinnedIds(supabase, currentAgent.id)
      .then((ids) => {
        if (!cancelled) setPinnedIds(ids);
      })
      .catch(() => {
        // Sin pines la bandeja sigue funcionando igual, solo sin la
        // fijación hasta el próximo intento (cambiar de píldora no lo
        // reintenta: es un fetch de montaje, no ligado al filtro activo).
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, currentAgent.id]);

  /**
   * Fijar/desfijar, con el mismo patrón optimista que `markUnread`/`markRead`
   * en `crm-shell.tsx`: el estado local se mueve antes que la base, y si la
   * escritura falla —el trigger del cuarto pin, u otra cosa— el catch relee
   * `conversation_pins` para devolver `pinnedIds` a la verdad ("refresco tras
   * mutar", sin abrir un canal de realtime nuevo para esto).
   */
  const pinConversationById = useCallback(
    (conversationId: string) => {
      setPinnedIds((current) => new Set(current).add(conversationId));
      pinConversation(supabase, currentAgent.id, conversationId).catch(() => {
        fetchPinnedIds(supabase, currentAgent.id)
          .then(setPinnedIds)
          .catch(() => {});
      });
    },
    [supabase, currentAgent.id]
  );

  const unpinConversationById = useCallback(
    (conversationId: string) => {
      setPinnedIds((current) => {
        const next = new Set(current);
        next.delete(conversationId);
        return next;
      });
      unpinConversation(supabase, currentAgent.id, conversationId).catch(() => {
        fetchPinnedIds(supabase, currentAgent.id)
          .then(setPinnedIds)
          .catch(() => {});
      });
    },
    [supabase, currentAgent.id]
  );

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

  // Solo tiene sentido ofrecer las etiquetas que alguien está usando: una
  // barra con etiquetas que no filtran nada es ruido. Antes esa condición se
  // recalculaba acá recorriendo `conversations` —la ventana cargada, ~30
  // filas— buscando qué etiquetas aparecían en ella: una etiqueta aplicada a
  // un contacto fuera de esa ventana no aparecía nunca en la barra, aunque sí
  // se viera en pantalla en `searchableConversations` (más abajo), que además
  // suma lo resuelto en servidor. Como la IA suele etiquetar conversaciones
  // que atiende sola —más abajo en la lista, fuera de la ventana—, el sesgo
  // se notaba justo con las suyas (diagnóstico del 30/8/2026,
  // `inbox-sidebar.tsx:499` de esa versión). Ahora "en uso" se resuelve
  // contra la base entera, no contra la ventana: `allTags` YA es el
  // resultado de `fetchTagsInUse` (`src/lib/data.ts`), sembrado desde
  // `page.tsx` — acá no queda nada que derivar, la prop ES la lista.
  const visibleTags = allTags;

  // Una categoría que dejó de usarse no puede quedar filtrando en silencio: la
  // bandeja se vería vacía sin un control visible que lo explique. Se resuelve
  // al leer y no borrando el estado, porque si la categoría vuelve a usarse
  // —alguien la aplica de nuevo a un contacto— el filtro sigue donde estaba.
  const activeTagId =
    tagId !== null && visibleTags.some((tag) => tag.id === tagId) ? tagId : null;

  /**
   * "Pendientes", "No leídas" y "Mías" son los tres cortes que no se pueden
   * resolver sobre la ventana cargada. La bandeja tiene 30 filas en memoria
   * y arriba están las que se movieron hace poco; los tres filtros buscan
   * también lo que no se movió —un chat abierto y sin responder que quedó
   * atrás, uno sin leer, o un cliente viejo asignado a este asesor—, así que
   * justo lo que interesa puede quedar fuera de la ventana. El conjunto se
   * le pide a la base (ver el efecto más abajo). `pending` se suma acá en la
   * reforma del 30/8/2026, junto con la píldora (ver `case "pending"` en
   * `inbox-filters.ts` para el dato que la trajo de vuelta). `escalated` se
   * suma el 5/9/2026 (T1.5) por el mismo motivo: una escalación vieja puede
   * haber quedado fuera de la ventana cargada tanto como un pendiente viejo.
   *
   * Con etiqueta activa (misma reforma, más tarde el mismo día), hasta
   * "Todos" se suma: sin esto, "Todos" + etiqueta seguiría paginando en
   * memoria sobre la ventana cargada, el mismo sesgo que esta reforma le
   * saca a la barra (ver el comentario de `visibleTags`, arriba). Las otras
   * tres píldoras ya resolvían en servidor con o sin etiqueta; para ellas
   * esta condición no cambia nada.
   *
   * Con `sort === "oldest"` (T1.3, 5/9/2026, píldora "Más antiguas") "Todos"
   * se suma por la misma razón que la etiqueta: la ventana cargada solo
   * tiene las ~30 conversaciones más recientes, así que invertir el orden EN
   * MEMORIA (lo que hacía `applyInboxFilters` antes de esta tarea, y sigue
   * haciendo para las demás píldoras) mostraría "la más vieja de esas 30",
   * no la más vieja de toda la base — exactamente el motivo por el que la
   * etiqueta activa fuerza el mismo camino, arriba.
   */
  const resolvedOnServer =
    filter === "pending" ||
    filter === "unread" ||
    filter === "mine" ||
    filter === "unassigned" ||
    // "Escaladas" (T1.5, 5/9/2026): mismo motivo que "Pendientes"/"No
    // leídas"/"Mías" — el corte mira columnas que la ventana cargada no
    // garantiza tener representadas (una escalación vieja puede haber
    // quedado atrás, fuera de las ~30 filas en memoria).
    filter === "escalated" ||
    activeTagId !== null ||
    sort === "oldest";

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
   * Arranca sembrado con `initialPendingRows` cuando el servidor ya trajo
   * esas filas (ver la prop): la bandeja abre en "Pendientes" —el filtro por
   * defecto desde la reforma del 30/8/2026— con datos en vez del cartel
   * "Buscando…". El hook de abajo pide su propia primera página igual y pisa
   * la semilla con lo que responda la base (misma primera página, mismo
   * tamaño: `INBOX_PAGE_SIZE`).
   */
  const [serverRows, setServerRows] = useState<{
    filter: InboxFilter;
    rows: ConversationSummary[];
  } | null>(initialPendingRows ? { filter: "pending", rows: initialPendingRows } : null);

  // Solo el estado que corresponde a la píldora activa: si `serverRows`
  // quedó con la respuesta de la píldora anterior (la consulta nueva sigue
  // en vuelo), se trata como si no hubiera nada todavía y la lista muestra
  // "Buscando…" en vez de las filas de la píldora que se acaba de dejar.
  const resolvedState = serverRows?.filter === filter ? serverRows : null;
  const resolvedRows = resolvedState?.rows ?? null;

  /**
   * El único paginador de "Pendientes"/"No leídas"/"Mías": cursor, candado
   * en vuelo, sesión y `reachedEnd` viven en `useInboxPager`
   * (`src/lib/use-inbox-pager.ts`,
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
   * El hook NO recibe `seed`: `initialPendingRows` son filas para pintar de
   * una vez, no una página resuelta con cursor. El hook pide su propia
   * primera página igual, y hasta que resuelva no ofrece "cargar más" —antes
   * el botón podía aparecer sobre la semilla mientras la consulta de verdad
   * seguía en vuelo, con el candado neutralizándolo en silencio; ahora
   * simplemente no aparece (ver `pager` más abajo).
   */
  const serverPager = useInboxPager({
    enabled: resolvedOnServer,
    // La etiqueta activa entra al `sessionKey` (reforma del 30/8/2026): sin
    // esto, cambiar de etiqueta sin cambiar de píldora no abriría sesión
    // nueva en `useInboxPager` y las filas ya cargadas de la etiqueta
    // anterior seguirían pegadas en `serverRows` —`mergeById` solo agrega,
    // nunca saca— hasta la próxima "cargar más". Con sesión nueva, la
    // primera página de la etiqueta que entra REEMPLAZA `serverRows` entero
    // (ver `onPage`, abajo): ninguna fila de la anterior sobrevive.
    //
    // `sort` entra por el mismo motivo (T1.3, 5/9/2026): cambiar de "Más
    // recientes" a "Más antiguas" sin esto seguiría paginando con el cursor
    // que ya se había armado para el otro sentido —un cursor descendente no
    // sirve para seguir bajando en ascendente, y viceversa— y las filas ya
    // acumuladas del orden anterior quedarían pegadas en `serverRows`.
    //
    // `dayStart` entra por el mismo motivo (T1, 8/9/2026): tocar el
    // interruptor "Ver todo", o que el reloj cruce la medianoche de Caracas
    // (`useInboxDay` cambia de valor), abre sesión nueva — sin esto las
    // filas ya cargadas bajo el corte de ayer seguirían pegadas en
    // `serverRows` tras el cambio.
    sessionKey: `${filter}:${currentAgent.id}:${activeTagId ?? ""}:${sort}:${dayStart ?? ""}`,
    pageSize: INBOX_PAGE_SIZE,
    fetchPage: (cursor) =>
      // "Sin dueño" no pagina por cursor: su consulta resuelve el conjunto
      // completo de una vez (son los chats que el sistema soltó — si esa
      // lista es larga, el problema no es la paginación). Se devuelve todo en
      // la primera página y vacío en cualquier siguiente, que es como el
      // pager entiende "ya no hay más". Tampoco atiende `sort`: no tiene
      // sentido "la más vieja sin dueño primero" para una lista que ya
      // resuelve completa de una sola vez, sin cursor que invertir.
      filter === "unassigned"
        ? cursor
          ? Promise.resolve([])
          : fetchUnassignedConversations(supabase, {
              tagId: activeTagId ?? undefined,
              since: dayStart ?? undefined,
            })
        : fetchConversations(
            supabase,
            pillQueryOptions(filter, currentAgent.id, cursor, activeTagId, sort, dayStart ?? undefined)
          ),
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

  /** Qué pulso ya se atendió, para no reaccionar al valor con el que se montó. */
  const livePulseRef = useRef(livePulse);

  /**
   * Eco del pulso vivo del shell sobre la píldora de servidor ACTIVA.
   *
   * `patchServerRows` (arriba) solo cubre lo que hace ESTE asesor —abrir un
   * chat, apartarlo—. Lo que hace OTRO asesor (leer el chat, que se lo
   * reasignen) le llega a `conversations` ("Todos", en crm-shell.tsx) por el
   * canal de realtime de `useLiveConversations`, pero `serverRows` es una
   * consulta aparte que ese canal no toca: una conversación vieja, sin
   * leer, que ya salió de la ventana de "Todos" puede vivir SOLO acá, y
   * "Todos" nunca la ve pasar para avisar. Hallazgo de la revisión de
   * código del 29/8/2026.
   *
   * Se reusa el pulso del shell —`livePulse` sube cada vez que
   * `fetchInboxHead` trae una cabecera fresca— en vez de abrir un canal de
   * realtime propio para esta píldora: el repo ya tiene uno solo por vista
   * y duplicarlo sería la misma deuda que unificó `mergeById`/
   * `reconcileHead` el mismo día. Se descartó también parchar la fila en
   * memoria con el payload del evento (como hace `applyConversationRow` con
   * "Todos"): esa fila puede no estar en ningún lado más que acá, así que
   * no hay evento local que parchar — hay que volver a preguntarle a la
   * base la cabecera de ESTA píldora.
   *
   * `reconcileHead` y no `mergeById`: acá sí hay que soltar filas —una
   * conversación que el compañero acaba de leer debe desaparecer de "No
   * leídas" sin que yo cambie de filtro—. `freshIsComplete` viaja SIEMPRE en
   * `false`: la cabecera que se pide acá tiene el mismo tamaño que la
   * primera página (`pillQueryOptions` sin cursor), nunca el conjunto
   * entero, así que no puede tratarse como completa aunque `serverPager` ya
   * haya llegado a `reachedEnd` — un asesor que bajó cuatro páginas tiene
   * más filas acumuladas que las que esta cabecera puede ver, y marcarla
   * completa las borraría todas. La reconciliación por posición es la que
   * de verdad evita perderlas (ver el comentario grande de `reconcileHead`
   * en `inbox-paging.ts`).
   *
   * No pasa por `serverPager`: es una consulta aparte que nunca toca su
   * candado, su cursor ni su `reachedEnd`. Y solo corre con la píldora
   * activa y con filas ya cargadas (`resolvedState`): sin eso se pagaría una
   * consulta extra por cada pulso aunque nadie esté mirando "Pendientes"/
   * "No leídas"/"Mías", o aunque la píldora todavía no haya resuelto su
   * propia primera página.
   */
  useEffect(() => {
    if (livePulse === livePulseRef.current) return;
    livePulseRef.current = livePulse;

    if (!resolvedOnServer || !resolvedState || resolvedState.rows.length === 0) return;

    const pillFilter = filter;
    // Capturada junto con `pillFilter`, mismo motivo: si la etiqueta cambia
    // mientras esta consulta viaja, la respuesta se pinta con la etiqueta
    // que la pidió, no con la que quedó activa al resolver.
    const pillTagId = activeTagId;
    // Mismo motivo otra vez (T1.3, 5/9/2026): si el orden cambia mientras
    // esta cabecera viaja, se pinta con el orden que la pidió.
    const pillSort = sort;

    // "Sin dueño" es la excepción a todo lo de arriba: su consulta no pagina
    // —resuelve el conjunto entero— así que la respuesta SÍ es completa, y
    // `reconcileHead` puede quedarse solo con lo que sigue calificando. Es lo
    // que hace que un chat reclamado por un asesor desaparezca de la píldora
    // en el mismo pulso, sin esperar a recargar. Además hay que llamarla por
    // su propia vía: `pillQueryOptions` LANZA para esta píldora, y hacerlo
    // dentro de este efecto rompería el render.
    //
    // La etiqueta viaja también en este eco, y no como un filtro aplicado
    // después: sin ella, un pulso vivo con "Sin dueño" + etiqueta activa
    // volvería a pegar en `serverRows` el conjunto SIN filtrar. `matchesTag`
    // lo escondería igual al pintar, pero `serverRows`/`resolvedRows`
    // quedarían con filas de más hasta el próximo pulso.
    // El corte de "hoy" viaja igual que la etiqueta y el orden: capturado
    // junto con `pillFilter` para que, si el visor toca "Ver todo" mientras
    // esta cabecera viaja, la respuesta se pinte con el corte que la pidió.
    const pillDayStart = dayStart;

    const esSinDueno = pillFilter === "unassigned";
    const consulta = esSinDueno
      ? fetchUnassignedConversations(supabase, {
          tagId: pillTagId ?? undefined,
          since: pillDayStart ?? undefined,
        })
      : fetchConversations(
          supabase,
          pillQueryOptions(pillFilter, currentAgent.id, null, pillTagId, pillSort, pillDayStart ?? undefined)
        );

    consulta
      .then((fresh) => {
        setServerRows((current) => {
          // Cambié de píldora (o esta ya no es la consulta activa) mientras
          // la cabecera viajaba: esta respuesta no tiene dónde pintarse.
          if (!current || current.filter !== pillFilter) return current;
          return {
            filter: pillFilter,
            rows: reconcileHead(fresh, current.rows, { freshIsComplete: esSinDueno }),
          };
        });
      })
      .catch(() => {
        // Lo repara el próximo pulso, o el asesor reentrando a la píldora.
      });
  }, [
    livePulse,
    resolvedOnServer,
    resolvedState,
    filter,
    activeTagId,
    sort,
    dayStart,
    currentAgent.id,
    supabase,
  ]);

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

  // "Pendientes", "No leídas" y "Escaladas" llevan conteo
  // (`counts.pending`/`counts.unread`/`counts.escalated`, todos honestos
  // contra la base entera — ver `fetchInboxCounts`). "Mías" no: `counts.mine`
  // existe (D5) pero es volumen histórico del asesor —incluye lo cerrado, lo
  // que archivó hace meses—, no una cola por atender: al lado de la píldora
  // sería ruido, no información. El panel de inicio ya lo enseña bajo su
  // propio nombre ("Tuyas"), que es donde ese número sí responde una
  // pregunta que alguien se está haciendo. "Todos" no lleva conteo por el
  // motivo de siempre (ver el comentario junto a `crm-inbox-head` más abajo).
  const filterItems = useMemo(
    () =>
      availableFilters.map((value) => ({
        value,
        label: INBOX_FILTER_LABELS[value],
        count:
          value === "pending"
            ? counts?.pending
            : value === "unread"
              ? counts?.unread
              : value === "unassigned"
                ? counts?.unassigned
                : value === "escalated"
                  ? counts?.escalated
                  : undefined,
      })),
    [availableFilters, counts]
  );

  const messageHitIds = useMemo(() => new Set(messageHits.keys()), [messageHits]);

  /**
   * Ids que de verdad están sin dueño, para `matchesFilter` (inbox-filters.ts,
   * C1, 5/9/2026). Solo tiene sentido con la píldora "Sin dueño" activa:
   * `resolvedRows` en ese momento son las filas de `fetchUnassignedConversations`
   * —nunca la ventana local—, así que el set son justo sus ids. `null`
   * mientras esa consulta viaja (`resolvedRows` todavía no llegó): la lista
   * no pinta nada de más porque `matchesFilter` falla cerrado sin el set, y
   * mientras tanto la sidebar ya muestra "Buscando…" (`searching`, más abajo)
   * en vez de una lista vacía a medias.
   */
  const unassignedIds = useMemo(
    () => (filter === "unassigned" && resolvedRows ? new Set(resolvedRows.map((c) => c.id)) : null),
    [filter, resolvedRows]
  );

  const filtered = useMemo(
    () =>
      applyInboxFilters(searchableConversations, {
        filter,
        search,
        tagId: activeTagId,
        sort,
        viewer: currentAgent,
        messageHitIds,
        pinnedIds,
        unassignedIds,
        dayStart,
      }),
    [
      searchableConversations,
      filter,
      search,
      activeTagId,
      sort,
      currentAgent,
      messageHitIds,
      pinnedIds,
      unassignedIds,
      dayStart,
    ]
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
   * `loadingMore`) y el de "Pendientes"/"No leídas"/"Mías" (`serverPager`,
   * arriba)— se excluyen entre sí: cada píldora pagina por un solo camino a
   * la vez.
   * Buscar siempre salta el filtro a "Todos" (ver el buscador más arriba) y
   * se queda ahí mientras dura, así que las dos ramas nunca compiten por el
   * mismo filtro al mismo tiempo — no hace falta descartar `trimmedSearch`
   * acá aparte.
   */
  const paginatesLocally = Boolean(onLoadMore) && !trimmedSearch && !resolvedOnServer;

  /**
   * Un solo paginador para el fondo de la lista, venga de donde venga.
   *
   * `status: "ready"` y `retry` en no-op para el camino local NO son un
   * descuido: esa rama solo se activa cuando `!resolvedOnServer` (prop
   * `hasMore`/`onLoadMore` del shell, la píldora "Todos"), y "Todos" abre
   * con su primera página ya resuelta en el servidor (`initialConversations`
   * en `crm-shell.tsx`, sembrada en `allPager` vía `useInboxPager`) — el
   * hook nunca sale a la red por esa primera página, así que jamás puede
   * fallarla. Un error de primera página es, por construcción, imposible en
   * este camino: no hay nada que `retry()` deba hacer.
   *
   * `lastPageFailed` es distinto: a "Todos" SÍ le puede fallar una página
   * SIGUIENTE (cargó la primera, la segunda se cae), el mismo caso que
   * "Pendientes"/"No leídas"/"Mías" resuelven con `serverPager`. Por eso
   * viene de la prop (A.T4, 29/8/2026) y no hardcodeada en `false` como los
   * otros dos campos.
   * Y por eso `loadMore` de esta rama es lo que hay que reintentar —nunca
   * `retry()`, que en este camino no hace nada—: el cursor de "Todos" vive en
   * `allPager` (crm-shell.tsx) y no se movió con el fallo, así que volver a
   * llamar `onLoadMore()` pide exactamente la misma página que se cayó.
   */
  const pager: InboxPagerView = useMemo(
    () =>
      paginatesLocally
        ? {
            status: "ready",
            hasMore,
            loadingMore,
            lastPageFailed,
            loadMore: () => onLoadMore?.(),
            retry: () => {},
          }
        : serverPager,
    [paginatesLocally, hasMore, loadingMore, lastPageFailed, onLoadMore, serverPager]
  );

  /**
   * La primera página de la píldora activa no pudo traerse (A.T5, revisión
   * de código del 29/8/2026): antes esto no se distinguía de "sin nada que
   * mostrar todavía" y un fallo transitorio terminaba pintando el festejo
   * "Todo leído" — el error quedaba disfrazado y sin salida. `pager.status`
   * solo llega a "error" desde `serverPager`
   * ("Pendientes"/"No leídas"/"Mías"): el camino local de "Todos" siempre
   * reporta "ready" por construcción (ver el comentario del `pager` de
   * arriba), así que esta bandera nunca se enciende ahí.
   */
  const pagerFailed = pager.status === "error";

  /**
   * Está esperando la respuesta del servidor para la píldora activa. Un
   * fallo YA es una respuesta (mala, pero respuesta): sin el `&& !pagerFailed`
   * de acá, una primera página que rechaza sin sembrado previo dejaría
   * "Buscando…" pintado para siempre —`resolvedRows` nunca deja de ser
   * `null` porque `useInboxPager` no llama a `onPage` en su camino de
   * error—, y con sembrado, filtrando este caso aparte es lo que le abre
   * paso a `pagerFailed` antes de que `unreadCleared` (que se apoya en
   * `searching`) tenga oportunidad de festejar sobre un error.
   */
  const searching = resolvedOnServer && resolvedRows === null && !pagerFailed;

  /**
   * El único vacío de la bandeja que es una buena noticia: la cola de "No
   * leídas" quedó en cero. Se aísla de los demás vacíos (búsqueda sin
   * resultados, categoría sin uso, "Buscando…") porque es el único que
   * amerita el trato propio de `crm-empty-unread` en crm.css — los otros son
   * ausencias neutras, esta es un cierre.
   *
   * `&& !pagerFailed`: sin esto, una primera página que falla dejando la
   * píldora vacía (nada sembrado, nada acumulado) se leería como "se vació
   * la cola" en vez de "no se pudo consultar" — exactamente el bug que
   * motivó A.T5. El bloque de render de abajo revisa `pagerFailed` ANTES
   * que este festejo de todos modos (precedencia error > buscando > vacío),
   * pero esta bandera se mantiene honesta por su cuenta para que nadie la
   * lea en otro lugar y se lleve el festejo mentiroso con ella.
   */
  const unreadCleared =
    filter === "unread" && !trimmedSearch && !activeTagId && !searching && !pagerFailed;

  /** `.crm-list`, para servir de `root` al `IntersectionObserver` de abajo:
   * sin un root explícito, el observer mide contra el viewport de la
   * ventana, no contra el contenedor con su propio scroll. */
  const listRef = useRef<HTMLDivElement | null>(null);
  /** El sentinel de 1px al fondo de la lista (ver el JSX, antes de avisos/botón). */
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  /**
   * Reemplaza el `handleListScroll` de antes (F7, 4/9/2026): ese medía
   * `scrollHeight - scrollTop - clientHeight < 200` en cada evento de
   * scroll, y con la rueda a velocidad normal en una lista de cientos de
   * filas el fondo vacío alcanzaba a pintarse un instante antes de que la
   * carga lo llenara — la carrera la ganaba el scroll. Un
   * `IntersectionObserver` con `rootMargin: "0px 0px 150% 0px"` dispara con
   * página y media de margen, antes de que el sentinel entre siquiera al
   * viewport real de `.crm-list`.
   *
   * El efecto se recrea entero —nuevo observer, nueva observación— cada vez
   * que cambia `hasMore`/`loadingMore`/`lastPageFailed`/`loadMore`: la
   * primera observación de un `IntersectionObserver` SIEMPRE entrega una
   * entrada inicial con el estado de intersección vigente (parte del
   * estándar, no un detalle de esta implementación), así que recrear el
   * observer justo cuando una página termina de cargar (`loadingMore` pasa
   * de `true` a `false`) reobserva el sentinel y dispara esa entrada de
   * una — es el re-armado que encadena páginas solas cuando la lista quedó
   * corta y el sentinel sigue visible, sin que el asesor mueva la rueda.
   *
   * `typeof IntersectionObserver === "undefined"` corta el efecto sin tocar
   * nada: el botón "Cargar más" (más abajo en el JSX) sigue siendo la única
   * vía en un navegador sin soporte — no se compensa a mano acá.
   */
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const root = listRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!pager.hasMore || pager.loadingMore || pager.lastPageFailed) return;
        if (entries.some((entry) => entry.isIntersecting)) pager.loadMore();
      },
      { root, rootMargin: "0px 0px 150% 0px" }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
    // `pager` entero y no sus cuatro campos sueltos: es un objeto memoizado
    // (`useMemo` de más arriba) que solo cambia de identidad cuando alguno de
    // ellos cambia, así que la frecuencia de recreación del efecto es la
    // misma — esta forma es la que ESLint reconoce como completa.
  }, [pager]);

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
        isPinned={pinnedIds.has(conversation.id)}
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
          El número honesto ahora vive en las píldoras "Pendientes" y "No
          leídas" (prop `counts`, ver `filterItems`); "Mías" y "Todos" se
          quedan sin número antes que repetir la misma mentira.
        */}
        <span style={{ flex: 1 }} />
        {/* T6 (8/9/2026): un contacto ya no depende de que el cliente
            escriba primero. */}
        <button
          type="button"
          className="lm-icon-btn"
          aria-label="Agregar contacto"
          title="Agregar contacto"
          onClick={() => setIsNewContactOpen(true)}
        >
          <UserPlus size={16} />
        </button>
      </header>

      <NewContactModal
        isOpen={isNewContactOpen}
        onOpenChange={setIsNewContactOpen}
        currentAgent={currentAgent}
        onCreated={(conversationId) => onContactCreated?.(conversationId)}
      />

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
          {/*
            El interruptor "Ver todo" (T1, 8/9/2026): sin `onDayScopeChange`
            —el shell no lo pasa, o un test viejo que no conoce esta tarea—
            no se pinta nada, mismo patrón que `onMarkUnread`/`onMarkRead`
            más abajo (`canOpenMenu`). El icono pinta el modo VIGENTE (mismo
            criterio que el botón de orden, al lado: `sort === "recent"`
            pinta la flecha de "recientes primero", no la del próximo clic) y
            el `aria-label` describe la ACCIÓN del clic, la que cambia AL
            OTRO modo.
          */}
          {onDayScopeChange && (
            <button
              type="button"
              className="lm-icon-btn crm-day-scope-btn"
              onClick={() => onDayScopeChange(dayScope === "today" ? "all" : "today")}
              aria-label={dayScope === "today" ? "Ver todo el historial" : "Ver solo hoy"}
              title={
                dayScope === "today"
                  ? "Mostrando solo las conversaciones de hoy"
                  : "Mostrando todo el historial"
              }
            >
              {dayScope === "today" ? <CalendarDays size={16} /> : <History size={16} />}
            </button>
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

      <div className="crm-list" ref={listRef}>
        {sections.map((section) => (
          <Fragment key={section.id}>
            {section.label !== null && (
              <SectionHeader label={section.label} count={section.conversations.length} />
            )}
            {renderItems(section.conversations)}
          </Fragment>
        ))}

        {/* Blanco del IntersectionObserver de arriba: 1px, invisible, al
            final de las filas y antes de cualquier aviso o botón — así
            "intersecta" apenas el fondo real de la lista se acerca, sin
            competir por espacio con el resto del pie. */}
        <div className="crm-list-sentinel" ref={sentinelRef} aria-hidden />

        {/*
          Precedencia error > buscando > vacío (A.T5, revisión de código del
          29/8/2026): antes un fallo de la primera página no se distinguía de
          "no hay nada" y terminaba pintando el festejo "Todo leído" —
          `pagerFailed` se decide arriba de `searching` y `unreadCleared`
          justamente para que ningún vacío neutro ni festivo pueda ganarle al
          error, aunque alguien reordene las ramas de abajo sin leer esto:
          este bloque solo entra a la cadena `trimmedSearch`/`activeTagId`/
          `searching`/`unreadCleared` cuando `pagerFailed` ya es falso.
        */}
        {filtered.length === 0 && (
          <p className={unreadCleared ? "crm-empty crm-empty-unread" : "crm-empty"}>
            {pagerFailed ? (
              <>
                <span>No se pudo traer la bandeja.</span>
                <button type="button" className="crm-pill" onClick={pager.retry}>
                  Reintentar
                </button>
              </>
            ) : trimmedSearch
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

        {/*
          Mismo fallo que arriba, pero con filas YA pintadas encima (sembradas
          o de una carga anterior): el error no puede vaciarlas, así que en
          vez del cartel de página completa esto es un aviso angosto al pie,
          en el mismo lugar donde iría "cargar más" — y nunca compiten por el
          espacio: mientras `pagerFailed` es cierto, `pager.hasMore` es falso
          (`status` no es "ready"), así que el botón de abajo no aparece.
        */}
        {filtered.length > 0 && pagerFailed && (
          <p className="crm-empty crm-pager-error">
            <span>No se pudo traer la bandeja.</span>
            <button type="button" className="crm-pill" onClick={pager.retry}>
              Reintentar
            </button>
          </p>
        )}

        {/* Red de seguridad del scroll: si la lista filtrada quedó corta y no
            genera desplazamiento, el botón sigue ofreciendo el resto. Sirve
            a las dos formas de paginar (`pager`, sea local o de servidor):
            "cargar más" ya es la señal visible de que queda más — el cartel
            de recorte que tenía esta línea (`crm-list-truncated`, tarea del
            29/8/2026 anterior a esta) dejó de hacer falta apenas "No leídas"
            y "Mías" también pudieron ofrecerlo.

            A.T4 (29/8/2026): cuando la que se cayó fue la página SIGUIENTE
            —no la primera, esa la cubre `pagerFailed` arriba— el botón deja
            de fingir que no pasó nada. `pager.hasMore` sigue en `true`
            porque el fallo no toca `reachedEnd` (ver `use-inbox-pager.ts`),
            así que este bloque es el único lugar donde decidir cuál de los
            dos pintar; nunca compiten por espacio con el cartel de arriba
            porque ahí `pager.hasMore` es `false` (el error de primera
            página deja `status: "error"`, y `hasMore` exige `"ready"`).
            Reintentar llama a `pager.loadMore` —NO `pager.retry`—: el cursor
            no se movió con el fallo, así que repetir la misma llamada pide
            exactamente la página que se cayó. */}
        {pager.hasMore && pager.lastPageFailed && (
          <p className="crm-empty crm-pager-error">
            <span>No se pudo traer la página siguiente.</span>
            <button type="button" className="crm-pill" onClick={pager.loadMore}>
              Reintentar
            </button>
          </p>
        )}
        {pager.hasMore && !pager.lastPageFailed && (
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
          isConversationClosed={menu.conversation.status === "closed"}
          onCloseConversation={
            onCloseConversation
              ? () => {
                  patchServerRows(menu.conversation.id, { status: "closed" });
                  onCloseConversation(menu.conversation.id);
                }
              : undefined
          }
          onReopenConversation={
            onReopenConversation
              ? () => {
                  patchServerRows(menu.conversation.id, { status: "open" });
                  onReopenConversation(menu.conversation.id);
                }
              : undefined
          }
          isPinned={pinnedIds.has(menu.conversation.id)}
          pinLimitReached={pinnedIds.size >= 3 && !pinnedIds.has(menu.conversation.id)}
          onPin={() => pinConversationById(menu.conversation.id)}
          onUnpin={() => unpinConversationById(menu.conversation.id)}
          onClose={closeMenu}
        />
      )}
    </>
  );
}
