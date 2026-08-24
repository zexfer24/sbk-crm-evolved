"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, UserPlus, UserMinus } from "lucide-react";
import { toast } from "@heroui/react";
import type { Agent, Conversation, Message, QuickReply, WhatsappTemplate } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { contactName, initials } from "@/lib/dashboard";
import { assignToMe, intervene, setAiEnabled, unassign } from "@/lib/mutations";
import { groupMessagesForRender } from "@/lib/message-grouping";
import { AiStatusBanner } from "@/components/chat/ai-status-banner";
import { MessageBubble } from "@/components/chat/message-bubble";
import { MediaGroup } from "@/components/chat/media-group";
import { Composer } from "@/components/chat/composer";

interface ChatPanelProps {
  conversation: Conversation;
  messages: Message[];
  templates: WhatsappTemplate[];
  quickReplies: QuickReply[];
  currentAgent: Agent;
  /** Queda historial más viejo que el que se está mostrando. */
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  /** El hilo todavía viene en camino: se pinta un esqueleto en vez de un vacío. */
  loadingMessages?: boolean;
  onLoadOlderMessages?: () => void;
  /** Vuelve a la lista. Solo se muestra cuando la bandeja no cabe al lado. */
  onBack: () => void;
}

export function ChatPanel({
  conversation,
  messages,
  templates,
  quickReplies,
  currentAgent,
  hasOlderMessages = false,
  loadingOlderMessages = false,
  loadingMessages = false,
  onLoadOlderMessages,
  onBack,
}: ChatPanelProps) {
  const [isIntervening, setIsIntervening] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /** Mensaje al que se acaba de saltar desde una cita, para señalarlo. */
  const [jumpedToId, setJumpedToId] = useState<string | null>(null);

  /**
   * Lleva la conversación hasta el mensaje citado.
   *
   * Una cita dice de qué se hablaba, pero en un hilo largo saber "de qué" sin
   * poder volver "a dónde" sirve de poco: el asesor termina desplazando a
   * mano hasta encontrarlo.
   *
   * Al abrir un chat solo se cargan los últimos mensajes, así que el citado
   * puede haber quedado más atrás. En ese caso se dice, en vez de que el
   * clic no haga nada y parezca que está roto.
   */
  function jumpToMessage(messageId: string) {
    const target = listRef.current?.querySelector(`[data-message-id="${messageId}"]`);
    if (!target) {
      toast.danger("Ese mensaje quedó más atrás: cargá los mensajes anteriores para verlo.");
      return;
    }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    setJumpedToId(messageId);
  }

  const messagesById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const renderItems = useMemo(() => groupMessagesForRender(messages), [messages]);

  // Limpia la cita pendiente al cambiar de conversación (ajuste de estado
  // durante el render, en vez de un efecto, siguiendo la guía de React).
  const [lastConversationId, setLastConversationId] = useState(conversation.id);
  if (conversation.id !== lastConversationId) {
    setLastConversationId(conversation.id);
    setReplyingTo(null);
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, conversation.id]);

  async function handleIntervene() {
    setIsIntervening(true);
    try {
      const supabase = createClient();
      await intervene(supabase, conversation.id, currentAgent);
      toast.success("Interviniste la conversación");
    } catch {
      toast.danger("No se pudo intervenir la conversación.");
    } finally {
      setIsIntervening(false);
    }
  }

  async function handleToggleAi() {
    try {
      const supabase = createClient();
      await setAiEnabled(supabase, conversation.id, currentAgent, !conversation.aiEnabled);
    } catch {
      toast.danger("No se pudo cambiar el estado de la IA.");
    }
  }

  async function handleAssignmentToggle() {
    try {
      const supabase = createClient();
      if (conversation.assignedAgent) {
        await unassign(supabase, conversation.id, currentAgent, conversation.assignedAgent.displayName);
      } else {
        await assignToMe(supabase, conversation.id, currentAgent);
      }
    } catch {
      toast.danger("No se pudo actualizar la asignación.");
    }
  }

  const name = contactName(conversation);

  return (
    <>
      <header className="crm-chat-head">
        <div className="crm-chat-who">
          <button
            className="lm-icon-btn crm-back"
            type="button"
            onClick={onBack}
            aria-label="Volver a la bandeja"
          >
            <ArrowLeft size={18} />
          </button>
          <span className="lm-avatar" data-size="lg" aria-hidden="true">
            {initials(name)}
          </span>
          <div style={{ minWidth: 0 }}>
            <p className="crm-chat-name">{name}</p>
            <div className="crm-chat-meta">
              <span className="lm-num">{conversation.contact.phoneNumber}</span>
              <span className="crm-chat-sep" aria-hidden="true">·</span>
              <span>{conversation.channel.label}</span>
            </div>
          </div>
        </div>

        <div className="crm-chat-actions">
          <span className="lm-chip" style={assignedChipStyle(Boolean(conversation.assignedAgent))}>
            <span className="lm-chip-dot" />
            {conversation.assignedAgent?.displayName ?? "Sin asignar"}
          </span>
          <button className="crm-pill" type="button" onClick={handleAssignmentToggle}>
            {conversation.assignedAgent ? <UserMinus size={14} /> : <UserPlus size={14} />}
            {conversation.assignedAgent ? "Desasignar" : "Asignarme"}
          </button>
        </div>
      </header>

      <AiStatusBanner
        aiEnabled={conversation.aiEnabled}
        isIntervening={isIntervening}
        onIntervene={handleIntervene}
        onToggleAi={handleToggleAi}
      />

      <div className="crm-messages" ref={listRef}>
        {loadingMessages && (
          // Un chat vacío y un chat que todavía no llegó se ven igual, y no
          // son lo mismo: sin esto, abrir una conversación parpadea en
          // "no hay nada acá" antes de mostrar la conversación.
          <div className="skel-chat" role="status" aria-busy="true" aria-label="Cargando la conversación">
            {[68, 44, 92, 56].map((ancho, i) => (
              <span
                className="skel skel-bubble"
                data-side={i % 2 === 0 ? "in" : "out"}
                style={{ width: `${ancho}%` }}
                key={i}
              />
            ))}
          </div>
        )}
        {hasOlderMessages && onLoadOlderMessages && (
          <div className="crm-older-row">
            <button
              type="button"
              className="crm-older-btn"
              onClick={onLoadOlderMessages}
              disabled={loadingOlderMessages}
            >
              {loadingOlderMessages ? "Cargando…" : "Ver mensajes anteriores"}
            </button>
          </div>
        )}
        {renderItems.map((item) => {
          if (item.kind === "date-separator") {
            return (
              <div className="crm-day-sep" key={`day-${item.key}`} role="separator">
                <span>{item.label}</span>
              </div>
            );
          }
          if (item.kind === "media-group") {
            return <MediaGroup key={item.messages[0].id} messages={item.messages} />;
          }
          return (
            <MessageBubble
              key={item.message.id}
              message={item.message}
              repliedMessage={
                item.message.replyToMessageId ? (messagesById.get(item.message.replyToMessageId) ?? null) : null
              }
              onReply={setReplyingTo}
              onJumpToQuoted={jumpToMessage}
              isHighlighted={item.message.id === jumpedToId}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>

      <Composer
        conversation={conversation}
        templates={templates}
        quickReplies={quickReplies}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
      />
    </>
  );
}

/** Verde cuando hay dueño del caso, gris cuando todavía no lo tiene. */
function assignedChipStyle(assigned: boolean) {
  return assigned
    ? { background: "rgba(34, 160, 107, .12)", color: "var(--lm-good)" }
    : { background: "var(--lm-sunken)", color: "var(--lm-muted)" };
}
