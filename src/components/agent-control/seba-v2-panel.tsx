"use client";

import { useId, useState, type ReactNode } from "react";
import { Button, Input, Label, toast } from "@heroui/react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { configErrorMessage } from "@/lib/config-write";
import {
  SEBA_V2_MODES,
  SEBA_V2_MODE_DESCRIPTIONS,
  SEBA_V2_MODE_LABELS,
  modeNeedsConfirmation,
  parseShadowLimits,
  type SebaV2Config,
  type SebaV2Mode,
} from "@/lib/seba-v2-config";
import "@/components/agent-control/seba-v2.css";

// ---------------------------------------------------------------------------
// «Seba v2» (T5, Entrega 2 de Seba v2: "Los datos del negocio", 16/11/2026).
// Selector del modo de Seba v2 y límites de la sombra. Hasta la entrega 2 el modo
// no tenía efecto y un aviso fijo lo decía; desde la entrega 3 (17/11/2026:
// sombra y copiloto) SÍ lo tiene y el aviso se quitó: la línea explicativa de
// cada modo (`SEBA_V2_MODE_DESCRIPTIONS`) dice qué hace. Los dos modos que le
// escriben al cliente sin un asesor en medio (`modeNeedsConfirmation`) piden
// confirmación antes de guardarse. Un supervisor edita; un asesor lo ve en solo lectura.
//
// El panel solo recibe props y callbacks; los callbacks LANZAN si el guardado
// falla (RLS, red): acá se atrapan y se muestran con `toast`.
// ---------------------------------------------------------------------------

interface SebaV2PanelProps {
  /** null = la base todavía no tiene las columnas (falta la migración): se pinta «No disponible», nunca campos vacíos. */
  config: Pick<SebaV2Config, "modo" | "shadowDailyCapUsd" | "shadowSamplePct"> | null;
  canEdit: boolean;
  onModeChange: (modo: SebaV2Mode) => Promise<void>;
  onSaveLimits: (limits: { capUsd: number; samplePct: number }) => Promise<void>;
}

interface LimitsDraft {
  capUsd: string;
  samplePct: string;
}

type LimitsField = keyof LimitsDraft;

/** Los límites viajan como TEXTO de input: `5` → "5", sin forzar decimales. */
function limitsDraftFrom(config: SebaV2PanelProps["config"]): LimitsDraft {
  return {
    capUsd: config ? String(config.shadowDailyCapUsd) : "",
    samplePct: config ? String(config.shadowSamplePct) : "",
  };
}

function sameLimits(a: LimitsDraft, b: LimitsDraft): boolean {
  return a.capUsd === b.capUsd && a.samplePct === b.samplePct;
}

function FieldError({ message }: { message: string | undefined }): ReactNode {
  if (!message) return null;
  return (
    <p role="alert" className="lm-field-error">
      {message}
    </p>
  );
}

