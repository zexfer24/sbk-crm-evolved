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
// con Cashea"): los comparten el carrito del Inventario y el modal de la
// calculadora por producto. Ningún número de regla vive aquí: porcentajes y
// umbral salen de `CASHEA` a través de las funciones de `@/lib/cashea`.
//
// Las hojas `crm.css` (.crm-pill) y `agent-control.css` (.ac-switch) las
// importa la vista que monte este componente, no él.

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
  // las habilita se ve el 3, que es lo que el plan va a calcular. La elección
  // pedida no se reescribe sola: si el monto vuelve a subir, el 6 reaparece.
  const cuotasEfectivas = calcularCashea({ montoCents, ...eleccion }).cuotas;

  return (
    <div className="cashea-controles">
      <div className="cashea-grupo">
        <span className="cashea-grupo-titulo">Nivel</span>
        <div className="cashea-pildoras" role="group" aria-label="Nivel Cashea">
          {NIVELES_CASHEA.map((nivel: NivelCashea) => {
            const pct = porcentajeInicial(nivel, eleccion.bajada);
            const activo = eleccion.nivel === nivel;
            return (
              <button
                key={nivel}
                type="button"
                className="crm-pill"
                aria-pressed={activo}
                aria-label={`Nivel ${nivel}, inicial ${pct}%`}
                {...(activo ? { "data-active": "true" } : {})}
                onClick={() => onChange({ ...eleccion, nivel })}
              >
                <span>N{nivel}</span>
                <span className="cashea-nivel-pct lm-num">{pct}%</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="cashea-grupo">
        <span className="cashea-grupo-titulo">Cuotas</span>
        <div className="cashea-pildoras" role="group" aria-label="Cuotas">
          {OPCIONES_CUOTAS.map((cuotas) => {
            const activo = cuotasEfectivas === cuotas;
            return (
              <button
                key={cuotas}
                type="button"
                className="crm-pill"
                aria-pressed={activo}
                disabled={cuotas === 6 && !seisDisponible}
                {...(activo ? { "data-active": "true" } : {})}
                onClick={() => onChange({ ...eleccion, cuotas })}
              >
                {cuotas} cuotas
              </button>
            );
          })}
        </div>
        {!seisDisponible && <p className="cashea-aviso">{AVISO_SEIS_CUOTAS}</p>}
      </div>

      <div className="cashea-bajada">
        <span className="cashea-bajada-texto" aria-hidden="true">
          Bajada de inicial
        </span>
        <button
          type="button"
          role="switch"
          className="ac-switch"
          aria-checked={eleccion.bajada}
          aria-label="Inicial con bajada (promoción de Cashea)"
          data-on={eleccion.bajada}
          onClick={() => onChange({ ...eleccion, bajada: !eleccion.bajada })}
        />
      </div>
    </div>
  );
}
