"use client";

import { Lock, MailOpen, MailPlus, Pin, PinOff, Unlock } from "lucide-react";
import { ContextMenu } from "@/components/context-menu";

interface ConversationContextMenuProps {
  /** Dónde se pidió el menú: el cursor en escritorio, el dedo en el teléfono. */
  position: { x: number; y: number };
  isUnread: boolean;
  onMarkUnread: () => void;
  onMarkRead: () => void;
  onClose: () => void;
  /**
   * La conversación ya está cerrada: se ofrece "Reabrir" en vez de "Cerrar
   * conversación" (T2.1, 5/9/2026). Ambas acciones son opcionales: sin el
   * callback correspondiente el menú simplemente no la ofrece, para no
   * romper a quien todavía no las cablea.
   */
  isConversationClosed?: boolean;
  onCloseConversation?: () => void;
  onReopenConversation?: () => void;
  /**
   * Fijar/desfijar (T2.2, 5/9/2026, hasta tres chats fijados por asesor —
   * `conversation_pins`). Igual que el resto de acciones opcionales de este
   * menú: sin el callback correspondiente, la acción simplemente no se
   * ofrece.
   */
  isPinned?: boolean;
  /**
   * Ya fijó tres conversaciones y esta no es una de ellas: no hay cupo para
   * fijar una más. Deshabilita "Fijar" en vez de esconderlo — el trigger de
   * la base (`conversation_pins_limit_before_insert`) rechazaría igual el
   * intento, pero es mejor no ofrecer una acción que se sabe de antemano que
   * va a fallar.
   */
  pinLimitReached?: boolean;
  onPin?: () => void;
  onUnpin?: () => void;
}

export function ConversationContextMenu({
  position,
  isUnread,
  onMarkUnread,
  onMarkRead,
  onClose,
  isConversationClosed = false,
  onCloseConversation,
  onReopenConversation,
  isPinned = false,
  pinLimitReached = false,
  onPin,
  onUnpin,
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
      {isConversationClosed
        ? onReopenConversation && (
            <button type="button" role="menuitem" onClick={() => run(onReopenConversation)}>
              <Unlock size={15} aria-hidden="true" />
              Reabrir conversación
            </button>
          )
        : onCloseConversation && (
            <button type="button" role="menuitem" onClick={() => run(onCloseConversation)}>
              <Lock size={15} aria-hidden="true" />
              Cerrar conversación
            </button>
          )}
      {isPinned
        ? onUnpin && (
            <button type="button" role="menuitem" onClick={() => run(onUnpin)}>
              <PinOff size={15} aria-hidden="true" />
              Desfijar
            </button>
          )
        : onPin && (
            <button
              type="button"
              role="menuitem"
              onClick={() => run(onPin)}
              disabled={pinLimitReached}
              title={
                pinLimitReached
                  ? "Ya fijaste tres conversaciones. Desfijá una para poder fijar esta."
                  : undefined
              }
            >
              <Pin size={15} aria-hidden="true" />
              Fijar
            </button>
          )}
    </ContextMenu>
  );
}
