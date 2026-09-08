import { useState } from "react";
import {
  AudioLines,
  Bot,
  CornerUpLeft,
  Download,
  FileText,
  ImageOff,
  Lock,
  RefreshCw,
  Reply as ReplyIcon,
  ShoppingCart,
} from "lucide-react";
import type { Agent, Message } from "@/lib/types";
import { formatMessageTime } from "@/lib/format";
import { useLongPress } from "@/lib/use-long-press";
import { failureAction } from "@/lib/whatsapp/failure-reason";
import { MediaThumb } from "@/components/chat/media-lightbox";
import { DeliveryCheck } from "@/components/chat/delivery-check";
import { MessageContextMenu } from "@/components/chat/message-context-menu";
import { FormattedText } from "@/components/chat/formatted-text";
import { QuotedText, QuotedThumb } from "@/components/chat/quoted-content";

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

/**
 * El título del botón/ítem de lista que el cliente respondió (T3.2, 5/9/2026).
 * El webhook ya deja `content = "Respondió: {title}"`; se recorta ese prefijo
 * en vez de duplicar el título en `payload` (que solo trae el `id` de Meta).
 */
function respondedTitle(message: Message): string {
  const prefix = "Respondió: ";
  if (message.content?.startsWith(prefix)) return message.content.slice(prefix.length);
  return message.content ?? message.payload?.id ?? "";
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

/**
 * Un pedido armado desde el catálogo de WhatsApp (T3.2, 5/9/2026):
 * `message.payload.productItems`, no `message.content` — el content ya
 * trae el mismo resumen en prosa (lo que ve el asesor si abre el chat en su
 * teléfono), pero acá se pinta estructurado, ítem por ítem. Meta no manda
 * el nombre del producto, solo el `productRetailerId` (el SKU del catálogo).
 */
function OrderCard({ message }: { message: Message }) {
  const items = message.payload?.productItems ?? [];
  if (items.length === 0) return null;

  const totalPorMoneda = new Map<string, number>();
  for (const item of items) {
    totalPorMoneda.set(item.currency, (totalPorMoneda.get(item.currency) ?? 0) + item.quantity * item.itemPrice);
  }
  const totales = [...totalPorMoneda.entries()].map(([moneda, total]) => `${moneda} ${total.toFixed(2)}`).join(", ");

  return (
    <div className="crm-order-card mb-1 flex flex-col gap-1 rounded-md border border-current/15 p-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <ShoppingCart size={13} />
        <span>Pedido del catálogo</span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((item, index) => (
          <li key={`${item.productRetailerId}-${index}`}>
            {item.quantity}x {item.productRetailerId} — {item.currency} {item.itemPrice.toFixed(2)} c/u
          </li>
        ))}
      </ul>
      <div className="font-medium">Total: {totales}</div>
    </div>
  );
}

interface MessageBubbleProps {
  message: Message;
  repliedMessage?: Message | null;
  onReply?: (message: Message) => void;
  /**
   * Lleva la conversación hasta el mensaje citado. Sin esto la cita se
   * queda como lo que era: un recorte que dice de qué se hablaba, pero que
   * no lleva a ningún lado.
   */
  onJumpToQuoted?: (messageId: string) => void;
  /** Se acaba de llegar hasta acá desde una cita: se señala un momento. */
  isHighlighted?: boolean;
  /**
   * En un canal real, un mensaje saliente sin estado todavía está en camino
   * a Meta (el envío corre después de responder al asesor) y merece el
   * relojito de WhatsApp. En un canal de demo el estado se queda null para
   * siempre y no significa nada: ahí no se pinta.
   */
  pendingDelivery?: boolean;
  /**
   * Abre el selector de plantillas desde la burbuja (T3.3, 5/9/2026): la
   * única acción con gesto propio que ofrece `failureAction` hoy es
   * 131047 (ventana de 24 h vencida). Sin este callback la burbuja igual
   * muestra el motivo en palabras — solo no ofrece el atajo.
   */
  onOpenTemplatePicker?: () => void;
  /**
   * Quién ve el chat, para que el menú contextual pueda ofrecer "Guardar
   * sticker" con dueño (T3a, "Seis frentes del buzón", 8/9/2026). Opcional:
   * sin `agent` la burbuja se comporta exactamente igual que antes.
   */
  agent?: Agent;
}

