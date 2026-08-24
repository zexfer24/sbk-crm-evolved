"use client";

import { Bot, ShieldAlert } from "lucide-react";

interface AiStatusBannerProps {
  /** El interruptor de esta conversación. */
  aiEnabled: boolean;
  /** El interruptor general del CRM (`agent_settings.ai_globally_enabled`). */
  aiGloballyEnabled: boolean;
  /** Ya se gastó el tope del día, así que el motor no va a correr. */
  spendCapReached: boolean;
  isIntervening: boolean;
  onIntervene: () => void;
  onToggleAi: () => void;
}

/**
 * Qué decir sobre la IA, en el mismo orden en que el motor decide.
 *
 * El motor pregunta `agent_can_run()` —el interruptor general y el tope de
 * gasto del día— y recién después mira el de la conversación. El cartel
 * seguía únicamente este último, así que con la IA apagada para todo el CRM
 * anunciaba igual que "sigue respondiendo automáticamente": lo contrario de
 * la realidad, y es la única señal visible que tiene el asesor. Con ese
 * cartel, dar un chat por cubierto es dejar al cliente esperando.
 *
 * OJO: este orden replica el de `agent_can_run()` (ver la migración
 * 20260822010000). Si allá cambia la regla, acá hay que cambiarla también.
 */
function estadoDeLaIa({
  aiEnabled,
  aiGloballyEnabled,
  spendCapReached,
}: Pick<AiStatusBannerProps, "aiEnabled" | "aiGloballyEnabled" | "spendCapReached">) {
  if (!aiGloballyEnabled) {
    return { respondiendo: false, texto: "La IA está apagada para todo el CRM" };
  }
  if (spendCapReached) {
    return { respondiendo: false, texto: "La IA no responde: se alcanzó el tope de gasto de hoy" };
  }
  if (!aiEnabled) {
    return { respondiendo: false, texto: "La IA está pausada en esta conversación" };
  }
  return { respondiendo: true, texto: "La IA sigue respondiendo automáticamente" };
}

export function AiStatusBanner({
  aiEnabled,
  aiGloballyEnabled,
  spendCapReached,
  isIntervening,
  onIntervene,
  onToggleAi,
}: AiStatusBannerProps) {
  const { respondiendo, texto } = estadoDeLaIa({ aiEnabled, aiGloballyEnabled, spendCapReached });

  return (
    <div className="crm-ai-band" data-on={respondiendo}>
      <Bot size={16} aria-hidden="true" style={{ color: respondiendo ? "var(--lm-good)" : "#a06a10" }} />
      <span className="crm-ai-text">{texto}</span>

      {/* El botón sigue siendo el de esta conversación: es lo único que el
          asesor puede tocar desde acá. Con el interruptor general apagado,
          reactivar el hilo no hace que conteste nadie — por eso el cartel
          dice de qué se trata en vez de dejarlo suponer. */}
      <button className="crm-pill" type="button" onClick={onToggleAi}>
        {aiEnabled ? "Pausar IA" : "Reactivar IA"}
      </button>
      <button
        className="crm-pill"
        data-variant="danger"
        type="button"
        onClick={onIntervene}
        disabled={isIntervening}
      >
        <ShieldAlert size={14} />
        {isIntervening ? "Interviniendo…" : "Intervenir"}
      </button>
    </div>
  );
}