export function SebaV2Panel({ config, canEdit, onModeChange, onSaveLimits }: SebaV2PanelProps) {
  const uid = useId();
  const [selected, setSelected] = useState<SebaV2Mode>(config?.modo ?? "apagado");
  const [isChangingMode, setIsChangingMode] = useState(false);
  /** El modo que espera confirmación (solo "fuera_de_horario" y "siempre"). */
  const [pending, setPending] = useState<SebaV2Mode | null>(null);

  const [limits, setLimits] = useState<LimitsDraft>(() => limitsDraftFrom(config));
  const [limitErrors, setLimitErrors] = useState<Partial<Record<LimitsField, string>>>({});
  const [isSavingLimits, setIsSavingLimits] = useState(false);

  // "Ajustar estado cuando cambia una prop" (React): se compara DURANTE el
  // render contra una copia en estado, no con un setState dentro de un
  // useEffect (que dispara `react-hooks/set-state-in-effect`). El modo se pone
  // al día si no hay un cambio en vuelo; los límites, si la persona no tiene
  // cambios sin guardar (si los tiene, se respeta lo que escribió).
  const [prevConfig, setPrevConfig] = useState(config);
  if (config !== prevConfig) {
    const hasUnsavedLimits = !sameLimits(limits, limitsDraftFrom(prevConfig));
    setPrevConfig(config);
    if (!isChangingMode && pending === null) setSelected(config?.modo ?? "apagado");
    if (!hasUnsavedLimits) {
      setLimits(limitsDraftFrom(config));
      setLimitErrors({});
    }
  }

  const id = (name: string) => `${uid}-${name}`;

  // ---------------------------------- modo -----------------------------------

  /**
   * Guarda el modo con la selección optimista; si falla vuelve al anterior y
   * avisa. `rethrow` (solo desde el diálogo) relanza para que quede abierto.
   */
  async function applyMode(modo: SebaV2Mode, rethrow: boolean) {
    const previous = selected;
    setSelected(modo);
    setIsChangingMode(true);
    try {
      await onModeChange(modo);
      toast.success(`Modo de Seba v2: ${SEBA_V2_MODE_LABELS[modo]}.`);
    } catch (error) {
      setSelected(previous);
      toast.danger(configErrorMessage(error, "No se pudo cambiar el modo de Seba v2."));
      if (rethrow) throw error;
    } finally {
      setIsChangingMode(false);
    }
  }

  function handleModeChoice(modo: SebaV2Mode) {
    if (modo === selected) return;
    if (modeNeedsConfirmation(modo)) {
      // No se toca la selección: si cancela, el radio ya está donde estaba.
      setPending(modo);
      return;
    }
    void applyMode(modo, false);
  }

  // --------------------------------- límites ---------------------------------

  function handleLimitChange(field: LimitsField, value: string) {
    setLimits((current) => ({ ...current, [field]: value }));
    // Solo se limpia el error del campo que cambió.
    setLimitErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function handleSaveLimits() {
    const parsed = parseShadowLimits(limits);
    if (!parsed.ok) {
      setLimitErrors(parsed.errors);
      return;
    }
    setLimitErrors({});
    setIsSavingLimits(true);
    try {
      await onSaveLimits({ capUsd: parsed.capUsd, samplePct: parsed.samplePct });
      // 16/11/2026 (revisión de código): el borrador pasa a la forma canónica de
      // lo guardado ("7,5" → "7.5"). Si se queda con lo tecleado, el padre
      // devuelve 7.5, el borrador ("7,5") parece "cambios sin guardar" para
      // siempre y los refrescos del servidor ya no lo actualizan.
      setLimits({ capUsd: String(parsed.capUsd), samplePct: String(parsed.samplePct) });
      toast.success("Límites de la sombra guardados.");
    } catch (error) {
      toast.danger(configErrorMessage(error, "No se pudieron guardar los límites de la sombra."));
    } finally {
      setIsSavingLimits(false);
    }
  }

  // ---------------------------------- vista ----------------------------------

  return (
    <section className="dash-panel ac-sv-mode">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Seba v2</h2>
      </div>

      <div className="ac-sv-body">
        {config === null ? (
          <p className="ac-sv-unavailable">No disponible: falta aplicar la migración de Seba v2.</p>
        ) : (
          <>
            <fieldset className="ac-sv-modes">
              <legend className="ac-sv-section-title">Modo</legend>
              {SEBA_V2_MODES.map((modo) => (
                <label className="ac-sv-mode-option" key={modo} data-selected={selected === modo}>
                  <input
                    type="radio"
                    name="seba-v2-modo"
                    value={modo}
                    checked={selected === modo}
                    onChange={() => handleModeChoice(modo)}
                    disabled={!canEdit || isChangingMode}
                    aria-labelledby={id(`${modo}-etiqueta`)}
                    aria-describedby={id(`${modo}-descripcion`)}
                  />
                  <span className="ac-sv-mode-text">
                    <strong id={id(`${modo}-etiqueta`)} className="ac-sv-mode-label">
                      {SEBA_V2_MODE_LABELS[modo]}
                    </strong>
                    <span id={id(`${modo}-descripcion`)} className="ac-sv-mode-desc">
                      {SEBA_V2_MODE_DESCRIPTIONS[modo]}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            {!canEdit && <p className="ac-sv-note">Solo un supervisor o admin puede cambiar el modo.</p>}

            <div className="ac-sv-section">
              <h3 className="ac-sv-section-title">Sombra</h3>
              <p className="ac-sv-note">
                Cuánto puede gastar Seba v2 por día redactando en silencio, y qué parte de los turnos redacta.
              </p>

              <div className="ac-sv-row">
                <div className="ac-sv-field">
                  <Label htmlFor={id("tope")}>Tope diario de la sombra (USD)</Label>
                  <Input
                    id={id("tope")}
                    value={limits.capUsd}
                    onChange={(e) => handleLimitChange("capUsd", e.target.value)}
                    inputMode="decimal"
                    disabled={!canEdit}
                    fullWidth
                  />
                  <FieldError message={limitErrors.capUsd} />
                </div>

                <div className="ac-sv-field">
                  <Label htmlFor={id("muestreo")}>Muestreo (%)</Label>
                  <Input
                    id={id("muestreo")}
                    value={limits.samplePct}
                    onChange={(e) => handleLimitChange("samplePct", e.target.value)}
                    inputMode="numeric"
                    disabled={!canEdit}
                    fullWidth
                  />
                  <span className="lm-hint">100 = todos los turnos; 0 = ninguno.</span>
                  <FieldError message={limitErrors.samplePct} />
                </div>
              </div>

              {canEdit && (
                <div className="ac-sv-actions">
                  <Button variant="primary" size="sm" onPress={handleSaveLimits} isDisabled={isSavingLimits}>
                    Guardar límites
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {pending && (
        <ConfirmDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          titulo={`¿Pasar Seba v2 a «${SEBA_V2_MODE_LABELS[pending]}»?`}
          descripcion={`${SEBA_V2_MODE_DESCRIPTIONS[pending]} Seba le va a escribir a los clientes sin que un asesor revise cada mensaje.`}
          confirmarEtiqueta="Sí, cambiar el modo"
          peligro
          onConfirmar={() => applyMode(pending, true)}
        />
      )}
    </section>
  );
}
