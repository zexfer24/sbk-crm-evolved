import type { Conversation } from "@/lib/types";
import { contactName, initials } from "@/lib/dashboard";
import { formatConversationTimestamp } from "@/lib/format";
import { DeliveryCheck } from "@/components/chat/delivery-check";

interface ConversationListItemProps {
  conversation: Conversation;
  isSelected: boolean;
  onSelect: () => void;
}

export function ConversationListItem({ conversation, isSelected, onSelect }: ConversationListItemProps) {
  const name = contactName(conversation);
  const isUnread = conversation.unreadCount > 0;
  // El check habla de lo que mandamos nosotros. En un mensaje entrante no
  // hay nada que confirmar: el estado es del emisor, y ahí el emisor es el cliente.
  const showCheck = conversation.lastMessageDirection === "outbound";
  const tags = conversation.contact.tags;

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
          {showCheck && <DeliveryCheck status={conversation.lastMessageStatus} size={13} />}
          <span className="crm-thread-preview" data-unread={isUnread}>
            {conversation.lastMessagePreview ?? "Sin mensajes todavía"}
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
