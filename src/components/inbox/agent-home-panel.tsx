import { ArrowLeft } from "lucide-react";
import type { Agent, AgentSettings } from "@/lib/types";
import type { InboxCounts } from "@/lib/data";
import { SbkMark } from "@/components/sbk-logo";

/**
 * Lo que ocupa la columna del chat cuando no hay ninguna conversación abierta.
 *
 * Antes la bandeja abría sola la primera conversación de la lista. Eso ponía
 * al asesor a leer un chat que no eligió —y de paso lo marcaba como leído—
 * antes de decidir nada. Ahora se entra a un resumen propio y el primer chat
 * abierto es siempre una elección.
 *
 * Los números llegan contados por la base (`fetchInboxCounts`): la lista en
 * memoria es una ventana paginada, y contar sobre una ventana mentiría en
 * cuanto el asesor tuviera más conversaciones que las cargadas.
 */
export function AgentHomePanel({
  currentAgent,
  counts,
  agentSettings,
}: {
  currentAgent: Agent;
  counts: InboxCounts;
  agentSettings: AgentSettings;
}) {
  const { pending, pendingStale, mine } = counts;

  const spendCapReached =
    agentSettings.dailySpendCapUsd !== null &&
    agentSettings.spentTodayUsd >= agentSettings.dailySpendCapUsd;

  // El mismo criterio que el cartel del chat: la IA solo "está respondiendo"
  // si el interruptor general está encendido y el gasto no llegó al tope.
  const ai = !agentSettings.aiGloballyEnabled
    ? { tone: "wait" as const, label: "La IA está apagada en todo el CRM" }
    : spendCapReached
      ? { tone: "wait" as const, label: "La IA llegó al tope de gasto de hoy" }
      : { tone: "good" as const, label: "La IA está respondiendo en todo el CRM" };

  return (
    <div className="crm-agent-home">
      <div className="crm-agent-home-mark" aria-hidden="true">
        <SbkMark size={56} />
      </div>
      <p className="crm-agent-home-title lm-display">Hola, {currentAgent.displayName}</p>
      <p className="crm-agent-home-sub">Así viene el día en la bandeja.</p>

      <div className="crm-agent-stats">
        <div className="crm-agent-stat">
          <span className="crm-agent-stat-value lm-num">{pending}</span>
          <span className="lm-eyebrow">Pendientes</span>
        </div>
        <div className="crm-agent-stat">
          <span className="crm-agent-stat-value lm-num">{pendingStale}</span>
          <span className="lm-eyebrow">Esperando +24 h</span>
        </div>
        <div className="crm-agent-stat">
          <span className="crm-agent-stat-value lm-num">{mine}</span>
          <span className="lm-eyebrow">Tuyas</span>
        </div>
      </div>

      <span className="lm-chip crm-agent-ai" data-tone={ai.tone}>
        <span className="lm-chip-dot" />
        {ai.label}
      </span>

      <p className="crm-agent-hint">
        <ArrowLeft size={14} aria-hidden="true" />
        Elige una conversación de la lista para empezar
      </p>
    </div>
  );
}
