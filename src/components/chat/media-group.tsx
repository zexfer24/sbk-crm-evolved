import type { Message } from "@/lib/types";
import { formatMessageTime } from "@/lib/format";
import { MediaThumb, type MediaItem } from "@/components/chat/media-lightbox";

function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

/** Varias fotos/videos seguidos del mismo emisor, mostrados como galería deslizable. */
export function MediaGroup({ messages }: { messages: Message[] }) {
  const isCustomer = messages[0].direction === "inbound";
  const last = messages[messages.length - 1];

  const items: MediaItem[] = messages.map((message) => ({
    url: message.mediaUrl ?? "",
    type: message.messageType === "video" ? "video" : "image",
    caption: message.content,
  }));

  return (
    <div className={cx("crm-msg flex flex-col gap-1", isCustomer ? "items-start self-start" : "items-end self-end")}>
      <div className="crm-gallery no-scrollbar">
        {items.map((item, index) => (
          <MediaThumb key={messages[index].id} items={items} index={index} className="crm-thumb-sm" />
        ))}
      </div>
      <span className="px-1 text-[11px] text-muted">
        {messages.length} archivos · {formatMessageTime(last.createdAt)}
      </span>
    </div>
  );
}
