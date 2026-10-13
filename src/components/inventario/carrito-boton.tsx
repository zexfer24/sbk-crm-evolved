"use client";

import { ShoppingCart } from "lucide-react";
import { useInventarioCarrito } from "@/components/inventario/inventario-carrito-context";

/**
 * Botón FLOTANTE que abre el panel del carrito de cotización del Inventario
 * (12/10/2026, plan "Carrito de cotización en el Inventario, con Cashea", T5;
 * pasó de la cabecera a un círculo fijo abajo a la derecha el 13/10/2026, plan
 * "Inventario y caja", T3: desde la cabecera quedaba fuera de la vista apenas
 * el asesor bajaba por la lista, que es donde agrega).
 *
 * Es `position: fixed` (ver `inventario.css`), así que no ocupa lugar en el
 * flujo: por eso `InventarioView` puede montarlo dentro de `<main>` sin
 * sumarle un hijo a la grilla de `.dash-frame` (trampa del 9/9/2026). Vive en
 * su propio client component porque `InventarioView` es un server component y
 * no puede leer el contexto. Fuera del provider no pinta nada: sin carrito no
 * hay a qué abrir.
 */
export function CarritoBoton() {
  const carrito = useInventarioCarrito();
  if (!carrito) return null;

  const { unidades, abrir } = carrito;
  return (
    <button
      type="button"
      className="inv-carrito-flotante"
      onClick={abrir}
      aria-label={unidades > 0 ? `Abrir carrito (${unidades} ${unidades === 1 ? "unidad" : "unidades"})` : "Abrir carrito"}
    >
      <ShoppingCart size={22} aria-hidden="true" />
      {/* El número ya va en el aria-label; el globo es solo visual. */}
      {unidades > 0 && (
        <span className="inv-carrito-globo lm-num" aria-hidden="true">
          {unidades}
        </span>
      )}
    </button>
  );
}
