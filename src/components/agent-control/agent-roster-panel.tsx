"use client";

import Link from "next/link";
import { MailWarning, MessageSquare } from "lucide-react";
import type { Agent, Conversation } from "@/lib/types";
import { contactName, initials } from "@/lib/dashboard";

interface AgentsRosterPanelProps {
  agents: Agent[];
  conversations: Conversation[];
  togglingAgentId: string | null;
  onToggleActive: (agent: Agent) => void;
}

const ROLE_LABEL: Record<Agent["role"], string> = {
  agent: "Asesor",
  supervisor: "Supervisor",
  admin: "Administrador",
};

export function AgentsRosterPanel({ agents, conversations, togglingAgentId, onToggleActive }: AgentsRosterPanelProps) {
  const activeCount = agents.filter((a) => a.isActive).length;

  return (
    <section className="dash-panel">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Agentes en la operación</h2>
        <span className="dash-panel-spacer" />
        <span className="dash-panel-note">
          {agents.length} en total · {activeCount} disponibles para la IA
        </span>
      </div>

      {agents.length === 0 ? (
        <div className="dash-empty">
          <p className="dash-empty-title">Todavía no hay agentes registrados</p>
        </div>
      ) : (
        <div className="ac-roster">
          {agents.map((agent) => {
            const assigned = conversations.filter(
              (c) => c.assignedAgent?.id === agent.id && c.status !== "closed"
            );
            const unanswered = assigned.filter((c) => c.unreadCount > 0);
            const isToggling = togglingAgentId === agent.id;

            return (
              <div className="ac-agent-card" key={agent.id}>
                <div className="ac-agent-card-head">
                  <span className="ac-live-avatar" aria-hidden="true">
                    {initials(agent.displayName)}
                  </span>
                  <div className="ac-agent-card-who">
                    <span className="ac-agent-card-name">{agent.displayName}</span>
                    <span className="ac-agent-card-role">{ROLE_LABEL[agent.role]}</span>
                  </div>

                  <div className="ac-agent-card-toggle">
                    <span className="ac-agent-card-toggle-label">
                      {agent.isActive ? "Disponible para la IA" : "No disponible"}
                    </span>
                    <button
                      className="ac-switch"
                      type="button"
                      data-on={agent.isActive}
                      onClick={() => onToggleActive(agent)}
                      disabled={isToggling}
                      aria-label={
                        agent.isActive
                          ? `Quitar a ${agent.displayName} de la asignación automática de la IA`
                          : `Poner a ${agent.displayName} disponible para la asignación automática de la IA`
                      }
                    />
                  </div>
                </div>

                <div className="ac-agent-card-stats">
                  <span className="ac-badge" data-tone="link">
                    <MessageSquare size={11} />
                    {assigned.length} asignados
                  </span>
                  <span className="ac-badge" data-tone={unanswered.length > 0 ? "hot" : "muted"}>
                    <MailWarning size={11} />
                    {unanswered.length} sin responder
                  </span>
                </div>

                {assigned.length > 0 && (
                  <div className="ac-agent-card-chats">
                    {assigned.slice(0, 5).map((c) => (
                      <Link
                        key={c.id}
                        href={`/inbox?conversation=${c.id}`}
                        className="ac-agent-card-chat"
                        data-unread={c.unreadCount > 0}
                      >
                        {contactName(c)}
                      </Link>
                    ))}
                    {assigned.length > 5 && (
                      <span className="ac-agent-card-chat-more">+{assigned.length - 5} más</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
