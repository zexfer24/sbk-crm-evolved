"use client";

import { createContext, useContext } from "react";
import type { Product } from "@/lib/types";
import type { LineaCarritoInventario, OpcionesCashea } from "@/lib/inventario-carrito";

/**
 * Contexto del carrito de cotización del Inventario (12/10/2026, plan
 * "Carrito de cotización en el Inventario, con Cashea", T5).
 *
 * Vive en su propio archivo para cortar un import circular: el provider
 * importa `CarritoPanel` (lo monta por portal) y el panel necesitaba el hook
 * que exportaba el provider. Ahora los dos importan de aquí y el provider
 * re-exporta el hook y el tipo para no romper los imports que ya existían.
 */

export interface InventarioCarritoValue {
  lineas: LineaCarritoInventario[];
  /** Suma de cantidades (no de renglones). */
  unidades: number;
  /** 0 si el producto no está en el carrito. */
  cantidadDe(productId: string): number;
  agregar(product: Product): void;
  cambiarCantidad(productId: string, quantity: number): void;
  quitar(productId: string): void;
  vaciar(): void;
  abierto: boolean;
  abrir(): void;
  cerrar(): void;
  cashea: OpcionesCashea;
  setCashea(cashea: OpcionesCashea): void;
}

export const CarritoContext = createContext<InventarioCarritoValue | null>(null);

/** `null` fuera del provider: la fila del Inventario se renderiza sin él en tests y pantallas viejas. */
export function useInventarioCarrito(): InventarioCarritoValue | null {
  return useContext(CarritoContext);
}
