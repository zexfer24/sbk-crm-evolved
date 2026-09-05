import { SignalHigh } from "lucide-react";
import type { WhatsappChannelHealth } from "@/lib/types";
import { formatFullDateTime } from "@/lib/format";

interface ChannelHealthPanelProps {
  health: WhatsappChannelHealth | null;
}

const QUALITY_LABEL: Record<string, string> = {
  GREEN: "Buena",
  YELLOW: "En observación",
  RED: "Degradada",
};

const QUALITY_TONE: Record<string, string> = {
  GREEN: "good",
  YELLOW: "wait",
  RED: "hot",
};

/**
 * TIER_* es el vocabulario de Meta para el límite de mensajes iniciados por
 * el negocio en 24 h. Se muestra en español porque es lo único de esta
 * tarjeta que un asesor sin contexto de la Cloud API tendría que buscar.
 */
const LIMIT_LABEL: Record<string, string> = {
  TIER_50: "50 conversaciones/día",
  TIER_250: "250 conversaciones/día",
  TIER_1K: "1.000 conversaciones/día",
  TIER_10K: "10.000 conversaciones/día",
  TIER_100K: "100.000 conversaciones/día",
  TIER_UNLIMITED: "Sin límite",
};

/**
 * Tarjeta "Salud del número" (T3.4, 5/9/2026): lo que el webhook de Meta
 * fue guardando en `whatsapp_channels` (`phone_number_quality_update`,
 * `account_update`) — calidad, límite de mensajería y restricciones de
 * cuenta. Puramente informativa, sin ninguna acción: hasta que no llegue el
 * primer webhook de esos dos tipos, no hay nada que mostrar salvo "sin
 * datos" — fingir un estado sería peor que no decir nada, porque el
 * operador de verdad necesita saber si Meta reportó la calidad o si el CRM
 * simplemente todavía no la escuchó.
 */
export function ChannelHealthPanel({ health }: ChannelHealthPanelProps) {
  const quality = health?.qualityRating ?? null;
  const limit = health?.messagingLimit ?? null;
  const updatedAt = health?.healthUpdatedAt ?? null;
  const restrictions = health?.accountRestrictions ?? null;
  const hasRestriction = Boolean(
    restrictions &&
      ((Array.isArray(restrictions.restriction_info) && restrictions.restriction_info.length > 0) ||
        restrictions.ban_info)
  );

  return (
    <section className="dash-panel ac-channel-health">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Salud del número</h2>
        <span className="dash-panel-spacer" />
        {updatedAt ? (
          <span className="dash-panel-note">Actualizado {formatFullDateTime(updatedAt)}</span>
        ) : (
          <span className="dash-panel-note">Sin datos todavía</span>
        )}
      </div>

      <div className="ac-channel-health-body">
        <div className="ac-channel-health-row">
          <SignalHigh size={14} aria-hidden="true" />
          <span>Calidad</span>
          <span className="dash-panel-spacer" />
          {quality ? (
            <span className="ac-badge" data-tone={QUALITY_TONE[quality] ?? "muted"}>
              {QUALITY_LABEL[quality] ?? quality}
            </span>
          ) : (
            <span className="ac-badge" data-tone="muted">
              Sin datos
            </span>
          )}
        </div>

        <div className="ac-channel-health-row">
          <span>Límite de mensajería</span>
          <span className="dash-panel-spacer" />
          <span className="ac-channel-health-value">{limit ? (LIMIT_LABEL[limit] ?? limit) : "Sin datos"}</span>
        </div>

        {hasRestriction && (
          <p className="ac-channel-health-warn">
            Meta reportó una restricción de cuenta. Revisa el correo de WhatsApp Business para los detalles.
          </p>
        )}

        {!updatedAt && (
          <p className="ac-channel-health-note">
            Todavía no llegó ningún webhook de calidad o de cuenta para este número. Esta tarjeta se llena
            sola en cuanto Meta mande el primero — no hace falta ninguna acción acá.
          </p>
        )}
      </div>
    </section>
  );
}
