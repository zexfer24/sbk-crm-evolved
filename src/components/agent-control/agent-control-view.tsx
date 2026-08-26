"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Modal, toast } from "@heroui/react";
import { BookOpen, Bot, ShieldAlert, Users, Wrench, Zap } from "lucide-react";
import type { BacklogCounts } from "@/lib/data";
import type {
  Agent,
  AgentIntent,
  AgentSettings,
  AgentMetrics,
  AgentSuggestion,
  AgentTool,
  AgentTurn,
  AgentTurnAction,
  BoardConversation,
  KnowledgeCategory,
  KnowledgeEntry,
  ModelPricing,
  ModelUsageSummary,
  Playbook,
  QuickReply,
  Tag,
  TokenUsageSummary,
} from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import {
  fetchAgentSettings,
  fetchAgentSuggestions,
  fetchAgentTools,
  fetchAgentTurns,
  fetchAgentMetrics,
  fetchAllAgents,
  fetchBoardConversationRow,
  fetchBoardConversations,
  fetchKnowledgeCategories,
  fetchKnowledgeEntries,
  fetchModelPricing,
  fetchBacklogCounts,
  fetchPlaybooks,
  fetchTokenUsageSummary,
  fetchUnmatchedTurns,
} from "@/lib/data";
import {
  createAgentSuggestion,
  intervene,
  markSuggestionReviewed,
  setAgentActive,
  setAgentToolEnabled,
  setAiEnabled,
  setAiGloballyEnabled,
  setDailySpendCap,
  updateModelPricing,
} from "@/lib/mutations";
import { contactName, initials } from "@/lib/dashboard";
import { TOOL_KEYS } from "@/lib/agent-tool-keys";
import { formatTime12h } from "@/lib/format";
import { useLiveConversations } from "@/lib/use-live-conversations";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import { AgentsRosterPanel } from "@/components/agent-control/agent-roster-panel";
import { AgentToolsPanel } from "@/components/agent-control/agent-tools-panel";
import { KnowledgePanel } from "@/components/agent-control/knowledge-panel";
import { PlaybooksPanel } from "@/components/agent-control/playbooks-panel";
import { SlidingPills } from "@/components/sliding-pills";
import { AppRail, AppTopNav } from "@/components/app-rail";
import { SpendCapPanel } from "@/components/agent-control/spend-cap-panel";
import { TokenUsageChart } from "@/components/agent-control/token-usage-chart";
// crm.css trae .crm-pill, que esta vista usa para los botones de acción de
// cada conversación. Sin este import quedaban sin estilo: el ícono se
// apilaba encima del texto y no se veían como botones.
import "@/components/crm.css";
import "@/components/dashboard/dashboard.css";
import "@/components/agent-control/agent-control.css";

interface AgentControlViewProps {
  currentAgent: Agent;
  initialConversations: BoardConversation[];
  initialTurns: AgentTurn[];
  initialSettings: AgentSettings;
  initialAgents: Agent[];
  initialTokenUsage: TokenUsageSummary;
  initialPricing: ModelPricing[];
  initialSuggestions: AgentSuggestion[];
  initialAgentMetrics: AgentMetrics[];
  initialPlaybooks: Playbook[];
  initialUnmatchedTurns: AgentTurn[];
  initialQuickReplies: QuickReply[];
  initialAgentTools: AgentTool[];
  initialKnowledgeCategories: KnowledgeCategory[];
  initialKnowledgeEntries: KnowledgeEntry[];
  /** Catálogo de etiquetas del CRM: lo elige el formulario de escenarios. */
  initialTags: Tag[];
  modelLabel: string;
}

type AgentControlTab = "ia" | "respuestas" | "biblioteca" | "herramientas" | "agentes";

// ---------------------------------------------------------------------------
// Ritmo del repaso del atraso, para poder decírselo a quien aprieta el botón.
// Espeja MAX_PER_RUN de src/lib/ai/queue.ts y el intervalo del cron de
// docs/PRODUCCION.md. Es una estimación que se muestra, no un parámetro: si
// alguno de los dos cambia, acá solo se desactualiza el texto.
// ---------------------------------------------------------------------------
const TURNOS_POR_PASADA = 10;
const MINUTOS_ENTRE_PASADAS = 5;

