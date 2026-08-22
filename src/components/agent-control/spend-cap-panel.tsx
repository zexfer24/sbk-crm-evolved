"use client";

import { useState } from "react";
import { Wallet } from "lucide-react";
import { Button, Input, toast } from "@heroui/react";
import type { AgentSettings } from "@/lib/types";

interface SpendCapPanelProps {
  settings: AgentSettings;
  canEdit: boolean;
  onSave: (capUsd: number | null) => Promise<void>;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Tope de gasto diario de la IA. El panel ya mostraba cuánto cuesta el
 * agente, pero nada lo detenía: una ráfaga de mensajes gastaba cuota del
 * modelo sin límite y eso solo se veía en la factura.
 */
export function SpendCapPanel({ settings, canEdit, onSave }: SpendCapPanelProps) {
  const { dailySpendCapUsd: cap, spentTodayUsd: spent } = settings;
  const [draft, setDraft] = useState(cap === null ? "" : String(cap));
  const [isSaving, setIsSaving] = useState(false);

  const reached = cap !== null && spent >= cap;
  const ratio = cap && cap > 0 ? Math.min(spent / cap, 1) : 0;

  async function handleSave() {
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);

    if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
      toast.danger("El tope tiene que ser un monto mayor que cero, o vacío para quitarlo.");
      return;
    }

    setIsSaving(true);
    try {
      await onSave(parsed);
    } catch {
      toast.danger("No se pudo guardar el tope de gasto.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="dash-panel ac-cap" data-reached={reached}>
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Tope de gasto diario</h2>
        <span className="dash-panel-spacer" />
        <span className="dash-panel-note">
          {cap === null ? "Sin tope" : `${usd(spent)} de ${usd(cap)} hoy`}
        </span>
      </div>

      <div className="ac-cap-body">
        <p className="ac-cap-note">
          {cap === null ? (
            <>
              Hoy la IA lleva gastados <strong>{usd(spent)}</strong>. Sin un tope, una ráfaga de mensajes puede
              gastar sin límite y solo se nota en la factura.
            </>
          ) : reached ? (
            <>
              <strong>La IA está detenida:</strong> ya alcanzó el tope de {usd(cap)} de hoy. Vuelve sola mañana,
              o súbelo si necesitas que siga atendiendo ahora.
            </>
          ) : (
            <>
              Cuando el gasto del día llegue a <strong>{usd(cap)}</strong>, la IA deja de responder hasta mañana.
              El interruptor global no se toca.
            </>
          )}
        </p>

        {cap !== null && (
          <div
            className="ac-cap-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={cap}
            aria-valuenow={spent}
            aria-label="Gasto de la IA hoy"
          >
            <span className="ac-cap-bar-fill" style={{ transform: `scaleX(${ratio})` }} />
          </div>
        )}

        {canEdit && (
          <div className="ac-cap-form">
            <Wallet size={14} aria-hidden="true" />
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Sin tope"
              inputMode="decimal"
              aria-label="Tope de gasto diario en dólares"
            />
            <Button size="sm" variant="secondary" onPress={handleSave} isDisabled={isSaving}>
              Guardar
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
