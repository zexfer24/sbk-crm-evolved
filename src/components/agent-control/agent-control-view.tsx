"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Inbox, LogOut, Receipt, Route, ShieldAlert, Users } from "lucide-react";
import type { Agent, AgentIntent, AgentSettings, AgentTurn, AgentTurnAction, Conversation } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { fetchAgentSettings, fetchAgentTurns, fetchAllAgents, fetchConversations } from "@/lib/data";
import { setAgentActive, setAiEnabled, setAiGloballyEnabled, intervene } from "@/lib/mutations";
import { contactName, initials } from "@/lib/dashboard";
import { AgentsRosterPanel } from "@/components/agent-control/agent-roster-panel";
import "@/components/dashboard/dashboard.css";
import "@/components/agent-control/agent-control.css";

interface AgentControlViewProps {
  currentAgent: Agent;
  initialConversations: Conversation[];
  initialTurns: AgentTurn[];
  initialSettings: AgentSettings;
  initialAgents: Agent[];
  modelLabel: string;
}

type AgentControlTab = "ia" | "agentes";

const INTENT_LABEL: Record<AgentIntent, string> = {
  consulta_disponibilidad: "Consulta",
  devolucion: "Devolución",
  queja: "Queja",
  otro: "Otro",
};

const INTENT_TONE: Record<AgentIntent, string> = {
  consulta_disponibilidad: "link",
  devolucion: "wait",
  queja: "hot",
  otro: "muted",
};

const ACTION_LABEL: Record<AgentTurnAction, string> = {
  answered: "Respondió",
  escalated: "Escaló",
  error: "Falló",
};

const ACTION_TONE: Record<AgentTurnAction, string> = {
  answered: "good",
  escalated: "plum",
  error: "hot",
};

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" });
}

