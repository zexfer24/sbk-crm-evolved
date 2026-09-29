"use client";

import { useState } from "react";
import { toast } from "@heroui/react";
import type { AgentSettings } from "@/lib/types";
import { configErrorMessage } from "@/lib/config-write";

interface DemoraPanelProps {
  settings: AgentSettings;
  canEdit: boolean;
  /** Escribe el interruptor. Lanza si la base lo ignora (RLS) o falla. */
  onToggle: (activa: boolean) => Promise<void>;
}

/** "29 sep, 11:30 a. m." en la hora de la tienda; `null` si la fecha no se puede leer. */
function desdeCuando(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("es-VE", {
    timeZone: "America/Caracas",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Interruptor "Reasignar si el asesor tarda" (T10b-5, plan "Seba encuentra…",
 * 29/9/2026). Prende el cron de demora: si un cliente lleva esperando a un
 * asesor, a los 10 min responde Seba, a los 15 min de horario el caso se le
 * pasa a otro asesor (nunca al mismo), con un tope de 2 reasignaciones y
 * aviso al supervisor. Nace apagado; el orden de encendido (desplegar,
 * avisar a los asesores, encender) está en la nota de entrega.
 *
 * Reusa el aspecto de `.ac-kill`/`.ac-switch` del interruptor global (sin el
 * punto de color: "apagado" aquí es el estado normal, no una alarma). El
 * interruptor se mueve al instante y vuelve solo si el guardado falla, por
 * eso el estado optimista local: el padre solo actualiza `settings` cuando
 * la base confirmó.
 */
export function DemoraPanel({ settings, canEdit, onToggle }: DemoraPanelProps) {
  const [optimista, setOptimista] = useState<boolean | null>(null);
  const activa = optimista ?? settings.demoraActiva === true;
  const desde = activa ? desdeCuando(settings.demoraActivaDesde) : null;

  async function alternar() {
    const siguiente = !activa;
    setOptimista(siguiente);
    try {
      await onToggle(siguiente);
    } catch (error) {
      toast.danger(configErrorMessage(error, "No se pudo cambiar la reasignación por demora."));
    } finally {
      // Con éxito el padre ya trae el valor nuevo en `settings`; con error
      // se vuelve al valor de la base. En los dos casos el optimismo sobra.
      setOptimista(null);
    }
  }

  return (
    <section className="dash-panel ac-kill" data-on={activa}>
      <div className="ac-kill-status">
        <div>
          <p className="ac-kill-title">
            {activa ? "Reasignar si el asesor tarda: activado" : "Reasignar si el asesor tarda: apagado"}
          </p>
          <p className="ac-kill-note" data-testid="demora-ayuda">
            A los 10 min sin respuesta del asesor contesta Seba; a los 15 min de horario el caso pasa a otro
            asesor (nunca al mismo). Tope de 2 reasignaciones: después se avisa al supervisor y no se rota más.
            {!canEdit && " Solo un supervisor o admin puede cambiar la reasignación."}
          </p>
          {desde && <p className="ac-kill-note">Encendida desde {desde}: nada anterior se reasigna.</p>}
        </div>
      </div>

      <button
        className="ac-switch"
        type="button"
        role="switch"
        aria-checked={activa}
        data-on={activa}
        onClick={() => void alternar()}
        disabled={!canEdit || optimista !== null}
        aria-label="Reasignar si el asesor tarda"
      />
    </section>
  );
}
