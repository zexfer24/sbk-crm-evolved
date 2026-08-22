import { useState } from "react";
import { AudioLines, Bot, Download, FileText, ImageOff, Lock, RefreshCw, Reply as ReplyIcon } from "lucide-react";
import type { Message } from "@/lib/types";
import { formatMessageTime } from "@/lib/format";
import { MediaThumb } from "@/components/chat/media-lightbox";
import { DeliveryCheck } from "@/components/chat/delivery-check";
import { FormattedText } from "@/components/chat/formatted-text";

// MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED no siempre está disponible como
// constante global en jsdom, así que usamos el literal con su significado documentado.
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/** Audio con caída controlada: si el archivo nunca cargó, ofrece reintentar en vez de mostrar un reproductor vacío. */
export function AudioContent({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<number | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  if (failed) {
    // Códec/contenedor no soportado por este navegador (ej. Opus/OGG en Safari):
    // reintentar la misma url en el mismo navegador nunca va a funcionar.
    if (errorCode === MEDIA_ERR_SRC_NOT_SUPPORTED) {
      return (
        <div className="crm-audio-error">
          <AudioLines size={14} />
          <span>Este navegador no puede reproducir este audio.</span>
          <a
            className="crm-audio-retry"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Descargar el audio"
          >
            <Download size={12} />
            Descargar
          </a>
        </div>
      );
    }

    return (
      <div className="crm-audio-error">
        <AudioLines size={14} />
        <span>No se pudo cargar el audio.</span>
        <button
          type="button"
          className="crm-audio-retry"
          onClick={() => {
            setFailed(false);
            setErrorCode(undefined);
            setAttempt((a) => a + 1);
          }}
          aria-label="Reintentar carga del audio"
        >
          <RefreshCw size={12} />
          Reintentar
        </button>
      </div>
    );
  }

  return (
    // Los controles nativos de audio se colapsan/deforman por debajo de
    // ~300px de ancho en Chrome/Edge — por eso el mínimo generoso acá.
    <audio
      key={attempt}
      src={url}
      controls
      preload="metadata"
      onError={(event) => {
        setFailed(true);
        setErrorCode(event.currentTarget.error?.code);
      }}
      className="mb-1 h-11 w-full min-w-[300px]"
    />
  );
}

function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

function senderLabel(message: Message): string {
  if (message.direction === "inbound") return "Cliente";
  if (message.isInternalNote) return "Nota interna";
  if (message.senderType === "ai") return "IA";
  return message.senderAgent?.displayName ?? "Agente";
}

const MEDIA_MESSAGE_TYPES = ["image", "video", "sticker", "audio", "document"] as const;

/**
 * El webhook de WhatsApp a veces crea el mensaje sin `media_url` (falló la
 * descarga desde Meta). Antes esto rendía una burbuja completamente vacía
 * —sin ícono, sin texto— indistinguible de un bug para el agente. Ahora se
 * avisa explícitamente que el cliente mandó algo que no se pudo recibir.
 */
function MissingMedia() {
  return (
    <div className="crm-audio-error">
      <ImageOff size={14} />
      <span>El cliente envió un archivo que no se pudo recibir.</span>
    </div>
  );
}

export function MediaContent({ message }: { message: Message }) {
  if (!message.mediaUrl) {
    return MEDIA_MESSAGE_TYPES.includes(message.messageType as (typeof MEDIA_MESSAGE_TYPES)[number]) ? (
      <MissingMedia />
    ) : null;
  }
  switch (message.messageType) {
    case "image":
    case "video":
    case "sticker":
      return (
        <MediaThumb
          items={[
            {
              url: message.mediaUrl,
              type: message.messageType === "video" ? "video" : "image",
              caption: message.content,
            },
          ]}
          index={0}
        />
      );
    case "audio":
      return <AudioContent url={message.mediaUrl} />;
    case "document":
      return (
        <a
          href={message.mediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="crm-doc-link mb-1 flex items-center gap-2 px-2.5 py-2 text-xs underline"
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
                {repliedMessage.content ? (
                  <FormattedText text={repliedMessage.content} />
                ) : (
                  `[${repliedMessage.messageType}]`
                )}
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
          {message.content && <FormattedText text={message.content} />}
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
      <span className="crm-msg-foot px-1 text-[11px] text-muted">
        {formatMessageTime(message.createdAt)}
        {!isCustomer && !isInternalNote && <DeliveryCheck status={message.whatsappStatus} size={13} />}
      </span>
    </div>
  );
}
