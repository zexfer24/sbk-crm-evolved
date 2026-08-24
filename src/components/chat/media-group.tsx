"use client";

import { useState } from "react";
import { ImageDown } from "lucide-react";
import type { Message } from "@/lib/types";
import { formatMessageTime } from "@/lib/format";
import { MediaThumb, type MediaItem } from "@/components/chat/media-lightbox";
import { MessageContextMenu } from "@/components/chat/message-context-menu";
import { useLongPress } from "@/lib/use-long-press";

function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

/**
 * Cómo llamar al montón según lo que traiga.
 *
 * "3 archivos" es correcto y no dice nada: quien manda tres fotos quiere ver
 * que llegaron tres fotos. Solo cuando el grupo mezcla se cae en la palabra
 * genérica, porque ahí sí es lo único cierto.
 */
function nombreDelMonton(messages: Message[]): string {
  const total = messages.length;
  const soloFotos = messages.every((m) => m.messageType === "image");
  const soloVideos = messages.every((m) => m.messageType === "video");

  if (soloFotos) return `${total} ${total === 1 ? "foto" : "fotos"}`;
  if (soloVideos) return `${total} ${total === 1 ? "video" : "videos"}`;
  return `${total} archivos`;
}

/** Varias fotos/videos seguidos del mismo emisor, mostrados como galería deslizable. */
export function MediaGroup({ messages }: { messages: Message[] }) {
  const isCustomer = messages[0].direction === "inbound";
  const last = messages[messages.length - 1];

  // El menú es de una foto concreta, no del montón: copiar "la galería" no
  // significa nada. Se guarda cuál se señaló junto a dónde se pidió.
  const [menu, setMenu] = useState<{ message: Message; position: { x: number; y: number } } | null>(null);

  // El lightbox solo puede abrir lo que ya tiene archivo, así que su lista es
  // la de los descargados. Se guarda el índice que le toca a cada mensaje
  // dentro de esa lista para que abrir la tercera foto abra la tercera.
  const items: MediaItem[] = [];
  const indexInLightbox = new Map<string, number>();
  for (const message of messages) {
    if (!message.mediaUrl) continue;
    indexInLightbox.set(message.id, items.length);
    items.push({
      url: message.mediaUrl,
      type: message.messageType === "video" ? "video" : "image",
      caption: message.content,
    });
  }

  const enCamino = messages.length - items.length;

  return (
    <div className={cx("crm-msg flex flex-col gap-1", isCustomer ? "items-start self-start" : "items-end self-end")}>
      <div className="crm-gallery no-scrollbar">
        {messages.map((message) => {
          const index = indexInLightbox.get(message.id);
          if (index === undefined) {
            // Todavía no bajó: el webhook guarda la fila enseguida y trae el
            // archivo después. No es un fallo, así que no se pinta como tal —
            // decir "no se pudo cargar" de algo que viene en camino hace que
            // el asesor le pida al cliente que lo reenvíe sin necesidad.
            return (
              <div
                className="crm-thumb-sm crm-thumb-pending"
                key={message.id}
                role="img"
                aria-label="Archivo en camino"
                title="Todavía se está descargando"
              >
                <ImageDown size={18} />
              </div>
            );
          }
          return (
            <GalleryThumb
              key={message.id}
              message={message}
              items={items}
              index={index}
              onOpenMenu={(position) => setMenu({ message, position })}
            />
          );
        })}
      </div>

      {menu && (
        <MessageContextMenu
          position={menu.position}
          message={menu.message}
          onClose={() => setMenu(null)}
        />
      )}
      <span className="px-1 text-[11px] text-muted">
        {nombreDelMonton(messages)}
        {enCamino > 0 && ` · ${enCamino} en camino`} · {formatMessageTime(last.createdAt)}
      </span>
    </div>
  );
}

/**
 * Una miniatura de la galería con su menú propio. Va aparte porque la
 * pulsación larga necesita estado, y un hook no puede vivir dentro del
 * `map` que pinta la galería.
 */
function GalleryThumb({
  message,
  items,
  index,
  onOpenMenu,
}: {
  message: Message;
  items: MediaItem[];
  index: number;
  onOpenMenu: (position: { x: number; y: number }) => void;
}) {
  const longPress = useLongPress(onOpenMenu);

  return (
    <div
      className="contents"
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu({ x: event.clientX, y: event.clientY });
      }}
      {...longPress.handlers}
    >
      <MediaThumb items={items} index={index} className="crm-thumb-sm" key={message.id} />
    </div>
  );
}
