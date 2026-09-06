"use client";

import { useMemo, useState } from "react";
import { Clock3, Plus, Trash2 } from "lucide-react";
import { Button, toast } from "@heroui/react";
import type { AgentSettings } from "@/lib/types";
import {
  DEFAULT_BUSINESS_HOURS,
  businessStatus,
  describeSchedule,
  type BusinessHours,
  type DayKey,
  type TimeRange,
} from "@/lib/business-hours";

interface BusinessHoursPanelProps {
  settings: AgentSettings;
  canEdit: boolean;
  onSave: (hours: BusinessHours) => Promise<void>;
}

const DAY_KEYS: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const DAY_LABELS: Record<DayKey, string> = {
  mon: "Lunes",
  tue: "Martes",
  wed: "Miércoles",
  thu: "Jueves",
  fri: "Viernes",
  sat: "Sábado",
  sun: "Domingo",
};

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function cloneHours(hours: BusinessHours): BusinessHours {
  const copia = {} as BusinessHours;
  for (const dia of DAY_KEYS) {
    copia[dia] = hours[dia].map(([inicio, fin]) => [inicio, fin] as TimeRange);
  }
  return copia;
}

/**
 * Valida el borrador ANTES de guardar, fila por fila, con el mensaje exacto
 * que se le muestra a quien edita.
 *
 * No se puede usar `parseBusinessHours` para esto: ante cualquier error
 * devuelve el `DEFAULT_BUSINESS_HOURS` completo, sin decir cuál día falló ni
 * por qué — sirve para blindar al turno de IA contra una fila rota en la
 * base, no para guiar a quien está escribiendo el horario a mano (B5, "El
 * reloj dice la verdad", 5/9/2026).
 */
export function validateDraft(draft: BusinessHours): Partial<Record<DayKey, string>> {
  const errores: Partial<Record<DayKey, string>> = {};

  for (const dia of DAY_KEYS) {
    for (const [inicio, fin] of draft[dia]) {
      if (!HHMM_RE.test(inicio) || !HHMM_RE.test(fin)) {
        errores[dia] = "Hora inválida, usa HH:MM.";
        break;
      }
      if (hhmmToMinutes(fin) <= hhmmToMinutes(inicio)) {
        errores[dia] = "El cierre tiene que ser después de la apertura.";
        break;
      }
    }

    // Dos franjas solapadas suman dos veces los minutos en común en
    // `businessMinutesBetween` (business-hours.ts), y eso adelanta el
    // umbral de 60 min laborales que pinta "Con asesor" en rojo en el
    // tablero. Se corta acá, en la puerta de entrada del formulario: si
    // `parseBusinessHours` rechazara el jsonb en su lugar, el turno de la
    // IA caería al horario por defecto en silencio (decisión del plan del
    // 6/9/2026, D4). No se reordenan solas: si vienen al revés (la segunda
    // termina antes de que empiece la primera) es el mismo error, y quien
    // edita las corrige a mano.
    if (!errores[dia] && draft[dia].length === 2) {
      const [, fin1] = draft[dia][0];
      const [inicio2] = draft[dia][1];
      if (hhmmToMinutes(inicio2) < hhmmToMinutes(fin1)) {
        errores[dia] = "Las franjas se solapan.";
      }
    }
  }

  return errores;
}

/**
 * Horario de atención de la tienda. La IA sigue vendiendo fuera de horario
 * (decisión del operador, 5/9/2026): esto no la apaga, solo le dice al
 * tablero cuándo un chat "Con asesor" lleva de verdad una hora de horario
 * laboral sin respuesta, y a la propia IA qué franja nombrar en el saludo.
 */
