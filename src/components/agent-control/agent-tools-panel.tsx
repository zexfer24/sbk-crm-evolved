"use client";

import { ShieldCheck, TriangleAlert } from "lucide-react";
import type { AgentTool } from "@/lib/types";

interface AgentToolsPanelProps {
  tools: AgentTool[];
  canEdit: boolean;
  togglingKey: string | null;
  onToggle: (tool: AgentTool) => void;
}

/**
 * Interruptores por herramienta del agente. La lista sale de la base
 * (public.agent_tools): una herramienta aparece porque hay código que la
 * implementa, así que acá no se crean ni se borran — solo se apagan.
 */
export function AgentToolsPanel({ tools, canEdit, togglingKey, onToggle }: AgentToolsPanelProps) {
  return (
    <section className="dash-panel">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Lo que la IA puede hacer</h2>
        <span className="dash-panel-spacer" />
        <span className="dash-panel-note">
          {tools.filter((t) => t.isEnabled).length} de {tools.length} encendidas
        </span>
      </div>

      <p className="ac-pb-intro">
        Cada interruptor apaga una capacidad puntual sin apagar la IA: ella sigue atendiendo, pero sin esa
        herramienta, y sabe decirle al cliente que ese dato se lo confirma un asesor.
        {!canEdit && " Solo un supervisor o admin puede cambiarlos."}
      </p>

      <div className="ac-pb-list">
        {tools.map((tool) => (
          <div className="ac-pb-card" key={tool.key} data-active={tool.isEnabled}>
            <div className="ac-pb-card-head">
              <div className="ac-pb-card-who">
                <span className="ac-pb-card-name">{tool.name}</span>
                <span className="ac-pb-card-trigger">{tool.description}</span>
              </div>

              <div className="ac-agent-card-toggle">
                <span className="ac-agent-card-toggle-label">{tool.isEnabled ? "Encendida" : "Apagada"}</span>
                {canEdit && (
                  <button
                    className="ac-switch"
                    type="button"
                    data-on={tool.isEnabled}
                    onClick={() => onToggle(tool)}
                    disabled={togglingKey === tool.key}
                    aria-label={tool.isEnabled ? `Apagar ${tool.name}` : `Encender ${tool.name}`}
                  />
                )}
              </div>
            </div>

            {!tool.isEnabled && (
              <div className="ac-pb-card-foot">
                <span className="ac-badge" data-tone="wait">
                  <TriangleAlert size={11} />
                  La IA atiende sin esta capacidad
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="ac-pb-intro">
        <ShieldCheck size={12} style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} aria-hidden="true" />
        <strong>Escalar a un asesor no tiene interruptor a propósito:</strong> es la única vía por la que una
        conversación llega a un humano (ventas, devoluciones, reclamos). Si se pudiera apagar, un descuido dejaría
        esos casos sin salida.
      </p>
    </section>
  );
}
