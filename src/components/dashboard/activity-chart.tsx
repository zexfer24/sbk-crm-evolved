import type { HourlyActivity } from "@/lib/types";
import { gridValuesFor } from "@/lib/chart-scale";

// Lienzo fijo que luego escala con el ancho del panel.
const W = 720;
const H = 224;
const PAD = { top: 16, right: 14, bottom: 28, left: 36 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const STEP = PLOT_W / 24;

interface ActivityChartProps {
  data: HourlyActivity[];
  /** Zona horaria con la que se agruparon las horas, para decirlo en el pie. */
  timeZone: string;
}

export function ActivityChart({ data, timeZone }: ActivityChartProps) {
  const totals = data.reduce(
    (acc, h) => ({
      inbound: acc.inbound + h.inbound,
      ai: acc.ai + h.ai,
      agent: acc.agent + h.agent,
    }),
    { inbound: 0, ai: 0, agent: 0 }
  );

  const peak = Math.max(1, ...data.map((h) => Math.max(h.inbound, h.ai + h.agent)));
  const scaleY = (value: number) => PAD.top + PLOT_H - (value / peak) * PLOT_H;
  const centerX = (index: number) => PAD.left + STEP * index + STEP / 2;
  const barWidth = Math.min(STEP * 0.5, 15);

  const gridValues = gridValuesFor(peak);
  const inboundPath = smoothPath(data.map((hour, index) => [centerX(index), scaleY(hour.inbound)]));

  return (
    <section className="dash-panel">
      <header className="dash-panel-head">
        <h2 className="dash-panel-title">Mensajes de hoy, hora por hora</h2>
        <span className="dash-panel-spacer" />
        <span className="dash-panel-note">Hora de {timeZone.split("/").pop()?.replace("_", " ")}</span>
      </header>

      <div className="dash-legend">
        <LegendItem color="var(--lm-plum)" label="Recibidos" value={totals.inbound} shape="line" />
        <LegendItem color="var(--lm-link)" label="Respondió la IA" value={totals.ai} shape="bar" />
        <LegendItem color="var(--lm-ink)" label="Respondió un asesor" value={totals.agent} shape="bar" />
      </div>

      <div className="dash-chart">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="dash-chart-svg"
          role="img"
          aria-label={`Actividad de hoy: ${totals.inbound} mensajes recibidos, ${totals.ai} respondidos por la IA y ${totals.agent} por un asesor.`}
        >
          {gridValues.map((value) => (
            <g key={value}>
              <line
                className="dash-chart-grid"
                x1={PAD.left}
                x2={W - PAD.right}
                y1={scaleY(value)}
                y2={scaleY(value)}
              />
              <text className="dash-chart-tick dash-num" x={PAD.left - 8} y={scaleY(value) + 3.5} textAnchor="end">
                {Math.round(value)}
              </text>
            </g>
          ))}

          {/* Enviados: la IA abajo, el asesor encima, para leer la mezcla de un vistazo. */}
          {data.map((hour, index) => {
            const sent = hour.ai + hour.agent;
            if (sent === 0) return null;
            const x = centerX(index) - barWidth / 2;
            const aiHeight = (hour.ai / peak) * PLOT_H;
            const agentHeight = (hour.agent / peak) * PLOT_H;
            const base = PAD.top + PLOT_H;

            return (
              <g key={hour.hour}>
                <title>{`${hourLabel(index)} · IA ${hour.ai} · asesor ${hour.agent} · recibidos ${hour.inbound}`}</title>
                {hour.ai > 0 && (
                  <rect
                    className="dash-chart-bar"
                    x={x}
                    y={base - aiHeight}
                    width={barWidth}
                    height={aiHeight}
                    fill="var(--lm-link)"
                  />
                )}
                {hour.agent > 0 && (
                  <rect
                    className="dash-chart-bar"
                    x={x}
                    y={base - aiHeight - agentHeight}
                    width={barWidth}
                    height={agentHeight}
                    fill="var(--lm-ink)"
                  />
                )}
              </g>
            );
          })}

          {/* Recibidos: una sola curva por encima, para comparar entrada contra
              respuesta. El trazo blanco de debajo la despega de las barras. */}
          <path className="dash-chart-line-halo" d={inboundPath} stroke="var(--lm-surface)" />
          <path className="dash-chart-line" d={inboundPath} stroke="var(--lm-plum)" />
          {data.map((hour, index) =>
            hour.inbound > 0 ? (
              <circle
                key={hour.hour}
                className="dash-chart-dot"
                cx={centerX(index)}
                cy={scaleY(hour.inbound)}
                r={2.6}
                fill="var(--lm-plum)"
              />
            ) : null
          )}

          <line
            className="dash-chart-axis"
            x1={PAD.left}
            x2={W - PAD.right}
            y1={PAD.top + PLOT_H}
            y2={PAD.top + PLOT_H}
          />

          {data.map((hour, index) =>
            (index + 1) % 3 === 0 ? (
              <text
                key={hour.hour}
                className="dash-chart-tick dash-num"
                x={centerX(index)}
                y={H - 9}
                textAnchor="middle"
              >
                {String(index + 1).padStart(2, "0")}
              </text>
            ) : null
          )}
        </svg>
      </div>
    </section>
  );
}

function LegendItem({
  color,
  label,
  value,
  shape,
}: {
  color: string;
  label: string;
  value: number;
  shape: "bar" | "line";
}) {
  return (
    <span className="dash-legend-item">
      <span
        className={shape === "line" ? "dash-legend-line" : "dash-legend-bar"}
        style={{ background: color }}
      />
      <span className="dash-legend-label">{label}</span>
      <span className="dash-legend-value dash-num">{value}</span>
    </span>
  );
}

/** Etiqueta 01…24: la hora que acaba de cerrarse. */
function hourLabel(index: number): string {
  return `${String(index).padStart(2, "0")}:00 – ${String(index + 1).padStart(2, "0")}:00`;
}

/** Curva suave entre puntos, con controles horizontales para que no oscile. */
function smoothPath(points: [number, number][]): string {
  if (points.length === 0) return "";

  let path = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i += 1) {
    const [prevX, prevY] = points[i - 1];
    const [x, y] = points[i];
    const mid = (prevX + x) / 2;
    path += ` C ${mid} ${prevY}, ${mid} ${y}, ${x} ${y}`;
  }
  return path;
}
