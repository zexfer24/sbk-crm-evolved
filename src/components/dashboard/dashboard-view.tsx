"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw, Route, TriangleAlert } from "lucide-react";
import type { Agent, BoardConversation, HourlyActivity, TicketTagsByContact } from "@/lib/types";
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from "@/lib/business-hours";
import { createClient } from "@/lib/supabase/client";
import {
  fetchBoardConversationRow,
  fetchDashboardConversations,
  fetchTodayActivity,
} from "@/lib/data";
import { fetchLeadTotal } from "@/lib/dashboard-data";
import { useClock } from "@/lib/use-clock";
import { useInboxDay } from "@/lib/use-inbox-day";
import { matchesDay } from "@/lib/inbox-filters";
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
  initialConversations: BoardConversation[];
  /** Qué contactos tienen etiqueta de reclamo: no viaja en la fila (ver types.ts). */
  initialTicketTags: TicketTagsByContact;
  initialActivity: HourlyActivity[];
  /**
   * "Total de leads" (T2, corrida "Los números del día", 10/9/2026): a
   * diferencia del resto del pulso —que corta por hoy—, este número es
   * acumulado a propósito (ver el comentario de `fetchLeadTotal`,
   * `dashboard-data.ts`); llega sembrado del servidor y el `fetcher` de
   * `useLiveConversations` lo vuelve a pedir en cada refresco.
   */
  initialLeadTotal: number;
  timeZone: string;
  /**
   * Horario de atención para medir "Con asesor" en minutos laborales, no de
   * pared (Frente A, "El reloj dice la verdad", 5/9/2026). Por ahora la
   * página no lo pasa y queda en el default del seed; B3 lo conecta a
   * `fetchAgentSettings`.
   */
  businessHours?: BusinessHours;
}

