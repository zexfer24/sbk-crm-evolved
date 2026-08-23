import type { TicketStats } from "@/lib/dashboard";

/** Paleta de categorías: rota sobre los mismos tokens del flujo, sin colores sueltos. */
const CATEGORY_COLORS = [
  "var(--lm-hot)",
  "var(--lm-link)",
  "var(--lm-wait)",
  "var(--lm-plum)",
  "var(--lm-good)",
];

const BUBBLE_MIN = 74;
const BUBBLE_MAX = 148;

interface TicketStatsPanelProps {
  stats: TicketStats;
}

export function TicketStatsPanel({ stats }: TicketStatsPanelProps) {
  const peak = Math.max(stats.open, stats.resolved, 1);
  const topCategory = stats.categories[0]?.total ?? 1;

  return (
    <section className="dash-panel">
      <header className="dash-panel-head">
        <h2 className="dash-panel-title">Reclamos</h2>
        <span className="dash-panel-spacer" />
        <span className="dash-panel-note">
          {stats.total === 0 ? "Sin registros" : `${stats.total} en total`}
        </span>
      </header>

      {stats.total === 0 ? (
        <div className="dash-empty">
          <p className="dash-empty-title">Todavía no hay reclamos</p>
          <p className="dash-empty-hint">
            Etiqueta un contacto con «Reclamo · …» desde el panel de la conversación y aparecerá
            aquí.
          </p>
        </div>
      ) : (
        <>
          <div className="dash-bubbles">
            <Bubble
              value={stats.open}
              label="Abiertos"
              color="var(--lm-hot-fill)"
              size={bubbleSize(stats.open, peak)}
            />
            <Bubble
              value={stats.resolved}
              label="Resueltos"
              color="var(--lm-link-fill)"
              size={bubbleSize(stats.resolved, peak)}
            />
          </div>

          <div className="dash-stat-row">
            <div className="dash-stat" data-tone={stats.unanswered > 0 ? "hot" : undefined}>
              <p className="dash-stat-value dash-num">{stats.unanswered}</p>
              <p className="dash-stat-label">Sin respuesta hace más de 24 h</p>
            </div>
            <div className="dash-stat">
              <p className="dash-stat-value dash-num">{formatAge(stats.averageOpenHours)}</p>
              <p className="dash-stat-label">Antigüedad media de los abiertos</p>
            </div>
          </div>

          <div className="dash-stats">
            <div className="dash-breakdown">
              {stats.categories.map((category, index) => (
                <div className="dash-breakdown-row" key={category.label}>
                  <span className="dash-breakdown-label">{category.label}</span>
                  <span className="dash-meter">
                    <span
                      className="dash-meter-fill"
                      style={{
                        width: `${Math.max((category.total / topCategory) * 100, 6)}%`,
                        background: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
                      }}
                    />
                  </span>
                  <span className="dash-breakdown-value dash-num">{category.total}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Bubble({
  value,
  label,
  color,
  size,
}: {
  value: number;
  label: string;
  color: string;
  size: number;
}) {
  return (
    <div
      className="dash-bubble"
      style={{ width: size, height: size, background: color }}
      role="img"
      aria-label={`${value} reclamos ${label.toLowerCase()}`}
    >
      <span>
        <span className="dash-bubble-value dash-num">{value}</span>
        <span className="dash-bubble-label">{label}</span>
      </span>
    </div>
  );
}

/** Área proporcional al conteo, para que dos burbujas se puedan comparar de un vistazo. */
function bubbleSize(value: number, peak: number): number {
  const ratio = Math.sqrt(value / peak);
  return Math.round(BUBBLE_MIN + (BUBBLE_MAX - BUBBLE_MIN) * (Number.isFinite(ratio) ? ratio : 0));
}

function formatAge(hours: number): string {
  if (hours <= 0) return "—";
  if (hours < 24) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}
