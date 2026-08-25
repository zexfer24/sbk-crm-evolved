import type { Message } from "@/lib/types";
import { FormattedText } from "@/components/chat/formatted-text";

/**
 * Cómo nombrar lo citado cuando no tiene texto. "[image]" era jerga de la
 * base de datos en medio de la conversación; el asesor habla de fotos.
 */
const TYPE_LABELS: Partial<Record<Message["messageType"], string>> = {
  image: "Foto",
  video: "Video",
  sticker: "Sticker",
  audio: "Audio",
  document: "Documento",
  template: "Plantilla",
};

export function quotedTypeLabel(message: Message): string {
  return TYPE_LABELS[message.messageType] ?? `[${message.messageType}]`;
}

/**
 * Miniatura de la foto o el video citado — la exacta, no una cualquiera.
 *
 * Cuando el cliente cita una de las cinco fotos que mandó, la cita tiene que
 * enseñar cuál: el texto "Foto" solo dice que era una foto, y en una venta de
 * repuestos la diferencia entre una foto y otra es justamente la consulta.
 * Null cuando no hay nada que mostrar (sin archivo, o no es visual).
 */
export function QuotedThumb({ message }: { message: Message }) {
  const visual =
    message.mediaUrl &&
    (message.messageType === "image" || message.messageType === "sticker" || message.messageType === "video");
  if (!visual) return null;

  return message.messageType === "video" ? (
    <video className="crm-quote-thumb" src={message.mediaUrl!} muted playsInline preload="metadata" />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="crm-quote-thumb" src={message.mediaUrl!} alt="" loading="lazy" />
  );
}

/** El texto de la cita: lo que decía el mensaje, o qué era cuando no decía nada. */
export function QuotedText({ message }: { message: Message }) {
  return message.content ? <FormattedText text={message.content} /> : <>{quotedTypeLabel(message)}</>;
}