function duracionDelLote(conversaciones: number): string {
  const minutos = Math.ceil(conversaciones / TURNOS_POR_PASADA) * MINUTOS_ENTRE_PASADAS;
  if (minutos <= 5) return "unos minutos";
  if (minutos < 60) return `unos ${minutos} minutos`;
  const horas = Math.round((minutos / 60) * 2) / 2;
  return horas === 1 ? "una hora" : `unas ${horas.toLocaleString("es-VE")} horas`;
}

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

const TAB_TITLE: Record<AgentControlTab, string> = {
  ia: "Control del agente de IA",
  respuestas: "Respuestas predeterminadas",
  biblioteca: "Biblioteca de conocimiento",
  herramientas: "Herramientas de la IA",
  agentes: "Control de agentes",
};

const TAB_SUBTITLE: Record<AgentControlTab, string> = {
  ia: "Interruptor general, qué está haciendo la IA ahora mismo, y un simulador para probarla sin necesidad de WhatsApp real.",
  respuestas:
    "Los casos que la IA ya sabe resolver con un texto tuyo, y los mensajes de clientes que todavía no calzan con ninguno.",
  biblioteca:
    "Lo que la IA sabe de la tienda más allá del catálogo: envíos, pagos, garantías, horarios… Escríbelo o importa un .md y la IA lo usa al responder.",
  herramientas:
    "Enciende o apaga cada capacidad de la IA por separado, sin apagarla completa: ella sigue atendiendo con lo que tenga disponible.",
  agentes:
    "Quién está disponible para que la IA le pase conversaciones, cuánta carga lleva encima y cómo viene rindiendo: hoy y en los últimos 30 días.",
};

function timeLabel(iso: string): string {
  return formatTime12h(iso);
}