export function MessageBubble({
  message,
  repliedMessage,
  onReply,
  onJumpToQuoted,
  isHighlighted = false,
  pendingDelivery = false,
  onOpenTemplatePicker,
  agent,
}: MessageBubbleProps) {
  // Antes del retorno de `system_event`: un hook no puede quedar detrás de
  // una salida temprana.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const longPress = useLongPress(setMenuAt);

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
      data-message-id={message.id}
      data-highlight={isHighlighted || undefined}
      className={cx(
        "group crm-msg flex flex-col gap-1",
        isCustomer ? "items-start self-start" : "items-end self-end"
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuAt({ x: event.clientX, y: event.clientY });
      }}
      {...longPress.handlers}
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
          {repliedMessage &&
            // La miniatura enseña cuál foto se citó — la exacta, no la primera
            // del montón — y el clic lleva hasta ella dentro del hilo.
            (onJumpToQuoted ? (
              <button
                type="button"
                className="crm-bubble-quote"
                onClick={() => onJumpToQuoted(repliedMessage.id)}
                aria-label={`Ir al mensaje citado de ${senderLabel(repliedMessage)}`}
              >
                <span className="crm-quote-col">
                  <span className="font-medium">{senderLabel(repliedMessage)}</span>
                  <span className="truncate">
                    <QuotedText message={repliedMessage} />
                  </span>
                </span>
                <QuotedThumb message={repliedMessage} />
              </button>
            ) : (
              <div className="crm-bubble-quote">
                <span className="crm-quote-col">
                  <span className="font-medium">{senderLabel(repliedMessage)}</span>
                  <span className="truncate">
                    <QuotedText message={repliedMessage} />
                  </span>
                </span>
                <QuotedThumb message={repliedMessage} />
              </div>
            ))}

          {message.messageType === "template" && (
            <div className="mb-1 flex items-center gap-1.5 text-xs opacity-80">
              <FileText size={13} />
              <span>Plantilla: {message.templateName}</span>
            </div>
          )}
          {message.messageType === "interactive" && (
            <div className="mb-1 flex items-center gap-1.5 text-xs opacity-80">
              <CornerUpLeft size={13} />
              <span>Respondió a: {respondedTitle(message)}</span>
            </div>
          )}
          {message.messageType === "order" && <OrderCard message={message} />}
          {message.messageType === "unsupported" && (
            // Meta no entrega el contenido real de estos tipos por la API
            // (encuestas, fotos de ver una vez, eventos de calendario…):
            // `content` viene null a propósito (D3, "El cliente que cambió
            // de número", 6/9/2026) y no hay nada que reconstruir acá, solo
            // avisar que existe y mandar al asesor al teléfono.
            <div className="mb-1 flex flex-col gap-0.5 text-xs">
              <span>
                WhatsApp no entrega este mensaje por la API (encuesta, foto de
                ver una vez, evento…). Ábrelo en el teléfono.
              </span>
              {message.payload?.type && <span className="opacity-70">Tipo: {message.payload.type}</span>}
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
          {/* El contenido crudo ya se muestra distinto para estos dos tipos —
              el chip "Respondió a" y la tarjeta de pedido de arriba— así que
              acá se omite para no repetir la misma frase dos veces. */}
          {message.content &&
            message.messageType !== "interactive" &&
            message.messageType !== "order" && <FormattedText text={message.content} />}

          {/* Colgando del borde de abajo, como en WhatsApp: la reacción es
              algo que le pasa a este mensaje, no un mensaje aparte. */}
          {message.reactionEmoji && (
            <span
              className="crm-bubble-reaction"
              role="img"
              aria-label={`El cliente reaccionó con ${message.reactionEmoji}`}
              title={`Reaccionó con ${message.reactionEmoji}`}
            >
              {message.reactionEmoji}
            </span>
          )}
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
      {menuAt && (
        <MessageContextMenu
          position={menuAt}
          message={message}
          onReply={onReply}
          onClose={() => setMenuAt(null)}
          agent={agent}
        />
      )}

      <span className="crm-msg-foot px-1 text-[11px] text-muted">
        {formatMessageTime(message.createdAt)}
        {!isCustomer && !isInternalNote && (
          <DeliveryCheck
            status={message.whatsappStatus}
            detail={message.whatsappError}
            pending={pendingDelivery}
            size={13}
          />
        )}
      </span>

      {/* El motivo, escrito, no sólo en el tooltip del icono.
          El triángulo rojo a secas sugiere una sola cosa —reintentar— y el
          asesor la hacía cinco veces seguidas contra un número que no existe.
          Puesto en palabras debajo del mensaje, "el número no está en WhatsApp"
          y "pasaron 24 h" dejan de verse igual. */}
      {!isCustomer && !isInternalNote && message.whatsappStatus === "failed" && message.whatsappError && (
        <span className="crm-msg-failure px-1 text-[11px]">{message.whatsappError}</span>
      )}

      {/* La acción con gesto propio (T3.3, 5/9/2026): hoy solo la ventana de
          24 h vencida (131047) tiene un atajo que hacer desde acá mismo —
          abrir el selector de plantillas — en vez de mandar al asesor a
          buscarlo con el ícono de la barra. */}
      {!isCustomer &&
        !isInternalNote &&
        message.whatsappStatus === "failed" &&
        onOpenTemplatePicker &&
        failureAction(message.whatsappErrorCode) === "abrir_plantillas" && (
          <button
            type="button"
            className="crm-msg-failure-action px-1 text-[11px] underline underline-offset-2"
            onClick={onOpenTemplatePicker}
          >
            Abrir plantillas
          </button>
        )}
    </div>
  );
}
