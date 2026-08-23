import { Fragment } from "react";
import type { Conversation } from "@/lib/types";
import { contactName, initials } from "@/lib/dashboard";
import { formatConversationTimestamp } from "@/lib/format";
import { highlightSegments, snippetAround, type MessageHit } from "@/lib/message-search";
import { DeliveryCheck } from "@/components/chat/delivery-check";

interface ConversationListItemProps {
  conversation: Conversation;
  isSelected: boolean;
  onSelect: () => void;
  /** Mensaje del historial que coincide con lo buscado. Null si no hay búsqueda o si la coincidencia fue por nombre o número. */
  messageHit?: MessageHit | null;
  /** Palabras a resaltar dentro del fragmento. */
  searchTerms?: string[];
}

export function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
  messageHit = null,
  searchTerms = [],
}: ConversationListItemProps) {
  const name = contactName(conversation);
  const isUnread = conversation.unreadCount > 0;
  // El check habla de lo que mandamos nosotros. En un mensaje entrante no
  // hay nada que confirmar: el estado es del emisor, y ahí el emisor es el cliente.
  const showCheck = conversation.lastMessageDirection === "outbound";
  const tags = conversation.contact.tags;

  // Cuando la conversación aparece por algo que se dijo adentro, la línea de
  // preview muestra ESE mensaje y no el último: mostrar el último dejaría al
  // usuario sin saber por qué el chat está en la lista. El check de entrega se
  // calla, porque describe el último mensaje y ya no es lo que se está viendo.
  const hitSnippet = messageHit ? snippetAround(messageHit.content, searchTerms) : null;

  return (
    <button className="crm-thread" type="button" onClick={onSelect} aria-current={isSelected}>
      <span className="crm-thread-avatar">
        <span className="lm-avatar" aria-hidden="true">
          {initials(name)}
        </span>
        <span
          className="crm-thread-pip"
          data-ai={conversation.aiEnabled ? "on" : "off"}
          role="img"
          aria-label={conversation.aiEnabled ? "La IA responde" : "La IA está pausada"}
          title={conversation.aiEnabled ? "La IA responde" : "La IA está pausada"}
        />
      </span>

      <span className="crm-thread-body">
        <span className="crm-thread-row">
          <span className="crm-thread-name" data-unread={isUnread}>
            {name}
          </span>
          <span className="crm-thread-time lm-num">
            {formatConversationTimestamp(conversation.lastMessageAt)}
          </span>
        </span>

        <span className="crm-thread-row crm-thread-row-preview">
          {showCheck && !hitSnippet && (
            <DeliveryCheck status={conversation.lastMessageStatus} size={13} />
          )}
          <span className="crm-thread-preview" data-unread={isUnread} data-hit={hitSnippet !== null}>
            {hitSnippet !== null
              ? highlightSegments(hitSnippet, searchTerms).map((segment, index) =>
                  segment.match ? (
                    <mark className="crm-thread-mark" key={index}>
                      {segment.text}
                    </mark>
                  ) : (
                    <Fragment key={index}>{segment.text}</Fragment>
                  )
                )
              : (conversation.lastMessagePreview ?? "Sin mensajes todavía")}
          </span>
          {isUnread && <span className="crm-thread-badge lm-num">{conversation.unreadCount}</span>}
        </span>

        {tags.length > 0 && (
          <span className="crm-thread-tags">
            {tags.map((tag) => (
              <span className="crm-tag" data-color={tag.color} key={tag.id}>
                {tag.label}
              </span>
            ))}
          </span>
        )}

        {conversation.assignedAgent && (
          <span className="crm-thread-agent">{conversation.assignedAgent.displayName}</span>
        )}
      </span>
    </button>
  );
}
