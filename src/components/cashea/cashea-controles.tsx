"use client";

import {
  AVISO_SEIS_CUOTAS,
  NIVELES_CASHEA,
  calcularCashea,
  cuotasDisponibles,
  porcentajeInicial,
  type CuotasCashea,
  type EleccionCashea,
  type NivelCashea,
} from "@/lib/cashea";
import "./cashea.css";

// Controles de Cashea (12/10/2026, plan "Carrito de cotización en el Inventario,
// con Cashea", T7): los comparten el carrito del Inventario y el modal de la
// calculadora por producto. El marcado es el de la calculadora, que salió
// primero y es la referencia (radios de nivel, botones de cuotas con
// `aria-pressed`, interruptor "Bajada de inicial"): el carrito tenía su propia
// copia con otro marcado y se unificó a este. Ningún número de regla vive
// aquí: porcentajes y umbral salen de `CASHEA` a través de `@/lib/cashea`.
//
// `.ac-switch` (agent-control.css) lo importa la vista que monte este
// componente, no él.

interface CasheaControlesProps {
  /** Decide si las 6 cuotas están disponibles. */
  montoCents: number;
  eleccion: EleccionCashea;
  onChange: (eleccion: EleccionCashea) => void;
}

const OPCIONES_CUOTAS: readonly CuotasCashea[] = [3, 6];

export function CasheaControles({ montoCents, eleccion, onChange }: CasheaControlesProps) {
  const seisDisponible = cuotasDisponibles(montoCents).includes(6);
  // El botón marcado son las cuotas EFECTIVAS: con 6 pedidas y un monto que no
  // las habilita se ve el 3, que es lo que el plan va a calcular. La pieza no
  // reescribe la elección: quien la guarda aplica la regla "si había 6 y el
  // monto baja a $100 o menos, pasa a 3 y subir el monto NO revive el 6"
  // (la calculadora y el provider del carrito, durante el render).
  const cuotasEfectivas = calcularCashea({ montoCents, ...eleccion }).cuotas;

  return (
    <div className="cashea-controles">
      <div className="cashea-bloque">
        <span className="lm-eyebrow">Nivel Cashea</span>
        <div className="cashea-niveles" role="radiogroup" aria-label="Nivel Cashea">
          {NIVELES_CASHEA.map((nivel: NivelCashea) => (
            <button
              key={nivel}
              type="button"
              role="radio"
              aria-checked={eleccion.nivel === nivel}
              className="cashea-opcion"
              onClick={() => onChange({ ...eleccion, nivel })}
            >
              {`N${nivel} · ${porcentajeInicial(nivel, eleccion.bajada)} %`}
            </button>
          ))}
        </div>
      </div>

      <div className="cashea-bloque">
        <span className="lm-eyebrow">Cuotas</span>
        <div className="cashea-cuotas" role="group" aria-label="Cuotas">
          {OPCIONES_CUOTAS.map((cuotas) => (
            <button
              key={cuotas}
              type="button"
              className="cashea-opcion"
              aria-pressed={cuotasEfectivas === cuotas}
              disabled={cuotas === 6 && !seisDisponible}
              onClick={() => onChange({ ...eleccion, cuotas })}
            >
              {`${cuotas} cuotas`}
            </button>
          ))}
        </div>
        {!seisDisponible && (
          <p className="cashea-nota" role="status">
            {AVISO_SEIS_CUOTAS}
          </p>
        )}
      </div>

      {/* P2: si la bajada es definitiva, se borra este bloque */}
      <div className="cashea-bajada">
        <button
          type="button"
          className="ac-switch"
          role="switch"
          aria-checked={eleccion.bajada}
          data-on={eleccion.bajada}
          aria-label="Bajada de inicial"
          onClick={() => onChange({ ...eleccion, bajada: !eleccion.bajada })}
        />
        <span>Bajada de inicial</span>
      </div>
    </div>
  );
}
