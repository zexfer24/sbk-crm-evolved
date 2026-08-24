"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MailOpen, MailPlus } from "lucide-react";

/** Margen mínimo con el borde de la pantalla al reacomodar el menú. */
const VIEWPORT_MARGIN = 8;

interface ConversationContextMenuProps {
  /** Dónde se pidió el menú: el cursor en escritorio, el dedo en el teléfono. */
  position: { x: number; y: number };
  isUnread: boolean;
  onMarkUnread: () => void;
  onMarkRead: () => void;
  onClose: () => void;
}

export function ConversationContextMenu({
  position,
  isUnread,
  onMarkUnread,
  onMarkRead,
  onClose,
}: ConversationContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState(position);

  // El menú se pide en el punto del cursor, que cerca del borde derecho o de
  // abajo lo dejaría medio fuera. Se mide ya montado y se corre lo justo para
  // que entre entero — antes de pintar, para que no se vea saltar.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPlacement({
      x: Math.max(VIEWPORT_MARGIN, Math.min(position.x, window.innerWidth - width - VIEWPORT_MARGIN)),
      y: Math.max(VIEWPORT_MARGIN, Math.min(position.y, window.innerHeight - height - VIEWPORT_MARGIN)),
    });
  }, [position]);

  useEffect(() => {
    // El menú queda anclado a un punto de la pantalla: si la lista se
    // desplaza debajo, deja de señalar la conversación que abrió. Cerrar es
    // más honesto que seguir al elemento.
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function closeOnOutside(event: Event) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);

    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  function run(action: () => void) {
    action();
    onClose();
  }

  return (
    <div
      ref={menuRef}
      className="crm-context-menu"
      role="menu"
      aria-label="Acciones de la conversación"
      style={{ left: placement.x, top: placement.y }}
    >
      {isUnread ? (
        <button type="button" role="menuitem" onClick={() => run(onMarkRead)}>
          <MailOpen size={15} aria-hidden="true" />
          Marcar como leído
        </button>
      ) : (
        <button type="button" role="menuitem" onClick={() => run(onMarkUnread)}>
          <MailPlus size={15} aria-hidden="true" />
          Marcar como no leído
        </button>
      )}
    </div>
  );
}
