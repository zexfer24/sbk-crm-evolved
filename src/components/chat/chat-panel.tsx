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
  onLoadOlderMessages,
  onBack,
}: ChatPanelProps) {
  const [isIntervening, setIsIntervening] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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

      <div className="crm-messages">
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
