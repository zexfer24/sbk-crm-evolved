"use client";

import { Bot, ShieldAlert } from "lucide-react";

interface AiStatusBannerProps {
  aiEnabled: boolean;
  isIntervening: boolean;
  onIntervene: () => void;
  onToggleAi: () => void;
}

export function AiStatusBanner({ aiEnabled, isIntervening, onIntervene, onToggleAi }: AiStatusBannerProps) {
  return (
    <div className="crm-ai-band" data-on={aiEnabled}>
      <Bot size={16} aria-hidden="true" style={{ color: aiEnabled ? "var(--lm-good)" : "#a06a10" }} />
      <span className="crm-ai-text">
        {aiEnabled
          ? "La IA sigue respondiendo automáticamente"
          : "La IA está pausada en esta conversación"}
      </span>

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
