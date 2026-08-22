"use client";

import { CheckCheck, Handshake, MessagesSquare, ShieldCheck, Timer } from "lucide-react";
import type { AgentMetrics, AgentRole } from "@/lib/types";

/**
 * Cuánto tardó en contestar, dicho como lo diría una persona.
 *
 * Se redondea a la unidad de arriba a propósito: «3 min» y «4 min» son
 * accionables; «3 min 47 s» solo agrega ruido a un tablero que se mira de
 * reojo.
 */
export function formatReplyTime(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const horas = seconds / 3600;
  // Con más de una hora, los decimales importan: 1,5 h no es lo mismo que 2 h.
  return horas < 10 ? `${horas.toFixed(1)} h` : `${Math.round(horas)} h`;
}

function usd(amount: number): string {
  return amount >= 1000 ? `$${(amount / 1000).toFixed(1)}k` : `$${amount.toFixed(0)}`;
}

/**
 * Umbrales del tiempo de respuesta. En atención por WhatsApp la gente espera
 * minutos, no horas: pasada la media hora, la conversación se enfría.
 */
function replyTone(seconds: number | null): string {
  if (seconds === null) return "muted";
  if (seconds <= 300) return "good"; // hasta 5 min
  if (seconds <= 1800) return "wait"; // hasta 30 min
  return "hot";
}

interface MetricProps {
  icon: React.ReactNode;
  label: string;
  today: string;
  period: string;
  tone?: string;
}

function Metric({ icon, label, today, period, tone = "muted" }: MetricProps) {
  return (
    <div className="ac-metric" data-tone={tone}>
      <span className="ac-metric-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="ac-metric-value lm-num">{today}</span>
      <span className="ac-metric-label">{label}</span>
      <span className="ac-metric-period lm-num" title="Últimos 30 días">
        {period}
      </span>
    </div>
  );
}

interface AgentMetricsRowProps {
  metrics: AgentMetrics | undefined;
  role: AgentRole;
}

export function AgentMetricsRow({ metrics, role }: AgentMetricsRowProps) {
  if (!metrics) return null;

  const replyTime = formatReplyTime(metrics.firstReplyMedianSeconds);
  // Verificar comprobantes solo lo puede hacer supervisión: mostrarle la
  // métrica a un asesor sería mostrarle un cero que nunca va a subir.
  const showVerified = role !== "agent";

  return (
    <div className="ac-metrics">
      <Metric
        icon={<MessagesSquare size={12} />}
        label="mensajes"
        today={String(metrics.messagesToday)}
        period={String(metrics.messagesPeriod)}
      />
      <Metric
        icon={<CheckCheck size={12} />}
        label="chats"
        today={String(metrics.conversationsToday)}
        period={String(metrics.conversationsPeriod)}
      />
      <Metric
        icon={<Handshake size={12} />}
        label={metrics.salesPeriod === 1 ? "venta" : "ventas"}
        today={String(metrics.salesToday)}
        period={`${metrics.salesPeriod} · ${usd(metrics.salesAmountPeriod)}`}
        tone={metrics.salesToday > 0 ? "good" : "muted"}
      />

      {showVerified && (
        <Metric
          icon={<ShieldCheck size={12} />}
          label="verificadas"
          today={String(metrics.verifiedToday)}
          period={String(metrics.verifiedPeriod)}
        />
      )}

      <div className="ac-metric" data-tone={replyTone(metrics.firstReplyMedianSeconds)} data-wide="true">
        <span className="ac-metric-icon" aria-hidden="true">
          <Timer size={12} />
        </span>
        {replyTime ? (
          <>
            <span className="ac-metric-value lm-num">{replyTime}</span>
            <span className="ac-metric-label">en contestar</span>
          </>
        ) : (
          <span className="ac-metric-label ac-metric-empty">sin datos de respuesta todavía</span>
        )}
      </div>
    </div>
  );
}
