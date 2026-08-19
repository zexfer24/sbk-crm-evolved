import type { Message } from "@/lib/types";
import { formatMessageTime } from "@/lib/format";

function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

/** Varias fotos/videos seguidos del mismo emisor, mostrados como galería deslizable. */
export function MediaGroup({ messages }: { messages: Message[] }) {
  const isCustomer = messages[0].direction === "inbound";
  const last = messages[messages.length - 1];

  return (
    <div className={cx("flex max-w-[70%] flex-col gap-1", isCustomer ? "items-start self-start" : "items-end self-end")}>
      <div className="no-scrollbar flex gap-1.5 overflow-x-auto rounded-field p-0.5" style={{ scrollSnapType: "x mandatory" }}>
        {messages.map((message) => (
          <div key={message.id} className="shrink-0 overflow-hidden rounded-field" style={{ scrollSnapAlign: "start" }}>
            {message.messageType === "video" ? (
              <video src={message.mediaUrl ?? undefined} controls className="h-40 w-40 object-cover" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={message.mediaUrl ?? undefined}
                alt={message.content ?? "Imagen"}
                className="h-40 w-40 object-cover"
              />
            )}
          </div>
        ))}
      </div>
      <span className="px-1 text-[11px] text-muted">
        {messages.length} archivos · {formatMessageTime(last.createdAt)}
      </span>
    </div>
  );
}
