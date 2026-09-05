import { AlertCircle, Check, CheckCheck, Clock, PlayCircle } from "lucide-react";
import type { WhatsappMessageStatus } from "@/lib/types";

/**
 * El doble check de WhatsApp. Es el mismo lenguaje que el agente ya conoce de
 * su teléfono, así que se respeta al pie: un check es "salió de acá", dos son
 * "llegó al teléfono", dos azules son "lo abrió". Sin colores inventados.
 *
 * 'played' (T3.2, 5/9/2026) es propio de las notas de voz: Meta lo manda
 * cuando el cliente reproduce el audio que le enviamos, un paso más adelante
 * que "leído" (ver `whatsapp_status_rank()` en la base). Lleva un ícono
 * distinto en vez de un tercer check para no inventar un color que WhatsApp
 * no usa.
 */
const LABELS: Record<WhatsappMessageStatus, string> = {
  sent: "Enviado",
  delivered: "Recibido",
  read: "Leído",
  played: "Reproducido",
  failed: "No se pudo entregar",
};

interface DeliveryCheckProps {
  status: WhatsappMessageStatus | null;
  size?: number;
  /**
   * Sin estado + pending: el relojito de "va en camino". Es el estado en que
   * nace un mensaje de canal real —el envío a Meta corre después de contestar
   * al asesor— y dura hasta que Meta confirma ('sent') o rechaza ('failed').
   */
  pending?: boolean;
  /**
   * Por qué no se entregó, cuando el estado es 'failed'.
   *
   * Se suma a la etiqueta del icono en vez de reemplazarla: quien pasa por
   * encima del triángulo quiere las dos cosas, qué pasó y por qué.
   */
  detail?: string | null;
}

export function DeliveryCheck({ status, size = 14, pending = false, detail = null }: DeliveryCheckProps) {
  if (!status) {
    if (!pending) return null;
    return (
      <span className="crm-check" data-status="pending" role="img" aria-label="Enviando…" title="Enviando…">
        <Clock size={size} />
      </span>
    );
  }

  const label = detail ? `${LABELS[status]}: ${detail}` : LABELS[status];

  return (
    <span className="crm-check" data-status={status} role="img" aria-label={label} title={label}>
      {status === "failed" ? (
        <AlertCircle size={size} />
      ) : status === "sent" ? (
        <Check size={size} />
      ) : status === "played" ? (
        <PlayCircle size={size} />
      ) : (
        <CheckCheck size={size} />
      )}
    </span>
  );
}
