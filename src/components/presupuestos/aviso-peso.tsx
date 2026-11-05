"use client";

import { TriangleAlert } from "lucide-react";
import "./presupuestos.css";

/**
 * Los dos avisos del «Peso total» incompleto (5/11/2026, pedido del cliente).
 * Los comparten el pie del carrito del chat y los totales del carrito de
 * /inventario: un solo texto y un solo estilo, para que el asesor lea lo mismo
 * en los dos sitios.
 *
 * Con algún renglón sin peso NO se muestra ningún número (un peso incompleto
 * parece un peso real y se cotizaría un envío de menos): se dice cuántos
 * faltan. El ícono acompaña al texto para que el aviso no dependa solo del
 * color.
 */

/**
 * La píldora que ocupa el lugar del valor: «Faltan pesos (2)». Sin
 * `role="status"` a propósito: es un dato del pie que está ahí desde que se
 * pinta el carrito (no un aviso que aparezca de golpe), y el estado de «Enviar
 * a SAINT», que vive en el mismo pie, ya es el `status` que los lectores y los
 * tests buscan.
 */
export function AvisoFaltanPesos({ cantidad }: { cantidad: number }) {
  return (
    <span className="aviso-peso">
      <TriangleAlert size={12} strokeWidth={2.5} aria-hidden="true" />
      Faltan pesos ({cantidad})
    </span>
  );
}

/**
 * Bajo la vista previa de la copia, con «Peso total» encendida y pesos
 * faltantes: la línea no se escribe en el texto (no se le manda «faltan pesos»
 * al cliente) y esto se lo dice al asesor. Va FUERA de la vista previa: el
 * texto que se copia no cambia.
 */
export function NotaPesoNoIncluido({ cantidad }: { cantidad: number }) {
  return (
    <p className="aviso-nota" role="status">
      <TriangleAlert size={12} strokeWidth={2.5} aria-hidden="true" className="aviso-nota-icono" />
      No se incluye «Peso total»: faltan pesos ({cantidad}).
    </p>
  );
}