export function BusinessHoursPanel({ settings, canEdit, onSave }: BusinessHoursPanelProps) {
  const original = settings.businessHours ?? DEFAULT_BUSINESS_HOURS;
  const [draft, setDraft] = useState<BusinessHours>(() => cloneHours(original));
  const [isSaving, setIsSaving] = useState(false);

  const errores = useMemo(() => validateDraft(draft), [draft]);
  const esValido = Object.keys(errores).length === 0;

  const vistaPrevia = useMemo(() => {
    if (!esValido) return null;
    return { horario: describeSchedule(draft), estado: businessStatus(new Date(), draft) };
  }, [draft, esValido]);

  function setDia(dia: DayKey, franjas: TimeRange[]) {
    setDraft((actual) => ({ ...actual, [dia]: franjas }));
  }

  function toggleCerrado(dia: DayKey, cerrado: boolean) {
    setDia(dia, cerrado ? [] : [["08:00", "18:00"]]);
  }

  function setFranja(dia: DayKey, indice: number, campo: 0 | 1, valor: string) {
    const franjas = draft[dia].map((franja, i) => {
      if (i !== indice) return franja;
      const copia: TimeRange = [franja[0], franja[1]];
      copia[campo] = valor;
      return copia;
    });
    setDia(dia, franjas);
  }

  function agregarFranja(dia: DayKey) {
    if (draft[dia].length >= 2) return;
    setDia(dia, [...draft[dia], ["18:00", "20:00"]]);
  }

  function quitarFranja(dia: DayKey, indice: number) {
    setDia(dia, draft[dia].filter((_, i) => i !== indice));
  }

  async function handleSave() {
    if (!esValido) return;
    setIsSaving(true);
    try {
      await onSave(draft);
      toast.success("Horario de atención actualizado.");
    } catch {
      toast.danger("No se pudo guardar el horario de atención.");
    } finally {
      setIsSaving(false);
    }
  }

  const lineaEstado = vistaPrevia
    ? vistaPrevia.estado.open
      ? `Ahora: abierta, cierra a las ${vistaPrevia.estado.closesAt}`
      : vistaPrevia.estado.nextOpening
        ? `Ahora: cerrada, abre ${vistaPrevia.estado.nextOpening.dayLabel} a las ${vistaPrevia.estado.nextOpening.time}`
        : "Ahora: cerrada todos los días"
    : "Corrige las horas marcadas para ver la vista previa.";

  return (
    <section className="dash-panel ac-hours">
      <div className="dash-panel-head">
        <h2 className="dash-panel-title">Horario de atención</h2>
        <span className="dash-panel-spacer" />
      </div>

      <div className="ac-hours-preview">
        <p className="ac-hours-status">
          <Clock3 size={14} aria-hidden="true" />
          {lineaEstado}
        </p>
        {vistaPrevia && <p className="ac-hours-schedule">{vistaPrevia.horario}</p>}
        <p className="ac-hours-note">
          Fuera de horario la IA sigue vendiendo: le explica al cliente que su venta la procesa el equipo en
          horario regular. Los cobros y el resto del proceso siempre pasan por un asesor.
        </p>
      </div>

      <div className="ac-hours-rows">
        {DAY_KEYS.map((dia) => {
          const franjas = draft[dia];
          const cerrado = franjas.length === 0;
          const error = errores[dia];

          return (
            <div className="ac-hours-row" key={dia} data-error={Boolean(error)}>
              <span className="ac-hours-day">{DAY_LABELS[dia]}</span>

              <label className="ac-hours-closed">
                <input
                  type="checkbox"
                  checked={cerrado}
                  disabled={!canEdit}
                  onChange={(e) => toggleCerrado(dia, e.target.checked)}
                  aria-label={`${DAY_LABELS[dia]} cerrado`}
                />
                Cerrado
              </label>

              {!cerrado && (
                <div className="ac-hours-ranges">
                  {franjas.map((franja, indice) => (
                    <div className="ac-hours-range" key={indice}>
                      <input
                        type="time"
                        value={franja[0]}
                        disabled={!canEdit}
                        onChange={(e) => setFranja(dia, indice, 0, e.target.value)}
                        aria-label={`${DAY_LABELS[dia]}, apertura de la franja ${indice + 1}`}
                      />
                      <span aria-hidden="true">–</span>
                      <input
                        type="time"
                        value={franja[1]}
                        disabled={!canEdit}
                        onChange={(e) => setFranja(dia, indice, 1, e.target.value)}
                        aria-label={`${DAY_LABELS[dia]}, cierre de la franja ${indice + 1}`}
                      />
                      {canEdit && indice === 1 && (
                        <button
                          type="button"
                          className="ac-hours-remove"
                          onClick={() => quitarFranja(dia, indice)}
                          aria-label={`Quitar la segunda franja del ${DAY_LABELS[dia].toLowerCase()}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  ))}

                  {canEdit && franjas.length === 1 && (
                    <button type="button" className="ac-hours-add" onClick={() => agregarFranja(dia)}>
                      <Plus size={13} />
                      Agregar segunda franja
                    </button>
                  )}
                </div>
              )}

              {error && <span className="ac-hours-error">{error}</span>}
            </div>
          );
        })}
      </div>

      {canEdit && (
        <div className="ac-hours-actions">
          <Button size="sm" variant="secondary" onPress={handleSave} isDisabled={isSaving || !esValido}>
            Guardar
          </Button>
        </div>
      )}
    </section>
  );
}
