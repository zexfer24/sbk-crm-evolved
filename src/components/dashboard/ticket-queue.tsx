import Link from "next/link";
import type { BoardConversation, TicketTagsByContact } from "@/lib/types";
import {
  compactDuration,
  contactName,
  initials,
  minutesInStage,
  ticketCategory,
  ticketTagsOf,
} from "@/lib/dashboard";

/** Un reclamo callado más de un día pasa a leerse como retraso, no como espera. */
const LATE_MINUTES = 60 * 24;
const MAX_ROWS = 7;

interface TicketQueuePanelProps {
  tickets: BoardConversation[];
  now: number;
  /** El motivo de cada reclamo sale de acá: no viaja en la fila (ver types.ts). */
  ticketTags: TicketTagsByContact;
}

export function TicketQueuePanel({ tickets, now, ticketTags }: TicketQueuePanelProps) {
  const rows = tickets.slice(0, MAX_ROWS);

  return (
    <section className="dash-panel">
      <header className="dash-panel-head">
        <h2 className="dash-panel-title">Reclamos por atender</h2>
        <span className="dash-panel-spacer" />
        <span className="dash-panel-note">Primero los que llevan más tiempo esperando</span>
      </header>

      {rows.length === 0 ? (
        <div className="dash-empty">
          <p className="dash-empty-title">Ningún reclamo abierto</p>
          <p className="dash-empty-hint">Todo lo etiquetado como reclamo está cerrado.</p>
        </div>
      ) : (
        <div className="dash-queue">
          <div className="dash-queue-row dash-queue-head">
            <span>Cliente</span>
            <span className="dash-queue-hide">Motivo</span>
            <span className="dash-queue-hide">Asesor</span>
            <span style={{ justifySelf: "end" }}>Espera</span>
          </div>

          {rows.map((conversation, rowIndex) => {
            const name = contactName(conversation);
            const waited = minutesInStage(conversation, now);
            const reason = ticketTagsOf(conversation, ticketTags).map(ticketCategory).join(", ");

            return (
              <Link
                className="dash-queue-row"
                key={conversation.id}
                href={`/inbox?conversation=${conversation.id}`}
                style={{ animationDelay: `${rowIndex * 45}ms` }}
              >
                <span className="dash-queue-client">
                  <span className="dash-card-avatar" aria-hidden="true">
                    {initials(name)}
                  </span>
                  <span className="dash-queue-name">{name}</span>
                </span>

                <span className="dash-queue-cell dash-queue-hide">
                  <span className="dash-chip" style={{ background: "rgb(var(--lm-hot-rgb) / 0.1)", color: "var(--lm-hot-ink)" }}>
                    <span className="dash-chip-dot" />
                    {reason}
                  </span>
                </span>

                <span className="dash-queue-cell dash-queue-hide">
                  {conversation.assignedAgent?.displayName ?? "Sin asignar"}
                </span>

                <span
                  className="dash-queue-age dash-num"
                  data-late={waited >= LATE_MINUTES}
                >
                  {compactDuration(waited)}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
