import type { TokenUsageDay } from "@/lib/types";

const W = 640;
const H = 160;
const PAD = { top: 12, right: 10, bottom: 24, left: 44 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

interface TokenUsageChartProps {
  data: TokenUsageDay[];
}

export function TokenUsageChart({ data }: TokenUsageChartProps) {
  const step = PLOT_W / data.length;
  const peak = Math.max(1, ...data.map((d) => d.tokens));
  const scaleY = (value: number) => PAD.top + PLOT_H - (value / peak) * PLOT_H;
  const centerX = (index: number) => PAD.left + step * index + step / 2;
  const barWidth = Math.min(step * 0.55, 22);
  const gridValues = [0, peak / 2, peak];
  const total = data.reduce((sum, d) => sum + d.tokens, 0);

  return (
    <div className="dash-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="dash-chart-svg"
        role="img"
        aria-label={`Tokens consumidos por día, últimos ${data.length} días. Total: ${total}.`}
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
              {formatCompact(value)}
            </text>
          </g>
        ))}

        {data.map((day, index) => {
          if (day.tokens === 0) return null;
          const height = (day.tokens / peak) * PLOT_H;
          return (
            <g key={day.date}>
              <title>{`${dayLabel(day.date)} · ${day.tokens.toLocaleString("es-VE")} tokens`}</title>
              <rect
                className="dash-chart-bar"
                x={centerX(index) - barWidth / 2}
                y={PAD.top + PLOT_H - height}
                width={barWidth}
                height={height}
                fill="var(--lm-link)"
              />
            </g>
          );
        })}

        <line
          className="dash-chart-axis"
          x1={PAD.left}
          x2={W - PAD.right}
          y1={PAD.top + PLOT_H}
          y2={PAD.top + PLOT_H}
        />

        {data.map((day, index) =>
          index % 2 === 0 ? (
            <text key={day.date} className="dash-chart-tick dash-num" x={centerX(index)} y={H - 7} textAnchor="middle">
              {dayLabel(day.date)}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}

/** "2026-08-19" -> "19/08" */
function dayLabel(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}/${month}`;
}

function formatCompact(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}
