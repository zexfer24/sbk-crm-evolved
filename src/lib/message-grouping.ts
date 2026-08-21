import type { Message } from "@/lib/types";
import { dayKey, formatDaySeparator } from "@/lib/format";

const GROUP_WINDOW_MS = 2 * 60 * 1000;
const GROUPABLE_TYPES = new Set(["image", "video"]);

export type ChatRenderItem =
  | { kind: "message"; message: Message }
  | { kind: "media-group"; messages: Message[] }
  | { kind: "date-separator"; key: string; label: string };

/**
 * Agrupa fotos/videos consecutivos del mismo emisor (enviados con pocos
 * minutos de diferencia) en una sola "galería" para mostrarlos como
 * carrusel deslizable en vez de burbujas sueltas, e inserta un separador
 * de fecha (como en WhatsApp Web) cada vez que cambia el día del calendario
 * local, para saber siempre de qué fecha se está hablando.
 */
export function groupMessagesForRender(messages: Message[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  let buffer: Message[] = [];
  let lastDayKey: string | null = null;

  function flush() {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      items.push({ kind: "message", message: buffer[0] });
    } else {
      items.push({ kind: "media-group", messages: buffer });
    }
    buffer = [];
  }

  for (const message of messages) {
    const key = dayKey(message.createdAt);
    if (key !== lastDayKey) {
      flush();
      items.push({ kind: "date-separator", key, label: formatDaySeparator(message.createdAt) });
      lastDayKey = key;
    }

    const isGroupable =
      !message.replyToMessageId &&
      !message.isInternalNote &&
      GROUPABLE_TYPES.has(message.messageType) &&
      !!message.mediaUrl;

    const last = buffer[buffer.length - 1];
    const sameBucket =
      last &&
      last.direction === message.direction &&
      last.senderType === message.senderType &&
      last.senderAgent?.id === message.senderAgent?.id &&
      new Date(message.createdAt).getTime() - new Date(last.createdAt).getTime() < GROUP_WINDOW_MS;

    if (isGroupable && (buffer.length === 0 || sameBucket)) {
      buffer.push(message);
      continue;
    }

    flush();

    if (isGroupable) {
      buffer.push(message);
    } else {
      items.push({ kind: "message", message });
    }
  }

  flush();
  return items;
}
