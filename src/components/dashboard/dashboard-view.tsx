"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw, Route, TriangleAlert } from "lucide-react";
import type { Agent, ConversationSummary, HourlyActivity } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { fetchConversationRow, fetchDashboardConversations, fetchTodayActivity } from "@/lib/data";
import { useClock } from "@/lib/use-clock";
import { useLiveConversations } from "@/lib/use-live-conversations";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import {
  buildJourney,
  buildTicketStats,
  initials,
  isActive,
  ticketQueue,
} from "@/lib/dashboard";
import { AppRail } from "@/components/app-rail";
import { ActivityChart } from "@/components/dashboard/activity-chart";
import { JourneyBoard } from "@/components/dashboard/journey-board";
import { TicketQueuePanel } from "@/components/dashboard/ticket-queue";
import { TicketStatsPanel } from "@/components/dashboard/ticket-stats";
import "@/components/dashboard/dashboard.css";

/** Umbrales de carga por asesor: verde hasta 3 casos, ámbar hasta 6, rojo arriba.
 *  Usa las variantes "-fill": el color va de fondo con texto blanco encima, y
 *  son las que dan 4.5:1+ en los dos temas. */
const LOAD_THRESHOLDS = [
  { max: 3, color: "var(--lm-good-fill)" },
  { max: 6, color: "var(--lm-wait-fill)" },
  { max: Number.POSITIVE_INFINITY, color: "var(--lm-hot-fill)" },
];

interface DashboardViewProps {
  currentAgent: Agent;
  agents: Agent[];
  initialConversations: ConversationSummary[];
  initialActivity: HourlyActivity[];
  timeZone: string;
}