export function AgentControlView({
  currentAgent,
  initialConversations,
  initialTurns,
  initialSettings,
  initialAgents,
  modelLabel,
}: AgentControlViewProps) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [tab, setTab] = useState<AgentControlTab>("ia");
  const [conversations, setConversations] = useState(initialConversations);
  const [turns, setTurns] = useState(initialTurns);
  const [settings, setSettings] = useState(initialSettings);
  const [agents, setAgents] = useState(initialAgents);
  const [togglingKillSwitch, setTogglingKillSwitch] = useState(false);
  const [busyConversationId, setBusyConversationId] = useState<string | null>(null);
  const [togglingAgentId, setTogglingAgentId] = useState<string | null>(null);

  const [simText, setSimText] = useState("");
  const [simConversationId, setSimConversationId] = useState<string | null>(null);
  const [simSending, setSimSending] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [simOk, setSimOk] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextConversations, nextTurns, nextSettings, nextAgents] = await Promise.all([
        fetchConversations(supabase),
        fetchAgentTurns(supabase),
        fetchAgentSettings(supabase),
        fetchAllAgents(supabase),
      ]);
      setConversations(nextConversations);
      setTurns(nextTurns);
      setSettings(nextSettings);
      setAgents(nextAgents);
    } catch {
      // El siguiente cambio en tiempo real reintentará la sincronización.
    }
  }, [supabase]);

  useEffect(() => {
    const channel = supabase
      .channel("agent-control-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => refresh())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_turns" }, () => refresh())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "agent_settings" }, () => refresh())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "agents" }, () => refresh())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, refresh]);

  async function toggleAgentActive(agent: Agent) {
    setTogglingAgentId(agent.id);
    try {
      await setAgentActive(supabase, agent.id, !agent.isActive);
      await refresh();
    } finally {
      setTogglingAgentId(null);
    }
  }

  const liveConversations = useMemo(
    () =>
      conversations
        .filter((c) => c.aiEnabled && !c.assignedAgent && c.status !== "closed")
        .sort((a, b) => new Date(b.lastMessageAt ?? b.createdAt).getTime() - new Date(a.lastMessageAt ?? a.createdAt).getTime()),
    [conversations]
  );

  const conversationsById = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);

  async function toggleKillSwitch() {
    setTogglingKillSwitch(true);
    const next = !settings.aiGloballyEnabled;
    try {
      await setAiGloballyEnabled(supabase, currentAgent, next);
      setSettings({ aiGloballyEnabled: next });
    } finally {
      setTogglingKillSwitch(false);
    }
  }

  async function pauseAi(conversationId: string) {
    setBusyConversationId(conversationId);
    try {
      await setAiEnabled(supabase, conversationId, currentAgent, false);
      await refresh();
    } finally {
      setBusyConversationId(null);
    }
  }

  async function takeOver(conversationId: string) {
    setBusyConversationId(conversationId);
    try {
      await intervene(supabase, conversationId, currentAgent);
      await refresh();
    } finally {
      setBusyConversationId(null);
    }
  }

  async function sendSimulatedMessage() {
    if (!simText.trim()) return;
    setSimSending(true);
    setSimError(null);
    setSimOk(null);
    try {
      const res = await fetch("/api/dev/simulate-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: simConversationId, text: simText.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "El turno del agente falló.");
      setSimConversationId(body.conversationId);
      setSimOk("Mensaje enviado. Mira la conversación de prueba y el feed de abajo.");
      setSimText("");
      await refresh();
    } catch (err) {
      setSimError(err instanceof Error ? err.message : "No se pudo enviar el mensaje de prueba.");
    } finally {
      setSimSending(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <div className="dash">
      <div className="dash-frame">
        <nav className="dash-rail" aria-label="Secciones">
          <Link className="dash-rail-btn" href="/" aria-label="Recorrido">
            <Route size={17} />
          </Link>
          <Link className="dash-rail-btn" href="/inbox" aria-label="Bandeja">
            <Inbox size={17} />
          </Link>
          <Link className="dash-rail-btn" href="/ventas" aria-label="Ventas">
            <Receipt size={17} />
          </Link>
          <Link className="dash-rail-btn" href="/agent-control" data-active="true" aria-label="Control de IA">
            <Bot size={17} />
          </Link>
          <span className="dash-rail-spacer" />
          <button className="dash-rail-btn" type="button" onClick={signOut} aria-label="Cerrar sesión">
            <LogOut size={17} />
          </button>
        </nav>

        <main className="dash-main">
          <div className="dash-content">
            <header className="dash-topbar">
              <p className="dash-brand">
                <span className="dash-brand-mark" aria-hidden="true">
                  <Bot size={14} />
                </span>
                <span className="dash-brand-name">Liminal</span>
              </p>

              <nav className="dash-nav" aria-label="Navegación principal">
                <Link className="dash-nav-link" href="/">
                  Recorrido
                </Link>
                <Link className="dash-nav-link" href="/inbox">
                  Bandeja
                </Link>
                <Link className="dash-nav-link" href="/ventas">
                  Ventas
                </Link>
                <Link className="dash-nav-link" href="/agent-control" aria-current="page">
                  Control IA
                </Link>
              </nav>

              <div className="dash-topbar-actions">
                <span className="dash-icon-btn dash-icon-static" title={currentAgent.displayName}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{initials(currentAgent.displayName)}</span>
                </span>
              </div>
            </header>

            <div className="dash-header">
              <div>
                <h1 className="dash-title dash-display">
                  {tab === "ia" ? "Control del agente de IA" : "Control de agentes"}
                </h1>
                <p className="dash-subtitle">
                  {tab === "ia"
                    ? "Interruptor general, qué está haciendo la IA ahora mismo, y un simulador para probarla sin necesidad de WhatsApp real."
                    : "Cuántos asesores hay en la operación, quién está disponible para que la IA le pase conversaciones, y su carga actual."}
                </p>
              </div>
            </div>

            <div className="ac-tabs" role="tablist" aria-label="Secciones de control">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "ia"}
                className="ac-tab-btn"
                data-active={tab === "ia"}
                onClick={() => setTab("ia")}
              >
                Control de IA
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "agentes"}
                className="ac-tab-btn"
                data-active={tab === "agentes"}
                onClick={() => setTab("agentes")}
              >
                <Users size={13} />
                Agentes
                <span className="ac-tab-count">{agents.length}</span>
              </button>
            </div>

            {tab === "ia" && (
            <>
            <section className="dash-panel ac-kill" data-on={settings.aiGloballyEnabled}>
              <div className="ac-kill-status">
                <span className="ac-kill-dot" aria-hidden="true" />
                <div>
                  <p className="ac-kill-title">
                    {settings.aiGloballyEnabled ? "La IA está activa en todo el CRM" : "La IA está apagada en todo el CRM"}
                  </p>
                  <p className="ac-kill-note">
                    {settings.aiGloballyEnabled
                      ? "Responde en cualquier conversación sin asesor asignado."
                      : "No va a responder en ninguna conversación hasta que la reactives."}
                  </p>
                </div>
              </div>

              <span className="ac-model-tag">{modelLabel}</span>

              <button
                className="ac-switch"
                type="button"
                data-on={settings.aiGloballyEnabled}
                onClick={toggleKillSwitch}
                disabled={togglingKillSwitch}
                aria-label="Interruptor global de la IA"
              />
            </section>

            <div className="dash-lower">
              <section className="dash-panel">
                <div className="dash-panel-head">
                  <h2 className="dash-panel-title">Conversaciones con la IA ahora</h2>
                  <span className="dash-panel-spacer" />
                  <span className="dash-panel-note">{liveConversations.length} activas</span>
                </div>

                <div className="ac-live-list">
                  {liveConversations.length === 0 ? (
                    <p className="ac-live-empty">No hay conversaciones en manos de la IA en este momento.</p>
                  ) : (
                    liveConversations.map((c) => {
                      const name = contactName(c);
                      return (
                        <div className="ac-live-row" key={c.id}>
                          <span className="ac-live-avatar" aria-hidden="true">
                            {initials(name)}
                          </span>
                          <div className="ac-live-body">
                            <span className="ac-live-name">{name}</span>
                            <span className="ac-live-meta">
                              {c.intent && (
                                <span
                                  className="ac-badge"
                                  data-tone={INTENT_TONE[c.intent as AgentIntent] ?? "muted"}
                                >
                                  {INTENT_LABEL[c.intent as AgentIntent] ?? c.intent}
                                </span>
                              )}
                              {c.activeTool && <span className="ac-badge" data-tone="plum">{c.activeTool}</span>}
                              {!c.intent && !c.activeTool && <span>Esperando al cliente</span>}
                            </span>
                          </div>
                          <div className="ac-live-actions">
                            <button
                              className="crm-pill"
                              type="button"
                              onClick={() => pauseAi(c.id)}
                              disabled={busyConversationId === c.id}
                            >
                              Pausar
                            </button>
                            <button
                              className="crm-pill"
                              data-variant="danger"
                              type="button"
                              onClick={() => takeOver(c.id)}
                              disabled={busyConversationId === c.id}
                            >
                              <ShieldAlert size={13} />
                              Tomar
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              <section className="dash-panel">
                <div className="dash-panel-head">
                  <h2 className="dash-panel-title">Actividad en vivo</h2>
                  <span className="dash-panel-spacer" />
                  <span className="dash-panel-note">últimos {turns.length}</span>
                </div>

                <div className="ac-feed">
                  {turns.length === 0 ? (
                    <p className="ac-feed-empty">Todavía no ha corrido ningún turno del agente.</p>
                  ) : (
                    turns.map((t) => {
                      const conversation = conversationsById.get(t.conversationId);
                      const name = conversation ? contactName(conversation) : "Conversación de prueba";
                      return (
                        <div className="ac-feed-row" key={t.id}>
                          <div className="ac-feed-head">
                            <span className="ac-feed-name">{name}</span>
                            {t.intent && (
                              <span className="ac-badge" data-tone={INTENT_TONE[t.intent]}>
                                {INTENT_LABEL[t.intent]}
                              </span>
                            )}
                            <span className="ac-badge" data-tone={ACTION_TONE[t.action]}>
                              {ACTION_LABEL[t.action]}
                            </span>
                            <span className="ac-feed-time">{timeLabel(t.createdAt)}</span>
                          </div>
                          {t.summary && <p className="ac-feed-summary">{t.summary}</p>}
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            </div>

            <section className="dash-panel">
              <div className="dash-panel-head">
                <h2 className="dash-panel-title">Probar el agente</h2>
                <span className="dash-panel-spacer" />
                <span className="dash-panel-note">No sale nada por WhatsApp real</span>
              </div>

              <div className="ac-sim">
                <p className="ac-sim-hint">
                  Escribe como si fueras el cliente. Corre sobre una conversación de prueba dedicada — nunca
                  toca un número real de WhatsApp.
                </p>
                <div className="ac-sim-row">
                  <textarea
                    className="ac-sim-textarea"
                    placeholder="Ej: ¿Tienes carburador para una Bera SBR 200?"
                    value={simText}
                    onChange={(e) => setSimText(e.target.value)}
                    disabled={simSending}
                  />
                  <button
                    className="crm-pill"
                    data-variant="solid"
                    type="button"
                    onClick={sendSimulatedMessage}
                    disabled={simSending || !simText.trim()}
                  >
                    {simSending ? "Enviando…" : "Enviar"}
                  </button>
                </div>
                {simError && <p className="ac-sim-error">{simError}</p>}
                {simOk && <p className="ac-sim-ok">{simOk}</p>}
              </div>
            </section>
            </>
            )}

            {tab === "agentes" && (
              <AgentsRosterPanel
                agents={agents}
                conversations={conversations}
                togglingAgentId={togglingAgentId}
                onToggleActive={toggleAgentActive}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
