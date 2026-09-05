import { Fragment } from "react";
import { Clock, Pin } from "lucide-react";
import type { ConversationSummary } from "@/lib/types";
import { awaitingReply, contactName, initials } from "@/lib/dashboard";
import { formatConversationTimestamp } from "@/lib/format";
import { isUnread as computeIsUnread } from "@/lib/inbox-filters";
import { highlightSegments, snippetAround, type MessageHit } from "@/lib/message-search";
import { hoursUntilWindowCloses } from "@/lib/whatsapp-window";
import { DeliveryCheck } from "@/components/chat/delivery-check";
import { useClock } from "@/lib/use-clock";
import { useLongPress } from "@/lib/use-long-press";

/**
 * Cuánto le queda a la ventana de 24h, en la forma compacta de la píldora de
 * la fila: neutro mientras sobra margen, ámbar bajo las 4h (mismo corte que
 * `WindowCountdown` en el chat, que se pone en ámbar bajo 2h — acá el umbral
 * es más generoso porque la fila se ve de reojo, sin abrir el chat), rojo si
 * la ventana ya cerró y solo entra una plantilla.
 */
function windowChip(
  lastCustomerMessageAt: string | null,
  now: Date
): { label: string; urgency: "neutral" | "warning" | "danger" } {
  const hours = hoursUntilWindowCloses(lastCustomerMessageAt, now);
  if (hours <= 0) return { label: "cerrada", urgency: "danger" };
  if (hours < 4) return { label: `${Math.max(1, Math.round(hours))} h`, urgency: "warning" };
  return { label: `${Math.round(hours)} h`, urgency: "neutral" };
}

interface ConversationListItemProps {
  conversation: ConversationSummary;
  isSelected: boolean;
  onSelect: () => void;
  /**
   * Pide el menú contextual en un punto de la pantalla. En escritorio lo
   * dispara el click derecho; en el teléfono, donde no hay click derecho,
   * mantener el dedo encima.
   */
  onOpenMenu?: (position: { x: number; y: number }) => void;
  /** Mensaje del historial que coincide con lo buscado. Null si no hay búsqueda o si la coincidencia fue por nombre o número. */
  messageHit?: MessageHit | null;
  /** Palabras a resaltar dentro del fragmento. */
  searchTerms?: string[];
  /**
   * El agente que mira la fijó (T2.2 del plan "La bandeja que no pierde",
   * 5/9/2026, `conversation_pins`). Solo pinta un pequeño ícono junto al
   * nombre — el orden (fijadas primero) lo decide `applyInboxFilters`
   * (`inbox-filters.ts`), no este componente.
   */
  isPinned?: boolean;
}

export function ConversationListItem({
  conversation,
  isSelected,
  onSelect,
  onOpenMenu,
  messageHit = null,
  searchTerms = [],
  isPinned = false,
}: ConversationListItemProps) {
  const name = contactName(conversation);
  // Dos caminos para lo mismo: quedaron mensajes por leer, o el asesor lo
  // apartó a propósito para volver. El chat se ve igual de pendiente en los
  // dos casos, pero solo el primero tiene un número que mostrar. Misma
  // definición que la píldora "No leídas" (`isUnread` de inbox-filters.ts).
  const isUnread = computeIsUnread(conversation);
  // El check habla de lo que mandamos nosotros. En un mensaje entrante no
  // hay nada que confirmar: el estado es del emisor, y ahí el emisor es el cliente.
  const showCheck = conversation.lastMessageDirection === "outbound";
  const tags = conversation.contact.tags;

  // Cuando la conversación aparece por algo que se dijo adentro, la línea de
  // preview muestra ESE mensaje y no el último: mostrar el último dejaría al
  // usuario sin saber por qué el chat está en la lista. El check de entrega se
  // calla, porque describe el último mensaje y ya no es lo que se está viendo.
  const hitSnippet = messageHit ? snippetAround(messageHit.content, searchTerms) : null;

  // Al minuto, no al segundo: que la píldora avance sola sin que cada fila de
  // la bandeja se vuelva a pintar en cada tick de reloj.
  const clockMinute = useClock();
  const isAwaitingReply = awaitingReply(conversation);
  const chip = isAwaitingReply ? windowChip(conversation.lastCustomerMessageAt, new Date(clockMinute)) : null;

  const longPress = useLongPress((position) => onOpenMenu?.(position));

  return (
    <button
      className="crm-thread"
      type="button"
      aria-current={isSelected}
      onClick={() => {
        // Soltar el dedo tras una pulsación larga también es un click: sin
        // esto se abriría el menú y detrás la conversación.
        if (longPress.consumeClick()) return;
        onSelect();
      }}
      onContextMenu={
        onOpenMenu &&
        ((event) => {
          event.preventDefault();
          onOpenMenu({ x: event.clientX, y: event.clientY });
        })
      }
      {...(onOpenMenu ? longPress.handlers : {})}
    >
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
            {isPinned && (
              <Pin
                size={11}
                className="crm-thread-pin"
                aria-label="Fijada"
                role="img"
              />
            )}
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
          {conversation.unreadCount > 0 ? (
            <span className="crm-thread-badge lm-num">{conversation.unreadCount}</span>
          ) : (
            isUnread && (
              <span className="crm-thread-dot" role="img" aria-label="Sin leer" title="Sin leer" />
            )
          )}
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

        {chip && (
          <span className="crm-thread-window" data-urgency={chip.urgency}>
            <Clock size={11} aria-hidden="true" />
            {chip.label}
          </span>
        )}

        {conversation.assignedAgent && (
          <span className="crm-thread-agent">{conversation.assignedAgent.displayName}</span>
        )}
      </span>
    </button>
  );
}
