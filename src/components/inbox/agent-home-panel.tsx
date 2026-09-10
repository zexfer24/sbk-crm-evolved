import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { Agent, AgentSettings } from "@/lib/types";
import type { InboxCounts } from "@/lib/data";
import type { AgentDaySummary, AiAssignment } from "@/lib/agent-day-data";
import { formatTime12h } from "@/lib/format";
import { SbkMark } from "@/components/sbk-logo";

/**
 * Formateador del monto vendido del día, a nivel de módulo y no dentro del
 * componente (T4, "Los números del día", 10/9/2026): `Intl.NumberFormat` es
 * caro de construir y este panel se rerenderiza con cada pulso en vivo de la
 * bandeja. `es-VE` deja la coma como separador decimal ("412,00"); el signo
 * "$ " va aparte, a mano, porque el formateador de moneda de `Intl` para
 * `USD` antepone "US$" o "$" pegado al número según la implementación —acá
 * se quiere siempre el mismo signo con el mismo espacio.
 */
const usdFormatter = new Intl.NumberFormat("es-VE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Lo que ocupa la columna del chat cuando no hay ninguna conversación abierta.
 *
 * Antes la bandeja abría sola la primera conversación de la lista. Eso ponía
 * al asesor a leer un chat que no eligió —y de paso lo marcaba como leído—
 * antes de decidir nada. Ahora se entra a un resumen propio y el primer chat
 * abierto es siempre una elección.
 *
 * T4 ("Los números del día", 10/9/2026): el panel deja de ser solo los
 * números de la bandeja compartida y pasa a hablarle al asesor de SU día —
 * tres bloques ("Tu día", "Tus chats", "La IA te pasó hoy") más una línea
 * compacta de equipo. Los números de equipo (Pendientes/Sin dueño/Esperando
 * asesor) siguen contados por la base (`fetchInboxCounts`, vía `counts`): la
 * lista en memoria es una ventana paginada, y contar sobre una ventana
 * mentiría en cuanto el asesor tuviera más conversaciones que las cargadas.
 */
export function AgentHomePanel({
  currentAgent,
  counts,
  agentSettings,
  agentDay,
  aiAssignments,
}: {
  currentAgent: Agent;
  counts: InboxCounts;
  agentSettings: AgentSettings;
  /**
   * El resumen del día del asesor (`fetchAgentDaySummary`, RPC
   * `agent_day_summary`). `null` cuando el RPC falló o todavía no llegó a
   * resolver —nunca se pinta un cero en su lugar: un cero acá es una
   * afirmación ("no asignaron nada hoy"), y confundirlo con "todavía no
   * cargó" sería mentirle al asesor sobre su propio día. Las cuatro tarjetas
   * pintan "—" mientras tanto.
   */
  agentDay: AgentDaySummary | null;
  /** Lo último que la IA le pasó hoy (`fetchAiAssignmentsToday`), más nuevo primero. */
  aiAssignments: AiAssignment[];
}) {
  const { pending, pendingStale, mine, mineUnread, unassigned, escalated } = counts;

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
      <p className="crm-agent-home-sub">Así viene tu día en la bandeja.</p>

      <div className="crm-agent-block">
        <span className="lm-eyebrow">Tu día</span>
        <div className="crm-agent-stats" data-cols="4">
          <div className="crm-agent-stat">
            <span className="crm-agent-stat-value lm-num">{agentDay ? agentDay.asignadas : "—"}</span>
            <span className="lm-eyebrow">Asignadas hoy</span>
          </div>
          <div className="crm-agent-stat">
            <span className="crm-agent-stat-value lm-num">
              {agentDay ? agentDay.respondidas : "—"}
            </span>
            <span className="lm-eyebrow">Respondidas hoy</span>
          </div>
          <div className="crm-agent-stat">
            <span className="crm-agent-stat-value lm-num">{agentDay ? agentDay.ventas : "—"}</span>
            <span className="lm-eyebrow">Ventas hoy</span>
          </div>
          <div className="crm-agent-stat">
            <span className="crm-agent-stat-value lm-num">
              {agentDay ? `$ ${usdFormatter.format(agentDay.montoUsd)}` : "—"}
            </span>
            <span className="lm-eyebrow">Vendido hoy</span>
          </div>
        </div>
      </div>

      <div className="crm-agent-block">
        <span className="lm-eyebrow">Tus chats</span>
        <div className="crm-agent-stats" data-cols="2">
          <div className="crm-agent-stat">
            <span className="crm-agent-stat-value lm-num">{mine}</span>
            <span className="lm-eyebrow">Tuyas</span>
          </div>
          {/*
            "Tuyas sin leer" (T4, 10/9/2026): mismo tratamiento que "Sin
            dueño" de la línea de equipo, más abajo — se tiñe SOLO con algo
            pendiente, para que el estado en cero (el objetivo) no se vea
            como una alarma permanente.
          */}
          <div className="crm-agent-stat" data-alerta={mineUnread > 0}>
            <span className="crm-agent-stat-value lm-num">{mineUnread}</span>
            <span className="lm-eyebrow">Tuyas sin leer</span>
          </div>
        </div>
      </div>

      <div className="crm-agent-block">
        <span className="lm-eyebrow">La IA te pasó hoy · {aiAssignments.length}</span>
        {aiAssignments.length === 0 ? (
          <p className="crm-agent-empty">Todavía nada hoy</p>
        ) : (
          <ul className="crm-agent-handoffs">
            {aiAssignments.map((item) => (
              <li key={item.handoffId}>
                <Link href={`/inbox?conversation=${item.conversationId}`}>
                  <span>{item.contactName}</span>
                  <span className="lm-num">{formatTime12h(item.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        Los números de equipo (T1.5/reforma "ningún lead invisible") bajan a
        una sola línea compacta desde T4: ya no son el centro del panel —el
        centro pasa a ser el día del asesor— pero "Sin dueño" es el KPI de la
        reforma y tiene que seguir a la vista todos los días, no solo en
        /api/health. "Esperando +24 h" solo aparece si es > 0: en cero no
        suma nada que "Pendientes" no diga ya.
      */}
      <p className="crm-agent-team">
        <span className="lm-eyebrow">Equipo</span> Pendientes {pending} ·{" "}
        <span data-alerta={unassigned > 0}>Sin dueño {unassigned}</span> · Esperando asesor{" "}
        {escalated}
        {pendingStale > 0 ? <> · Esperando +24 h {pendingStale}</> : null}
      </p>

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
