import { AlertCircle, Check, CheckCheck } from "lucide-react";
import type { WhatsappMessageStatus } from "@/lib/types";

/**
 * El doble check de WhatsApp. Es el mismo lenguaje que el agente ya conoce de
 * su teléfono, así que se respeta al pie: un check es "salió de acá", dos son
 * "llegó al teléfono", dos azules son "lo abrió". Sin colores inventados.
 */
const LABELS: Record<WhatsappMessageStatus, string> = {
  sent: "Enviado",
  delivered: "Recibido",
  read: "Leído",
  failed: "No se pudo entregar",
};

interface DeliveryCheckProps {
  status: WhatsappMessageStatus | null;
  size?: number;
}

export function DeliveryCheck({ status, size = 14 }: DeliveryCheckProps) {
  if (!status) return null;

  const label = LABELS[status];

  return (
    <span className="crm-check" data-status={status} role="img" aria-label={label} title={label}>
      {status === "failed" ? (
        <AlertCircle size={size} />
      ) : status === "sent" ? (
        <Check size={size} />
      ) : (
        <CheckCheck size={size} />
      )}
    </span>
  );
}
