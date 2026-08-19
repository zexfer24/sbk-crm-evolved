"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { Agent, Conversation, InboxFilter } from "@/lib/types";
import { initials } from "@/lib/dashboard";
import { ConversationListItem } from "@/components/inbox/conversation-list-item";

const FILTERS: { value: InboxFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "assigned", label: "Asignados" },
];

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
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  currentAgent: Agent;
}

export function InboxSidebar({ conversations, selectedId, onSelect, currentAgent }: InboxSidebarProps) {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let list = conversations;
    if (filter === "assigned") list = list.filter((c) => c.assignedAgent !== null);

    const query = search.trim().toLowerCase();
    if (query) {
      list = list.filter((c) => {
        const name = c.contact.displayName ?? c.contact.profileName ?? "";
        return (
          name.toLowerCase().includes(query) || c.contact.phoneNumber.toLowerCase().includes(query)
        );
      });
    }

    return list;
  }, [conversations, filter, search]);

  // Dentro de "Asignados" se muestran dos secciones con encabezado propio:
  // no leídos arriba, leídos abajo (cada una conserva el orden de más
  // reciente a más antiguo).
  const unreadGroup = filter === "assigned" ? filtered.filter((c) => c.unreadCount > 0) : [];
  const readGroup = filter === "assigned" ? filtered.filter((c) => c.unreadCount === 0) : [];

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

      <div className="crm-inbox-tools">
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

        <div className="crm-filters">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              className="crm-filter"
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="crm-list">
        {filter === "assigned" ? (
          <>
            {unreadGroup.length > 0 && (
              <>
                <SectionHeader label="No leídos" count={unreadGroup.length} />
                {unreadGroup.map((conversation) => (
                  <ConversationListItem
                    key={conversation.id}
                    conversation={conversation}
                    isSelected={conversation.id === selectedId}
                    onSelect={() => onSelect(conversation.id)}
                  />
                ))}
              </>
            )}
            {readGroup.length > 0 && (
              <>
                <SectionHeader label="Leídos" count={readGroup.length} />
                {readGroup.map((conversation) => (
                  <ConversationListItem
                    key={conversation.id}
                    conversation={conversation}
                    isSelected={conversation.id === selectedId}
                    onSelect={() => onSelect(conversation.id)}
                  />
                ))}
              </>
            )}
          </>
        ) : (
          filtered.map((conversation) => (
            <ConversationListItem
              key={conversation.id}
              conversation={conversation}
              isSelected={conversation.id === selectedId}
              onSelect={() => onSelect(conversation.id)}
            />
          ))
        )}

        {filtered.length === 0 && (
          <p className="crm-empty">
            {search.trim()
              ? "Ningún contacto coincide con esa búsqueda."
              : "No hay conversaciones en este filtro."}
          </p>
        )}
      </div>
    </>
  );
}
