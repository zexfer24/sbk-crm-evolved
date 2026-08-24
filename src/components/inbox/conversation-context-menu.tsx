"use client";

import { MailOpen, MailPlus } from "lucide-react";
import { ContextMenu } from "@/components/context-menu";

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
  function run(action: () => void) {
    action();
    onClose();
  }

  return (
    <ContextMenu position={position} onClose={onClose} label="Acciones de la conversación">
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
    </ContextMenu>
  );
}