export function DashboardView({
  currentAgent,
  agents,
  initialConversations,
  initialTicketTags,
  initialActivity,
  initialLeadTotal,
  timeZone,
  businessHours = DEFAULT_BUSINESS_HOURS,
}: DashboardViewProps) {
  const supabase = useMemo(() => createClient(), []);

  // El corte "habló hoy" del Recorrido: la MISMA medianoche de Caracas que ya
  // usa la bandeja (T2, corrida "Los números del día", 10/9/2026 — ver el
  // comentario de `useInboxDay`, "ÚNICA fuente del corte"). "today" fijo: el
  // tablero no tiene interruptor "Ver todo", siempre muestra el día en curso.
  const dayStart = useInboxDay("today");

  // El tablero sigue en vivo lo que pasa en la bandeja de todo el equipo.
  // Los reclamos salen de las etiquetas del contacto, por eso también se
  // escucha contact_tags. Lo que pide es el trabajo vivo más los reclamos —
  // nunca el histórico: con 600 conversaciones ya eran 235 KB por refetch, y
  // el costo crecía con cada cliente nuevo.
  const [ticketTags, setTicketTags] = useState<TicketTagsByContact>(initialTicketTags);
  const [leadTotal, setLeadTotal] = useState(initialLeadTotal);

  // Las etiquetas de reclamo llegan por su propio camino —dos consultas
  // planas— y no embebidas en cada una de las cientos de filas del tablero.
  // El mismo viaje que rearma la lista las trae al día. "Total de leads"
  // (T2, 10/9/2026) viaja en el MISMO `Promise.all`, pero su propio
  // `.catch()`: un tropiezo puntual en ese conteo no tiene por qué tirar el
  // refresco de conversaciones/etiquetas — conserva el número anterior y
  // el siguiente evento en tiempo real reintenta.
  const fetcher = useCallback(async () => {
    const [{ conversations, ticketTags: tags }] = await Promise.all([
      fetchDashboardConversations(supabase),
      fetchLeadTotal(supabase)
        .then(setLeadTotal)
        .catch(() => {
          // Conserva `leadTotal` tal como estaba; ver el comentario de arriba.
        }),
    ]);
    setTicketTags(tags);
    return conversations;
  }, [supabase]);

  // Un cambio de asesor o de venta sobre una conversación que ya está en el
  // tablero se resuelve pidiendo esa fila, no rearmando el tablero entero.
  const fetchRow = useCallback(
    (id: string) => fetchBoardConversationRow(supabase, id),
    [supabase]
  );
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

  const stages = useMemo(
    () => buildJourney(conversations, now, businessHours, dayStart),
    [conversations, now, businessHours, dayStart]
  );
  const stats = useMemo(
    () => buildTicketStats(conversations, now, ticketTags),
    [conversations, now, ticketTags]
  );
  const tickets = useMemo(
    () => ticketQueue(conversations, now, ticketTags),
    [conversations, now, ticketTags]
  );

  const countIn = (id: string) => stages.find((s) => s.id === id)?.conversations.length ?? 0;
  const arriving = countIn("first_contact");
  const withAi = countIn("inquiry") + countIn("classifying") + countIn("tool_running");
  const withAgent = countIn("assigned");
  const stalledTotal = stages.reduce((sum, stage) => sum + stage.stalled, 0);

  const load = useMemo(
    () => agentLoad(agents, conversations, dayStart),
    [agents, conversations, dayStart]
  );

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
                  Lo que pasó hoy, de la primera línea que escribe un cliente al asesor que
                  cierra la venta.
                </p>
              </div>

              <div className="dash-pulse">
                <PulseItem value={arriving} label="Nuevos" />
                <span className="dash-pulse-rule" />
                <PulseItem value={withAi} label="Con la IA" />
                <span className="dash-pulse-rule" />
                <PulseItem value={withAgent} label="Con asesor" />
                {/* Regla más marcada (T2, 10/9/2026): separa las tres piezas
                    de HOY del acumulado histórico que sigue — no son la misma
                    pregunta, y el trazo lo dice antes que el texto. */}
                <span className="dash-pulse-rule dash-pulse-rule-strong" />
                <PulseItem value={leadTotal} label="Total de leads" caption="acumulado" />
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

              <JourneyBoard stages={stages} now={now} hours={businessHours} dayStart={dayStart} />
            </section>

            <div id="actividad">
              <ActivityChart data={activity} timeZone={timeZone} />
            </div>

            <div className="dash-lower" id="reclamos">
              <TicketQueuePanel tickets={tickets} now={now} ticketTags={ticketTags} />
              <TicketStatsPanel stats={stats} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * `caption` (T2, 10/9/2026): la marca "acumulado" de "Total de leads" — la
 * única pieza del pulso que no corta por hoy, así que necesita decirlo. Va
 * bajo la etiqueta, no al lado del número: el valor tiene que leerse igual
 * de grande que el resto del pulso.
 */
function PulseItem({ value, label, caption }: { value: number; label: string; caption?: string }) {
  return (
    <span className="dash-pulse-item">
      <span className="dash-pulse-value dash-num">{value}</span>
      <span className="dash-pulse-label">{label}</span>
      {caption && <span className="dash-pulse-caption">{caption}</span>}
    </span>
  );
}

/**
 * Casos abiertos por asesor, el equipo ordenado de más a menos cargado.
 *
 * `dayStart` (T2, corrida "Los números del día", 10/9/2026): el encabezado
 * "Flujo de hoy" solo cuenta actividad de HOY, así que el avatar de cada
 * asesor tiene que aplicar el mismo corte que ya usa `buildJourney` — antes
 * de esta tarea contaba TODO lo abierto asignado a un asesor, sin importar
 * cuándo habló el cliente por última vez, y el título del avatar terminaba
 * contradiciendo al resto del encabezado.
 */
function agentLoad(agents: Agent[], conversations: BoardConversation[], dayStart: string | null) {
  return agents
    .map((agent) => ({
      agent,
      open: conversations.filter(
        (c) => c.assignedAgent?.id === agent.id && isActive(c) && matchesDay(c, dayStart)
      ).length,
    }))
    .sort((a, b) => b.open - a.open);
}

function loadColor(open: number): string {
  return LOAD_THRESHOLDS.find((t) => open <= t.max)!.color;
}
