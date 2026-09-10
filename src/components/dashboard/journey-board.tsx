"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { JourneyStage } from "@/lib/dashboard";
import {
  TERMINAL_STAGE,
  contactName,
  initials,
  isStalled,
  stageDetail,
  waitingMinutes,
} from "@/lib/dashboard";
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from "@/lib/business-hours";

/** Tarjetas visibles por etapa antes de resumir el resto en una línea. */
const CARDS_PER_STAGE = 3;

interface Wire {
  path: string;
  color: string;
  width: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

interface JourneyBoardProps {
  stages: JourneyStage[];
  now: number;
  /** Horario de atención para medir "Con asesor" en minutos laborales (Frente A). */
  hours?: BusinessHours;
}

// Tuvo un prop `dayStart` (T2, corrida "Los números del día", 10/9/2026):
// enhebraba el mismo corte "habló hoy" hasta `waitingMinutes`/`isStalled`
// para que decidieran "Primer contacto" con el mismo día que `stageOf` usaba
// al armar la columna. Se fue en "El Recorrido cuenta los números nuevos del
// día" (mismo día, corrida siguiente): `stageOf` ya nunca devuelve
// `"first_contact"`, así que `waitingMinutes`/`isStalled` dejaron de tomar
// `dayStart` — no había a quién enhebrárselo.

/**
 * "espera N min" desde `lastCustomerMessageAt` (Frente A, 5/9/2026): minutos
 * redondeados hacia abajo, y pasadas las 24 h en horas o "días y horas" —
 * una tarjeta no necesita más precisión que esa para transmitir urgencia.
 */
function formatWait(minutes: number): string {
  const floored = Math.floor(minutes);
  if (floored < 1) return "espera menos de 1 min";
  if (floored < 60) return `espera ${floored} min`;

  const totalHours = Math.floor(floored / 60);
  if (totalHours < 24) return `espera ${totalHours} h`;

  const days = Math.floor(totalHours / 24);
  const restHours = totalHours % 24;
  const dayLabel = days === 1 ? "1 día" : `${days} días`;
  return restHours === 0 ? `espera ${dayLabel}` : `espera ${dayLabel} y ${restHours} h`;
}

/**
 * Qué dice el punto rojo al pasarle el mouse: el umbral de la etapa, no si
 * está o no atascada (eso ya lo dice el color). "Con asesor" se mide en
 * minutos de horario laboral, así que lo dice distinto de las etapas de la IA.
 */
function stallTitle(stage: JourneyStage): string | undefined {
  if (stage.stallMinutes === null) return undefined;
  if (stage.id === TERMINAL_STAGE) return `${stage.stallMinutes} min en horario de atención`;
  return `Umbral de esta etapa: ${stage.stallMinutes} min`;
}

export function JourneyBoard({
  stages,
  now,
  hours = DEFAULT_BUSINESS_HOURS,
}: JourneyBoardProps) {
  const flowRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [wires, setWires] = useState<Wire[]>([]);

  // Los hilos se calculan desde la geometría real de las columnas: cada uno
  // sale del centro de una etapa y entra en el centro de la siguiente, así
  // que la curva refleja cuánta gente hay acumulada a cada lado.
  const measure = useCallback(() => {
    const flow = flowRef.current;
    if (!flow) return;

    const origin = flow.getBoundingClientRect();
    const boxes = columnRefs.current.map((el) => el?.getBoundingClientRect() ?? null);
    const next: Wire[] = [];

    for (let i = 0; i < boxes.length - 1; i += 1) {
      const a = boxes[i];
      const b = boxes[i + 1];
      if (!a || !b) continue;

      const from = { x: a.right - origin.left, y: a.top + a.height / 2 - origin.top };
      const to = { x: b.left - origin.left, y: b.top + b.height / 2 - origin.top };
      const bend = Math.max((to.x - from.x) * 0.55, 18);
      const target = stages[i + 1];

      next.push({
        path: `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`,
        color: wireColor(target),
        width: 1.2 + Math.min(target.conversations.length, 8) * 0.32,
        from,
        to,
      });
    }

    setWires(next);
  }, [stages]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const observer = new ResizeObserver(measure);
    if (flowRef.current) observer.observe(flowRef.current);
    for (const el of columnRefs.current) {
      if (el) observer.observe(el);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  return (
    <div className="dash-flow" ref={flowRef}>
      <svg className="dash-flow-wires" aria-hidden="true">
        {wires.map((wire, index) => (
          <g key={index} style={{ color: wire.color }}>
            <path className="dash-wire" d={wire.path} stroke="currentColor" strokeWidth={wire.width} />
            <circle className="dash-wire-node" cx={wire.from.x} cy={wire.from.y} r={3} fill="currentColor" />
            <circle className="dash-wire-node" cx={wire.to.x} cy={wire.to.y} r={3} fill="currentColor" />
          </g>
        ))}
      </svg>

      <div className="dash-stages">
        {stages.map((stage, index) => {
          const visible = stage.conversations.slice(0, CARDS_PER_STAGE);
          const hidden = stage.conversations.length - visible.length;

          return (
            <section className="dash-stage" key={stage.id} data-terminal={stage.id === TERMINAL_STAGE}>
              <div
                className="dash-stage-cards"
                ref={(el) => {
                  columnRefs.current[index] = el;
                }}
              >
                {visible.length === 0 ? (
                  <p className="dash-stage-empty">Sin nadie aquí</p>
                ) : (
                  visible.map((conversation, cardIndex) => {
                    // Único reloj (Frente A, "El reloj dice la verdad", 5/9/2026):
                    // `waitingMinutes` es null si la pelota está del lado del
                    // cliente (no espera respuesta) — ahí se pinta `stageDetail`
                    // en gris en vez de un tiempo de espera que no existe.
                    const waited = waitingMinutes(conversation, now, hours);
                    const late = isStalled(conversation, now, hours);
                    const name = contactName(conversation);
                    const detail = stageDetail(conversation, stage.id);
                    const metaText =
                      waited !== null
                        ? detail
                          ? `${formatWait(waited)} · ${detail}`
                          : formatWait(waited)
                        : (detail ?? "");

                    return (
                      <Link
                        className="dash-card"
                        key={conversation.id}
                        href={`/inbox?conversation=${conversation.id}`}
                        title={detail ? `${name} · ${detail}` : name}
                        style={{ animationDelay: `${cardIndex * 45}ms` }}
                      >
                        <span className="dash-card-avatar" aria-hidden="true">
                          {initials(name)}
                        </span>
                        <span className="dash-card-body">
                          <span className="dash-card-name">{name}</span>
                          <span className="dash-card-meta">{metaText}</span>
                        </span>
                        <span
                          className="dash-card-tick"
                          style={{ background: late ? "var(--lm-hot)" : "var(--lm-good)" }}
                          title={stallTitle(stage)}
                        />
                      </Link>
                    );
                  })
                )}

                {hidden > 0 && <p className="dash-stage-more dash-num">+{hidden} más</p>}
              </div>

              <div className="dash-stage-foot">
                <span className="dash-stage-label">{stage.label}</span>
                <span className="dash-stage-count dash-num">{stage.conversations.length}</span>
                {stage.stalled > 0 && (
                  <span className="dash-stage-alert">
                    <AlertTriangle size={11} strokeWidth={2.4} />
                    <span className="dash-num">{stage.stalled}</span>
                  </span>
                )}
              </div>
              <p className="dash-stage-caption">{stage.caption}</p>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** El color del hilo dice cómo está la etapa que recibe: atascada, viva o vacía. */
function wireColor(stage: JourneyStage): string {
  if (stage.stalled > 0) return "var(--lm-hot)";
  if (stage.conversations.length > 0) return "var(--lm-link)";
  return "var(--lm-canvas-edge)";
}
