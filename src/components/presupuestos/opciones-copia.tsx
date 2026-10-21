"use client";

import { CAMPOS_COPIA, type OpcionesCopia } from "@/lib/copia-carrito";
import "./presupuestos.css";

/**
 * Las casillas de «qué incluir al copiar» (21/10/2026, plan "Presupuestos y
 * mensajes rápidos", T3). Las comparten el carrito de /inventario y el panel
 * del chat: las mismas casillas, recordadas por asesor (`useOpcionesCopia`).
 *
 * El nombre del producto siempre va, por eso su casilla está marcada y
 * deshabilitada: un resumen sin nombres no le dice nada al cliente. «Plan
 * Cashea» solo existe en el Inventario (`mostrarCashea`). Compacta a
 * propósito: tiene que caber en los 268 px del panel del chat.
 */

interface OpcionesCopiaCasillasProps {
  opciones: OpcionesCopia;
  onChange: (opciones: OpcionesCopia) => void;
  /** El carrito del chat no calcula Cashea: ahí la casilla no se muestra. */
  mostrarCashea: boolean;
  /** Distingue los ids cuando hay dos juegos de casillas en la misma pantalla. */
  idPrefix: string;
}

export function OpcionesCopiaCasillas({ opciones, onChange, mostrarCashea, idPrefix }: OpcionesCopiaCasillasProps) {
  return (
    <fieldset className="pr-copia">
      <legend className="pr-copia-leyenda">Qué incluir al copiar</legend>
      <div className="pr-copia-lista">
        <label className="pr-copia-casilla pr-copia-casilla-fija" htmlFor={`${idPrefix}-nombre`}>
          <input id={`${idPrefix}-nombre`} type="checkbox" checked disabled readOnly />
          Nombre
        </label>
        {CAMPOS_COPIA.filter((campo) => mostrarCashea || !campo.soloInventario).map((campo) => (
          <label key={campo.clave} className="pr-copia-casilla" htmlFor={`${idPrefix}-${campo.clave}`}>
            <input
              id={`${idPrefix}-${campo.clave}`}
              type="checkbox"
              checked={opciones[campo.clave]}
              onChange={(e) => onChange({ ...opciones, [campo.clave]: e.target.checked })}
            />
            {campo.etiqueta}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
