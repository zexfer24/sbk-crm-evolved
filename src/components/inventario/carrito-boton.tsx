"use client";

import { ShoppingCart } from "lucide-react";
import { useInventarioCarrito } from "@/components/inventario/inventario-carrito-context";

/**
 * Botón de la cabecera del Inventario que abre el panel del carrito de
 * cotización (12/10/2026, plan "Carrito de cotización en el Inventario, con
 * Cashea", T5). Vive en su propio client component porque `InventarioView` es
 * un server component y no puede leer el contexto. Fuera del provider no pinta
 * nada: sin carrito no hay a qué abrir.
 */
export function CarritoBoton() {
  const carrito = useInventarioCarrito();
  if (!carrito) return null;

  const { unidades, abrir } = carrito;
  return (
    <button
      type="button"
      className="crm-pill inv-carrito-boton"
      onClick={abrir}
      aria-label={unidades > 0 ? `Abrir carrito (${unidades} ${unidades === 1 ? "unidad" : "unidades"})` : "Abrir carrito"}
    >
      <ShoppingCart size={14} aria-hidden="true" />
      {unidades > 0 ? `Carrito · ${unidades}` : "Carrito"}
    </button>
  );
}
