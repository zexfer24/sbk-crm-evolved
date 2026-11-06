"use client";

import { TriangleAlert } from "lucide-react";
import type { MonedaCarrito } from "@/lib/carrito-divisa";
import "./moneda-toggle.css";

/**
 * El interruptor «BCV | Divisa» del carrito y su píldora «Falta divisa (N)»
 * (6/11/2026, pedido del cliente: «Al agregar al carrito aquí, no me sale el
 * precio divisa, puedes agregarlo para que se vea igualmente arriba en cada
 * producto y el total? Porque los clientes después que se les arma todo van y
 * preguntan por divisa»). Lo usan el carrito del chat y, después, el de
 * /inventario: un solo control para que el asesor lea lo mismo en los dos.
 *
 * El estado NO se recuerda (ni entre conversaciones ni entre sesiones): el
 * carrito arranca siempre en BCV. Así nadie le copia al siguiente cliente un
 * precio en divisa sin darse cuenta. Este componente es solo presentación; el
 * estado vive en quien lo monta.
 */

const OPCIONES: { valor: MonedaCarrito; etiqueta: string }[] = [
  { valor: "bcv", etiqueta: "BCV" },
  { valor: "divisa", etiqueta: "Divisa" },
];

export function MonedaToggle({
  value,
  onChange,
  disabled = false,
  className,
}: {
  value: MonedaCarrito;
  onChange: (moneda: MonedaCarrito) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label="Moneda del carrito" className={className ? `moneda-toggle ${className}` : "moneda-toggle"}>
      {OPCIONES.map((opcion) => (
        <button
          key={opcion.valor}
          type="button"
          role="radio"
          aria-checked={value === opcion.valor}
          disabled={disabled}
          onClick={() => {
            // Elegir la opción ya marcada no cambia nada.
            if (opcion.valor !== value) onChange(opcion.valor);
          }}
        >
          {opcion.etiqueta}
        </button>
      ))}
    </div>
  );
}

/**
 * Ocupa el lugar del total en divisa cuando a algún renglón le falta el precio
 * divisa: un total al que le falta un renglón es un precio falso, así que no se
 * muestra número, solo cuántos faltan. Misma forma que `AvisoFaltanPesos`.
 */
export function AvisoFaltaDivisa({ cantidad }: { cantidad: number }) {
  return (
    <span className="aviso-divisa">
      <TriangleAlert size={12} strokeWidth={2.5} aria-hidden="true" />
      Falta divisa ({cantidad})
    </span>
  );
}
