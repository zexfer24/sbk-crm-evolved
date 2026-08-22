"use client";

import { useMemo, useState } from "react";
import { ArrowDownWideNarrow, ArrowUpWideNarrow, Search, Tag as TagIcon } from "lucide-react";
import type { Agent, Conversation, InboxFilter, InboxSort, Tag } from "@/lib/types";
import { initials } from "@/lib/dashboard";
import {
  applyInboxFilters,
  filtersForRole,
  INBOX_FILTER_LABELS,
  INBOX_SORT_LABELS,
} from "@/lib/inbox-filters";
import { ConversationListItem } from "@/components/inbox/conversation-list-item";
import { BcvRateChip, type BcvRateSummary } from "@/components/inbox/bcv-rate-chip";
import { FilterScroller } from "@/components/inbox/filter-scroller";
import { SlidingPills } from "@/components/sliding-pills";

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
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  currentAgent: Agent;
  /** Todas las etiquetas creadas, para la barra de filtro por etiqueta. */
  allTags: Tag[];
  bcvRate: BcvRateSummary | null;
}

export function InboxSidebar({
  conversations,
  selectedId,
  onSelect,
  currentAgent,
  allTags,
  bcvRate,
}: InboxSidebarProps) {
  const availableFilters = useMemo(() => filtersForRole(currentAgent.role), [currentAgent.role]);

  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<InboxSort>("recent");
  const [tagId, setTagId] = useState<string | null>(null);

  const filterItems = useMemo(
    () => availableFilters.map((value) => ({ value, label: INBOX_FILTER_LABELS[value] })),
    [availableFilters]
  );

  const filtered = useMemo(
    () => applyInboxFilters(conversations, { filter, search, tagId, sort, viewer: currentAgent }),
    [conversations, filter, search, tagId, sort, currentAgent]
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

  const isSplit = SPLIT_READ_UNREAD.includes(filter);
  const unreadGroup = isSplit ? filtered.filter((c) => c.unreadCount > 0) : [];
  const readGroup = isSplit ? filtered.filter((c) => c.unreadCount === 0) : [];

  function renderItems(list: Conversation[]) {
    return list.map((conversation) => (
      <ConversationListItem
        key={conversation.id}
        conversation={conversation}
        isSelected={conversation.id === selectedId}
        onSelect={() => onSelect(conversation.id)}
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
              placeholder="Buscar contacto o número"
              aria-label="Buscar contacto o número"
            />
          </div>
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

        {visibleTags.length > 0 && (
          <div className="crm-tag-filter" role="group" aria-label="Filtrar por etiqueta">
            <button
              type="button"
              className="crm-tag crm-tag-btn"
              data-active={tagId === null}
              onClick={() => setTagId(null)}
              aria-pressed={tagId === null}
            >
              <TagIcon size={11} />
              Todas
            </button>
            {visibleTags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className="crm-tag crm-tag-btn"
                data-color={tag.color}
                data-active={tagId === tag.id}
                // Volver a tocar la etiqueta activa quita el filtro: es el
                // gesto que la gente prueba antes de buscar el botón "Todas".
                onClick={() => setTagId(tagId === tag.id ? null : tag.id)}
                aria-pressed={tagId === tag.id}
              >
                {tag.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="crm-list">
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
            {search.trim()
              ? "Ningún contacto coincide con esa búsqueda."
              : tagId
                ? "Ninguna conversación tiene esa etiqueta."
                : "No hay conversaciones en este filtro."}
          </p>
        )}
      </div>
    </>
  );
}
