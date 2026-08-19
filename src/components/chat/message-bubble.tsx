import { Bot, FileText, Lock, Reply as ReplyIcon } from "lucide-react";
import type { Message } from "@/lib/types";
import { formatMessageTime } from "@/lib/format";

function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

function senderLabel(message: Message): string {
  if (message.direction === "inbound") return "Cliente";
  if (message.isInternalNote) return "Nota interna";
  if (message.senderType === "ai") return "IA";
  return message.senderAgent?.displayName ?? "Agente";
}

function MediaContent({ message }: { message: Message }) {
  if (!message.mediaUrl) return null;
  switch (message.messageType) {
    case "image":
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={message.mediaUrl}
          alt={message.content ?? "Imagen"}
          className="mb-1 max-h-72 w-full rounded-field object-cover"
        />
      );
    case "video":
      return <video src={message.mediaUrl} controls className="mb-1 max-h-72 w-full rounded-field" />;
    case "audio":
      // Los controles nativos de audio se colapsan/deforman por debajo de
      // ~300px de ancho en Chrome/Edge — por eso el mínimo generoso acá.
      return (
        <audio
          src={message.mediaUrl}
          controls
          preload="metadata"
          className="mb-1 h-11 w-full min-w-[300px]"
        />
      );
    case "document":
      return (
        <a
          href={message.mediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-1 flex items-center gap-2 rounded-field bg-black/5 px-2.5 py-2 text-xs underline"
        >
          <FileText size={14} />
          {message.content || "Ver documento"}
        </a>
      );
    default:
      return null;
  }
}

interface MessageBubbleProps {
  message: Message;
  repliedMessage?: Message | null;
  onReply?: (message: Message) => void;
}

export function MessageBubble({ message, repliedMessage, onReply }: MessageBubbleProps) {
  if (message.messageType === "system_event") {
    return (
      <div className="flex justify-center py-1">
        <span className="crm-system-note">
          {message.content} · {formatMessageTime(message.createdAt)}
        </span>
      </div>
    );
  }

  const isCustomer = message.direction === "inbound";
  const isAi = message.senderType === "ai";
  const isInternalNote = message.isInternalNote;

  return (
    <div
      className={cx(
        "group crm-msg flex flex-col gap-1",
        isCustomer ? "items-start self-start" : "items-end self-end"
      )}
    >
      {!isCustomer && (
        <span className="px-1 text-[11px] font-medium tracking-wide text-muted uppercase">
          {senderLabel(message)}
        </span>
      )}
      <div className={cx("crm-msg-row flex items-center gap-1", isCustomer ? "flex-row" : "flex-row-reverse")}>
        <div
          className="crm-bubble"
          data-from={
            isCustomer ? "customer" : isInternalNote ? "note" : isAi ? "ai" : "agent"
          }
        >
          {repliedMessage && (
            <div className="crm-bubble-quote">
              <p className="font-medium">{senderLabel(repliedMessage)}</p>
              <p className="truncate">
                {repliedMessage.content || `[${repliedMessage.messageType}]`}
              </p>
            </div>
          )}

          {message.messageType === "template" && (
            <div className="mb-1 flex items-center gap-1.5 text-xs opacity-80">
              <FileText size={13} />
              <span>Plantilla: {message.templateName}</span>
            </div>
          )}
          {isAi && (
            <div className="mb-1 flex items-center gap-1.5 text-xs opacity-70">
              <Bot size={13} />
            </div>
          )}
          {isInternalNote && (
            <div className="mb-1 flex items-center gap-1.5 text-xs">
              <Lock size={12} />
              <span>Solo visible para agentes</span>
            </div>
          )}
          <MediaContent message={message} />
          {message.content}
        </div>

        {onReply && (
          <button
            type="button"
            onClick={() => onReply(message)}
            aria-label="Responder citando este mensaje"
            className="lm-icon-btn shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            style={{ width: 28, height: 28 }}
          >
            <ReplyIcon size={14} />
          </button>
        )}
      </div>
      <span className="px-1 text-[11px] text-muted">{formatMessageTime(message.createdAt)}</span>
    </div>
  );
}