export function DashboardView({
  currentAgent,
  agents,
  initialConversations,
  initialActivity,
  timeZone,
}: DashboardViewProps) {
  const supabase = useMemo(() => createClient(), []);

  // El tablero sigue en vivo lo que pasa en la bandeja de todo el equipo.
  // Los reclamos salen de las etiquetas del contacto, por eso también se
  // escucha contact_tags. Lo que pide es el trabajo vivo más los reclamos —
  // nunca el histórico: con 600 conversaciones ya eran 235 KB por refetch, y
  // el costo crecía con cada cliente nuevo.
  const fetcher = useCallback(() => fetchDashboardConversations(supabase), [supabase]);
  // Un cambio de asesor o de venta sobre una conversación que ya está en el
  // tablero se resuelve pidiendo esa fila, no rearmando el tablero entero.
  const fetchRow = useCallback((id: string) => fetchConversationRow(supabase, id), [supabase]);
  const { conversations, refreshConversations } = useLiveConversations(supabase, initialConversations, {
    fetcher,
    fetchRow,
    watchContactTags: true,
    channelName: "dashboard-conversations",
  });

  const [activity, setActivity] = useState(initialActivity);
  const [refreshing, setRefreshing] = useState(false);
  const now = useClock();

  const refreshActivity = useCallback(async () => {
    try {
      setActivity(await fetchTodayActivity(supabase, timeZone));
    } catch {
      // El siguiente cambio en tiempo real reintentará la sincronización.
    }
  }, [supabase, timeZone]);

  // La gráfica de actividad cuenta mensajes por hora: lo suyo son los INSERT
  // de messages, no la lista de conversaciones. Separarlo evita que cada
  // mensaje entrante refetchee el histórico completo de conversaciones.
  const requestActivityRefresh = useLiveRefresh(refreshActivity);
  useEffect(() => {
    const channel = supabase
      .channel("dashboard-activity")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, () => {
        requestActivityRefresh();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, requestActivityRefresh]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshConversations(), refreshActivity()]);
    } finally {
      setRefreshing(false);
    }
  }, [refreshConversations, refreshActivity]);

  const stages = useMemo(() => buildJourney(conversations, now), [conversations, now]);
  const stats = useMemo(() => buildTicketStats(conversations, now), [conversations, now]);
  const tickets = useMemo(() => ticketQueue(conversations, now), [conversations, now]);

  const countIn = (id: string) => stages.find((s) => s.id === id)?.conversations.length ?? 0;
  const arriving = countIn("first_contact");
  const withAi = countIn("inquiry") + countIn("classifying") + countIn("tool_running");
  const withAgent = countIn("assigned");
  const stalledTotal = stages.reduce((sum, stage) => sum + stage.stalled, 0);

  const load = useMemo(() => agentLoad(agents, conversations), [agents, conversations]);

  return (
    <div className="dash">
      <div className="dash-frame">
        <AppRail active="recorrido" />

        <main className="dash-main">
          <div className="dash-content">
            <header className="dash-topbar">
              <p className="dash-brand">
                <span className="dash-brand-mark" aria-hidden="true">
                  <Route size={14} />
                </span>
                <span className="dash-brand-name">SBK Motorcycles</span>
              </p>

              <nav className="dash-nav" aria-label="Navegación principal">
                <Link className="dash-nav-link" href="/" aria-current="page">
                  Recorrido
                </Link>
                <Link className="dash-nav-link" href="/inbox">
                  Bandeja
                </Link>
                <a className="dash-nav-link" href="#actividad">
                  Actividad
                </a>
                <a className="dash-nav-link" href="#reclamos">
                  Reclamos
                </a>
                <Link className="dash-nav-link" href="/clientes">
                  Clientes
                </Link>
                <Link className="dash-nav-link" href="/ventas">
                  Ventas
                </Link>
                <Link className="dash-nav-link" href="/inventario">
                  Inventario
                </Link>
                <Link className="dash-nav-link" href="/agent-control">
                  Control IA
                </Link>
              </nav>

              <div className="dash-topbar-actions">
                <button
                  className="dash-icon-btn"
                  type="button"
                  onClick={refresh}
                  aria-label="Actualizar datos"
                  disabled={refreshing}
                >
                  <RefreshCw size={16} className={refreshing ? "dash-spin" : undefined} />
                </button>
                <span className="dash-icon-btn dash-icon-static" title={currentAgent.displayName}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>
                    {initials(currentAgent.displayName)}
                  </span>
                </span>
              </div>
            </header>

            <div className="dash-header">
              <div>
                <h1 className="dash-title dash-display">Recorrido del cliente</h1>
                <p className="dash-subtitle">
                  De la primera línea que escribe un cliente por WhatsApp hasta el asesor que
                  cierra la venta.
                </p>
              </div>

              <div className="dash-pulse">
                <PulseItem value={arriving} label="Nuevos" />
                <span className="dash-pulse-rule" />
                <PulseItem value={withAi} label="Con la IA" />
                <span className="dash-pulse-rule" />
                <PulseItem value={withAgent} label="Con asesor" />
              </div>
            </div>

            <section className="dash-panel dash-board">
              <div className="dash-board-head">
                <h2 className="dash-board-title">Flujo de hoy</h2>

                <div className="dash-avatars">
                  {load.map(({ agent, open }) => (
                    <span
                      className="dash-avatar-stack"
                      key={agent.id}
                      title={`${agent.displayName}: ${open} casos abiertos`}
                    >
                      <span className="dash-avatar">{initials(agent.displayName)}</span>
                      <span
                        className="dash-avatar-count dash-num"
                        style={{ background: loadColor(open) }}
                      >
                        {open}
                      </span>
                    </span>
                  ))}
                </div>

                {stalledTotal > 0 && (
                  <span className="dash-stage-alert">
                    <TriangleAlert size={12} strokeWidth={2.4} />
                    <span className="dash-num">{stalledTotal}</span> atascados
                  </span>
                )}
              </div>

              <JourneyBoard stages={stages} now={now} />
            </section>

            <div id="actividad">
              <ActivityChart data={activity} timeZone={timeZone} />
            </div>

            <div className="dash-lower" id="reclamos">
              <TicketQueuePanel tickets={tickets} now={now} />
              <TicketStatsPanel stats={stats} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function PulseItem({ value, label }: { value: number; label: string }) {
  return (
    <span className="dash-pulse-item">
      <span className="dash-pulse-value dash-num">{value}</span>
      <span className="dash-pulse-label">{label}</span>
    </span>
  );
}

/** Casos abiertos por asesor, el equipo ordenado de más a menos cargado. */
function agentLoad(agents: Agent[], conversations: ConversationSummary[]) {
  return agents
    .map((agent) => ({
      agent,
      open: conversations.filter((c) => c.assignedAgent?.id === agent.id && isActive(c)).length,
    }))
    .sort((a, b) => b.open - a.open);
}

function loadColor(open: number): string {
  return LOAD_THRESHOLDS.find((t) => open <= t.max)!.color;
}
