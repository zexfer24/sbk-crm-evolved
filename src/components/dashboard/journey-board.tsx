"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { JourneyStage } from "@/lib/dashboard";
import {
  TERMINAL_STAGE,
  compactDuration,
  contactName,
  initials,
  minutesInStage,
  stageDetail,
} from "@/lib/dashboard";

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
}

export function JourneyBoard({ stages, now }: JourneyBoardProps) {
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
                  visible.map((conversation) => {
                    const waited = minutesInStage(conversation, now);
                    const late = waited >= stage.stallMinutes;
                    const name = contactName(conversation);
                    const detail = stageDetail(conversation, stage.id);

                    return (
                      <Link
                        className="dash-card"
                        key={conversation.id}
                        href={`/inbox?conversation=${conversation.id}`}
                        title={detail ? `${name} · ${detail}` : name}
                      >
                        <span className="dash-card-avatar" aria-hidden="true">
                          {initials(name)}
                        </span>
                        <span className="dash-card-body">
                          <span className="dash-card-name">{name}</span>
                          <span className="dash-card-meta">
                            <span className="dash-num">{compactDuration(waited)}</span>
                            {detail ? ` · ${detail}` : ""}
                          </span>
                        </span>
                        <span
                          className="dash-card-tick"
                          style={{ background: late ? "var(--lm-hot)" : "var(--lm-good)" }}
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
