"use client";

import { Clock, RotateCcw, TriangleAlert, X } from "lucide-react";
import type { Agent, Message } from "@/lib/types";
import type { OutboxItem } from "@/lib/outbox";
import { formatMessageTime } from "@/lib/format";
import { FormattedText } from "@/components/chat/formatted-text";
import { DeliveryCheck } from "@/components/chat/delivery-check";
import { QuotedText, QuotedThumb } from "@/components/chat/quoted-content";

interface OutboxBubbleProps {
  item: OutboxItem;
  currentAgent: Agent;
  /** El mensaje citado, si sigue cargado en el hilo, para pintar la cita. */
  quotedMessage: Message | null;
  onRetry: (localId: string) => void;
  onDiscard: (localId: string) => void;
}

/**
 * La burbuja de un mensaje que todavía es de la cola, no del hilo.
 *
 * Aparece en el instante en que el asesor pulsa enviar —el relojito dice "va
 * en camino", como en WhatsApp— y desaparece sola cuando el mensaje real
 * llega por tiempo real. Si el envío falla, la misma burbuja lo cuenta ahí,
 * en el chat al que pertenece: aviso a la vista y dos gestos, reintentar o
 * descartar. El texto no vuelve al cuadro ni se pierde al cambiar de chat.
 */
export function OutboxBubble({ item, currentAgent, quotedMessage, onRetry, onDiscard }: OutboxBubbleProps) {
  const failed = item.status === "failed";

  return (
    <div
      className="crm-msg flex flex-col items-end gap-1 self-end"
      data-outbox-status={item.status}
      data-message-id={item.sentMessageId ?? undefined}
    >
      <span className="px-1 text-[11px] font-medium tracking-wide text-muted uppercase">
        {currentAgent.displayName}
      </span>
      <div className="crm-msg-row flex flex-row-reverse items-center gap-1">
        <div className="crm-bubble" data-from="agent" data-failed={failed || undefined}>
          {quotedMessage && (
            <div className="crm-bubble-quote">
              <span className="crm-quote-col">
                <span className="font-medium">
                  {quotedMessage.direction === "inbound" ? "Cliente" : quotedMessage.senderAgent?.displayName ?? "Agente"}
                </span>
                <span className="truncate">
                  <QuotedText message={quotedMessage} />
                </span>
              </span>
              <QuotedThumb message={quotedMessage} />
            </div>
          )}
          <FormattedText text={item.content} />
        </div>
      </div>

      {failed ? (
        <div className="crm-outbox-failed" role="alert">
          <TriangleAlert size={13} aria-hidden="true" />
          <span>No se envió{item.error ? `: ${item.error}` : ""}</span>
          <button
            type="button"
            className="crm-outbox-action"
            onClick={() => onRetry(item.localId)}
            aria-label="Reintentar el envío"
            title="Reintentar el envío"
          >
            <RotateCcw size={13} />
          </button>
          <button
            type="button"
            className="crm-outbox-action"
            onClick={() => onDiscard(item.localId)}
            aria-label="Descartar el mensaje"
            title="Descartar el mensaje"
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <span className="crm-msg-foot px-1 text-[11px] text-muted">
          {formatMessageTime(item.createdAt)}
          {item.status === "sent" ? (
            <DeliveryCheck status="sent" size={13} />
          ) : (
            // "En cola" y "enviando" se ven igual a propósito: para el asesor
            // las dos significan "va en camino", y el matiz técnico no ayuda.
            <span className="crm-check" role="img" aria-label="Enviando…" title="Enviando…">
              <Clock size={13} />
            </span>
          )}
        </span>
      )}
    </div>
  );
}