export function AgentControlView({
  currentAgent,
  initialConversations,
  initialTurns,
  initialSettings,
  initialAgents,
  initialTokenUsage,
  initialPricing,
  initialSuggestions,
  initialAgentMetrics,
  initialPlaybooks,
  initialUnmatchedTurns,
  initialQuickReplies,
  initialAgentTools,
  initialKnowledgeCategories,
  initialKnowledgeEntries,
  initialTags,
  modelLabel,
}: AgentControlViewProps) {
  const supabase = useMemo(() => createClient(), []);

  const [tab, setTab] = useState<AgentControlTab>("ia");
  // La lista viva de conversaciones va por su propio carril: el hook aplica
  // en memoria lo que el evento ya trae y solo refetchea lo que arrastra
  // relaciones. Se pide únicamente el trabajo vivo: la cola de la IA y el
  // roster no miran conversaciones cerradas, y pedir el histórico completo
  // hacía crecer este panel con cada cliente nuevo.
  const fetcher = useCallback(
    () => fetchBoardConversations(supabase, { activeOnly: true }),
    [supabase]
  );
  // Un cambio de asesor o de venta sobre una conversación que ya está en el
  // panel se resuelve pidiendo esa fila, no rearmando la lista entera.
  const fetchRow = useCallback(
    (id: string) => fetchBoardConversationRow(supabase, id),
    [supabase]
  );
  const { conversations, refreshConversations } = useLiveConversations(supabase, initialConversations, {
    fetcher,
    fetchRow,
    channelName: "agent-control-conversations",
  });
  const [turns, setTurns] = useState(initialTurns);
  const [settings, setSettings] = useState(initialSettings);
  const [agents, setAgents] = useState(initialAgents);
  const [tokenUsage, setTokenUsage] = useState(initialTokenUsage);
  const [pricing, setPricing] = useState(initialPricing);
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  const [agentMetrics, setAgentMetrics] = useState(initialAgentMetrics);
  const [playbooks, setPlaybooks] = useState(initialPlaybooks);
  const [unmatchedTurns, setUnmatchedTurns] = useState(initialUnmatchedTurns);
  const [agentTools, setAgentTools] = useState(initialAgentTools);
  const [knowledgeCategories, setKnowledgeCategories] = useState(initialKnowledgeCategories);
  const [knowledgeEntries, setKnowledgeEntries] = useState(initialKnowledgeEntries);
  const [togglingKillSwitch, setTogglingKillSwitch] = useState(false);
  const [confirmingAiOn, setConfirmingAiOn] = useState(false);
  // null mientras se cuenta. El diálogo no deja encender hasta tener el
  // número: encender a ciegas es exactamente lo que ya pasó una vez.
  const [backlog, setBacklog] = useState<BacklogCounts | null>(null);
  const [backlogFailed, setBacklogFailed] = useState(false);
  const [busyConversationId, setBusyConversationId] = useState<string | null>(null);
  const [togglingAgentId, setTogglingAgentId] = useState<string | null>(null);
  const [togglingToolKey, setTogglingToolKey] = useState<string | null>(null);

  const [simText, setSimText] = useState("");
  const [simConversationId, setSimConversationId] = useState<string | null>(null);
  const [simSending, setSimSending] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [simOk, setSimOk] = useState<string | null>(null);

  const [suggestionText, setSuggestionText] = useState("");
  const [sendingSuggestion, setSendingSuggestion] = useState(false);
  const [resolvingSuggestionId, setResolvingSuggestionId] = useState<string | null>(null);

  // Todo lo del panel menos las conversaciones, que van por su propio carril.
  const refresh = useCallback(async () => {
    try {
      const [
        nextTurns,
        nextSettings,
        nextAgents,
        nextTokenUsage,
        nextPricing,
        nextSuggestions,
        nextPlaybooks,
        nextAgentMetrics,
        nextUnmatched,
        nextAgentTools,
        nextKnowledgeCategories,
        nextKnowledgeEntries,
      ] = await Promise.all([
        fetchAgentTurns(supabase),
        fetchAgentSettings(supabase),
        fetchAllAgents(supabase),
        fetchTokenUsageSummary(supabase),
        fetchModelPricing(supabase),
        fetchAgentSuggestions(supabase),
        fetchPlaybooks(supabase),
        fetchAgentMetrics(supabase),
        fetchUnmatchedTurns(supabase),
        fetchAgentTools(supabase),
        fetchKnowledgeCategories(supabase),
        fetchKnowledgeEntries(supabase),
      ]);
      setTurns(nextTurns);
      setSettings(nextSettings);
      setAgents(nextAgents);
      setTokenUsage(nextTokenUsage);
      setPricing(nextPricing);
      setSuggestions(nextSuggestions);
      setPlaybooks(nextPlaybooks);
      setAgentMetrics(nextAgentMetrics);
      setUnmatchedTurns(nextUnmatched);
      setAgentTools(nextAgentTools);
      setKnowledgeCategories(nextKnowledgeCategories);
      setKnowledgeEntries(nextKnowledgeEntries);
    } catch {
      // El siguiente cambio en tiempo real reintentará la sincronización.
    }
  }, [supabase]);

  // Agrupado y consciente de la pestaña: los eventos de estas tablas no
  // deben costar trece consultas cada uno en un panel que nadie está mirando.
  const scheduleRefresh = useLiveRefresh(refresh);

  useEffect(() => {
    const channel = supabase
      .channel("agent-control-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_turns" }, () => scheduleRefresh())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "agent_settings" }, () => scheduleRefresh())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "agents" }, () => scheduleRefresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_suggestions" }, () => scheduleRefresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "ai_playbooks" }, () => scheduleRefresh())
      // Las etiquetas de un escenario viven en su propia tabla: sin esto, el
      // guardado que solo las cambia llegaría después del refresco y no se vería.
      .on("postgres_changes", { event: "*", schema: "public", table: "ai_playbook_tags" }, () => scheduleRefresh())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "agent_tools" }, () => scheduleRefresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "knowledge_categories" }, () => scheduleRefresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "knowledge_entries" }, () => scheduleRefresh())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, scheduleRefresh]);

  async function toggleTool(tool: AgentTool) {
    setTogglingToolKey(tool.key);
    try {
      await setAgentToolEnabled(supabase, currentAgent, tool.key, !tool.isEnabled);
      await refresh();
    } finally {
      setTogglingToolKey(null);
    }
  }

  async function toggleAgentActive(agent: Agent) {
    setTogglingAgentId(agent.id);
    try {
      await setAgentActive(supabase, agent.id, !agent.isActive);
      await refresh();
    } finally {
      setTogglingAgentId(null);
    }
  }

  /**
   * Qué tan manca está la IA ahora mismo. Sin biblioteca y sin catálogo saluda
   * bien y no puede responder casi nada de fondo: termina pasando el caso a un
   * asesor. Con 117 conversaciones eso no es una respuesta automática, es un
   * reparto de trabajo, y quien aprieta el botón tiene que saberlo antes.
   */
  const carenciaDeLaIa = useMemo(() => {
    const bibliotecaVacia = knowledgeEntries.length === 0;
    const catalogoApagado = !agentTools.some((tool) => tool.key === TOOL_KEYS.catalog && tool.isEnabled);

    if (bibliotecaVacia && catalogoApagado) {
      return "La biblioteca de conocimiento está vacía y la consulta de productos está apagada: la IA va a saludar bien y terminar pasando casi todo a un asesor.";
    }
    if (bibliotecaVacia) {
      return "La biblioteca de conocimiento está vacía: la IA no va a poder responder nada sobre envíos, pagos ni garantías.";
    }
    if (catalogoApagado) {
      return "La consulta de productos está apagada: la IA no va a poder decir si hay un repuesto ni cuánto cuesta.";
    }
    return null;
  }, [agentTools, knowledgeEntries]);

  const liveConversations = useMemo(
    () =>
      conversations
        .filter((c) => c.aiEnabled && !c.assignedAgent && c.status !== "closed")
        .sort((a, b) => new Date(b.lastMessageAt ?? b.createdAt).getTime() - new Date(a.lastMessageAt ?? a.createdAt).getTime()),
    [conversations]
  );

  const pricingByModel = useMemo(() => new Map(pricing.map((p) => [p.model, p])), [pricing]);

  /**
   * Apagar es inmediato: es el freno de emergencia y no se le pone un paso
   * más. Encender pasa por confirmación: es el único botón del CRM que le
   * escribe a clientes reales sin revisión previa, y ya se encendió por
   * error una vez — en el minuto que tardó en notarse salieron dos
   * respuestas automáticas a un cliente de verdad.
   */
  function toggleKillSwitch() {
    if (!settings.aiGloballyEnabled) {
      // El número se cuenta en la base cada vez que se abre el diálogo. Antes
      // se mostraba el largo de la lista cargada en memoria, que es otra cosa:
      // decía a cuántas conversaciones PODRÍA escribirles cuando el cliente
      // volviera a escribir, no a cuántas les va a escribir ahora mismo.
      setBacklog(null);
      setBacklogFailed(false);
      setConfirmingAiOn(true);
      void fetchBacklogCounts(supabase)
        .then(setBacklog)
        .catch(() => setBacklogFailed(true));
      return;
    }
    void switchAi(false);
  }

  async function switchAi(next: boolean) {
    setTogglingKillSwitch(true);
    try {
      if (!next) {
        // Apagar NO es escribir el interruptor y ya. Eso dejaba vivos los
        // turnos en vuelo y la cola llena, y el dueño veía salir mensajes
        // después de haber apagado. La ruta apaga y vacía lo pendiente en la
        // misma operación. Ver src/app/api/agent/stop/route.ts.
        const response = await fetch("/api/agent/stop", { method: "POST" });
        const payload = (await response.json().catch(() => null)) as {
          discarded?: number | null;
          warning?: string;
        } | null;

        if (!response.ok) {
          toast.danger("No se pudo apagar la IA. Vuelve a intentarlo.");
          return;
        }

        setSettings((s) => ({ ...s, aiGloballyEnabled: false }));

        if (payload?.warning) toast.danger(payload.warning);
        else if (payload?.discarded) {
          toast.info(
            payload.discarded === 1
              ? "IA apagada. Se descartó 1 turno que estaba esperando."
              : `IA apagada. Se descartaron ${payload.discarded} turnos que estaban esperando.`
          );
        }

        setConfirmingAiOn(false);
        return;
      }

      await setAiGloballyEnabled(supabase, currentAgent, true);
      setSettings((s) => ({ ...s, aiGloballyEnabled: true }));

      // El interruptor ya quedó encendido. Si el repaso falla, la IA sigue
      // atendiendo lo que entre de ahora en adelante —el comportamiento de
      // siempre— y el atraso se queda esperando: se avisa y no se revierte,
      // porque apagar la IA por su cuenta sería una sorpresa peor.
      const response = await fetch("/api/agent/backlog", { method: "POST" });
      if (!response.ok) {
        toast.danger("La IA quedó encendida, pero no se pudo repasar lo que ya estaba esperando.");
      }

      setConfirmingAiOn(false);
    } finally {
      setTogglingKillSwitch(false);
    }
  }

  async function saveSpendCap(capUsd: number | null) {
    await setDailySpendCap(supabase, currentAgent, capUsd);
    setSettings((s) => ({ ...s, dailySpendCapUsd: capUsd }));
  }

  async function pauseAi(conversationId: string) {
    setBusyConversationId(conversationId);
    try {
      await setAiEnabled(supabase, conversationId, currentAgent, false);
      // La conversación cambió por una acción de quien mira: se refresca ya,
      // sin esperar a que el evento de realtime dé la vuelta.
      await Promise.all([refresh(), refreshConversations()]);
    } finally {
      setBusyConversationId(null);
    }
  }

  async function takeOver(conversationId: string) {
    setBusyConversationId(conversationId);
    try {
      await intervene(supabase, conversationId, currentAgent);
      await Promise.all([refresh(), refreshConversations()]);
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

  async function savePricing(model: string, inputPricePerMillion: number, outputPricePerMillion: number) {
    await updateModelPricing(supabase, model, inputPricePerMillion, outputPricePerMillion, currentAgent);
    await refresh();
  }

  async function sendSuggestion() {
    if (!suggestionText.trim()) return;
    setSendingSuggestion(true);
    try {
      await createAgentSuggestion(supabase, currentAgent, suggestionText.trim());
      setSuggestionText("");
      await refresh();
    } finally {
      setSendingSuggestion(false);
    }
  }

  async function resolveSuggestion(id: string) {
    setResolvingSuggestionId(id);
    try {
      await markSuggestionReviewed(supabase, id, currentAgent);
      await refresh();
    } finally {
      setResolvingSuggestionId(null);
    }
  }

  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active="control" />

        <main className="dash-main">
          <div className="dash-content">
            <header className="dash-topbar">
              <p className="dash-brand">
                <span className="dash-brand-mark" aria-hidden="true">
                  <Bot size={14} />
                </span>
                <span className="dash-brand-name">SBK Motorcycles</span>
              </p>

              <AppTopNav active="control" />

              <div className="dash-topbar-actions">
                <span className="dash-icon-btn dash-icon-static" title={currentAgent.displayName}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{initials(currentAgent.displayName)}</span>
                </span>
              </div>
            </header>

            <div className="dash-header">
              <div>
                <h1 className="dash-title dash-display">{TAB_TITLE[tab]}</h1>
                <p className="dash-subtitle">{TAB_SUBTITLE[tab]}</p>
              </div>
            </div>

            <SlidingPills
              className="ac-tabs"
              tone="segmented"
              variant="tablist"
              ariaLabel="Secciones de control"
              value={tab}
              onChange={setTab}
              items={[
                { value: "ia", label: "Control de IA" },
                { value: "respuestas", label: "Respuestas", icon: <Zap size={13} />, count: playbooks.length },
                {
                  value: "biblioteca",
                  label: "Biblioteca",
                  icon: <BookOpen size={13} />,
                  count: knowledgeEntries.length,
                },
                {
                  value: "herramientas",
                  label: "Herramientas",
                  icon: <Wrench size={13} />,
                  count: agentTools.length,
                },
                { value: "agentes", label: "Agentes", icon: <Users size={13} />, count: agents.length },
              ]}
            />
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

            <Modal isOpen={confirmingAiOn} onOpenChange={(open) => !open && setConfirmingAiOn(false)}>
              <Modal.Backdrop>
                <Modal.Container size="sm" placement="center">
                  <Modal.Dialog>
                    <Modal.Header>
                      <Modal.Heading>¿Encender la IA para todo el CRM?</Modal.Heading>
                      <Modal.CloseTrigger />
                    </Modal.Header>
                    <Modal.Body className="flex flex-col gap-2">
                      {backlogFailed ? (
                        <p className="text-sm">
                          No se pudo contar cuántas conversaciones están esperando respuesta. Cierra y
                          vuelve a intentar: encender sin ese número es disparar a ciegas.
                        </p>
                      ) : backlog === null ? (
                        <p className="text-sm text-muted">Contando cuántas conversaciones están esperando…</p>
                      ) : (
                        <>
                          <p className="text-sm">
                            Ahora mismo hay <strong className="lm-num">{backlog.inWindow}</strong>{" "}
                            {backlog.inWindow === 1
                              ? "conversación esperando respuesta"
                              : "conversaciones esperando respuesta"}{" "}
                            dentro de la ventana de 24 h.{" "}
                            <strong>
                              {backlog.inWindow === 1 ? "Le va a escribir" : "Les va a escribir a todas"}
                            </strong>{" "}
                            — clientes reales, sin revisión previa.
                          </p>

                          {backlog.inWindow > 0 && (
                            <p className="text-xs text-muted">
                              No salen de golpe: unas {TURNOS_POR_PASADA} cada {MINUTOS_ENTRE_PASADAS} minutos,{" "}
                              {duracionDelLote(backlog.inWindow)} el lote completo. Apagar la IA detiene en
                              seco lo que quede sin enviar.
                            </p>
                          )}

                          {backlog.outOfWindow > 0 && (
                            <p className="text-xs text-muted">
                              Otras <strong className="lm-num">{backlog.outOfWindow}</strong> llevan más de
                              24 h esperando: a esas <strong>no</strong> les escribe. Pasado ese punto
                              WhatsApp solo acepta una plantilla aprobada.
                            </p>
                          )}

                          {carenciaDeLaIa && <p className="ac-kill-warn">{carenciaDeLaIa}</p>}
                        </>
                      )}

                      <p className="text-xs text-muted">
                        Si venías a apagar algo, este no es el botón: la IA está apagada ahora.
                      </p>
                    </Modal.Body>
                    <Modal.Footer className="justify-end gap-2">
                      <Button size="sm" variant="secondary" onPress={() => setConfirmingAiOn(false)}>
                        Cancelar
                      </Button>
                      <Button
                        size="sm"
                        isDisabled={togglingKillSwitch || backlog === null}
                        onPress={() => void switchAi(true)}
                      >
                        <Zap size={14} />
                        Encender la IA
                      </Button>
                    </Modal.Footer>
                  </Modal.Dialog>
                </Modal.Container>
              </Modal.Backdrop>
            </Modal>

            <SpendCapPanel
              settings={settings}
              canEdit={currentAgent.role === "supervisor" || currentAgent.role === "admin"}
              onSave={saveSpendCap}
            />

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
                      // El nombre viaja con el turno: buscarlo en la lista de
                      // conversaciones fallaba en cuanto el hilo se cerraba y
                      // salía de la lista del panel.
                      const name = t.contactName ?? "Conversación de prueba";
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
                <h2 className="dash-panel-title">Consumo de tokens</h2>
                <span className="dash-panel-spacer" />
                <span className="dash-panel-note">últimos 30 días</span>
              </div>

              <div className="ac-tokens-stats">
                <div className="ac-tokens-stat">
                  <span className="ac-tokens-stat-value dash-num">{tokenUsage.totalTokens.toLocaleString("es-VE")}</span>
                  <span className="ac-tokens-stat-label">tokens totales</span>
                </div>
                <div className="ac-tokens-stat">
                  <span className="ac-tokens-stat-value dash-num">
                    {tokenUsage.hasUnpricedModels ? "≥ " : ""}
                    {formatUsd(tokenUsage.totalUsd)}
                  </span>
                  <span className="ac-tokens-stat-label">equivalente en USD</span>
                </div>
              </div>

              <TokenUsageChart data={tokenUsage.byDay} />

              <div className="ac-model-list">
                {tokenUsage.byModel.length === 0 ? (
                  <p className="ac-live-empty">Todavía no hay consumo registrado.</p>
                ) : (
                  tokenUsage.byModel.map((usage) => (
                    <ModelPricingRow
                      key={usage.model}
                      usage={usage}
                      pricing={pricingByModel.get(usage.model)}
                      onSave={savePricing}
                    />
                  ))
                )}
              </div>
            </section>

            <section className="dash-panel">
              <div className="dash-panel-head">
                <h2 className="dash-panel-title">Sugerencias al supervisor</h2>
                <span className="dash-panel-spacer" />
                <span className="dash-panel-note">
                  {suggestions.filter((s) => s.status === "pending").length} pendientes
                </span>
              </div>

              <div className="ac-suggest">
                <div className="ac-suggest-row">
                  <textarea
                    className="ac-sim-textarea"
                    placeholder="Ej: los clientes preguntan mucho por envíos a Maracaibo y el bot no sabe responder eso todavía."
                    value={suggestionText}
                    onChange={(e) => setSuggestionText(e.target.value)}
                    disabled={sendingSuggestion}
                  />
                  <button
                    className="crm-pill"
                    data-variant="solid"
                    type="button"
                    onClick={sendSuggestion}
                    disabled={sendingSuggestion || !suggestionText.trim()}
                  >
                    {sendingSuggestion ? "Enviando…" : "Enviar"}
                  </button>
                </div>

                <div className="ac-suggest-list">
                  {suggestions.length === 0 ? (
                    <p className="ac-feed-empty">Todavía no hay sugerencias registradas.</p>
                  ) : (
                    suggestions.map((s) => (
                      <div className="ac-feed-row" key={s.id}>
                        <div className="ac-feed-head">
                          <span className="ac-feed-name">{s.agentName ?? "Asesor"}</span>
                          <span className="ac-badge" data-tone={s.status === "pending" ? "wait" : "good"}>
                            {s.status === "pending" ? "Pendiente" : "Revisada"}
                          </span>
                          <span className="ac-feed-time">{timeLabel(s.createdAt)}</span>
                          {s.status === "pending" && currentAgent.role !== "agent" && (
                            <button
                              className="crm-pill"
                              type="button"
                              onClick={() => resolveSuggestion(s.id)}
                              disabled={resolvingSuggestionId === s.id}
                            >
                              Marcar revisada
                            </button>
                          )}
                        </div>
                        <p className="ac-feed-summary">{s.content}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>

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

            {tab === "respuestas" && (
              <PlaybooksPanel
                playbooks={playbooks}
                unmatchedTurns={unmatchedTurns}
                quickReplies={initialQuickReplies}
                tags={initialTags}
                canEdit={currentAgent.role === "supervisor" || currentAgent.role === "admin"}
              />
            )}

            {tab === "biblioteca" && (
              <KnowledgePanel
                currentAgent={currentAgent}
                categories={knowledgeCategories}
                entries={knowledgeEntries}
                canEdit={currentAgent.role === "supervisor" || currentAgent.role === "admin"}
              />
            )}

            {tab === "herramientas" && (
              <AgentToolsPanel
                tools={agentTools}
                canEdit={currentAgent.role === "supervisor" || currentAgent.role === "admin"}
                togglingKey={togglingToolKey}
                onToggle={toggleTool}
              />
            )}

            {tab === "agentes" && (
              <AgentsRosterPanel
                agents={agents}
                conversations={conversations}
                metrics={agentMetrics}
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

function ModelPricingRow({
  usage,
  pricing,
  onSave,
}: {
  usage: ModelUsageSummary;
  pricing: ModelPricing | undefined;
  onSave: (model: string, inputPricePerMillion: number, outputPricePerMillion: number) => Promise<void>;
}) {
  const [inputPrice, setInputPrice] = useState(String(pricing?.inputPricePerMillion ?? ""));
  const [outputPrice, setOutputPrice] = useState(String(pricing?.outputPricePerMillion ?? ""));
  const [saving, setSaving] = useState(false);

  async function save() {
    if (inputPrice.trim() === "" || outputPrice.trim() === "") return;
    const input = Number(inputPrice);
    const output = Number(outputPrice);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return;
    setSaving(true);
    try {
      await onSave(usage.model, input, output);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ac-model-row">
      <div className="ac-model-row-head">
        <span className="ac-model-name">{usage.model}</span>
        <span className="ac-model-tokens dash-num">{usage.totalTokens.toLocaleString("es-VE")} tokens</span>
        <span className="ac-model-usd dash-num">
          {usage.usdCost !== null ? formatUsd(usage.usdCost) : "sin tarifa"}
          {usage.usdCost !== null && !pricing?.updatedBy && <span className="ac-model-usd-note"> · tarifa de ejemplo</span>}
        </span>
      </div>
      <div className="ac-model-pricing">
        <label className="ac-pricing-field">
          $/1M input
          <input
            type="number"
            step="0.0001"
            min="0"
            className="ac-pricing-input"
            value={inputPrice}
            onChange={(e) => setInputPrice(e.target.value)}
            disabled={saving}
          />
        </label>
        <label className="ac-pricing-field">
          $/1M output
          <input
            type="number"
            step="0.0001"
            min="0"
            className="ac-pricing-input"
            value={outputPrice}
            onChange={(e) => setOutputPrice(e.target.value)}
            disabled={saving}
          />
        </label>
        <button
          className="crm-pill"
          type="button"
          onClick={save}
          disabled={saving || !inputPrice.trim() || !outputPrice.trim()}
        >
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
