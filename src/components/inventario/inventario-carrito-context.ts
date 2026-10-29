"use client";

import { createContext, useContext } from "react";
import type { CartPriceKind, Product } from "@/lib/types";
import type { LineaCarritoInventario, OpcionesCashea } from "@/lib/inventario-carrito";
import type { Presupuesto } from "@/lib/presupuestos";

/**
 * Contexto del carrito de cotización del Inventario (12/10/2026, plan
 * "Carrito de cotización en el Inventario, con Cashea", T5).
 *
 * Vive en su propio archivo para cortar un import circular: el provider
 * importa `CarritoPanel` (lo monta por portal) y el panel necesitaba el hook
 * que exportaba el provider. Ahora los dos importan de aquí y el provider
 * re-exporta el hook y el tipo para no romper los imports que ya existían.
 *
 * 21/10/2026 ("Presupuestos y mensajes rápidos", T4): el contexto suma el
 * precio estándar (interruptor del carrito entero) y el presupuesto activo —el
 * guardado que el asesor abrió y sigue editando—. `cargarPresupuesto` y
 * `olvidarPresupuestoActivo` son la puerta de la lista «Presupuestos
 * guardados» (T5).
 */

/** Del presupuesto abierto solo se guarda lo que el chip y el modal necesitan; los renglones viven en `lineas`. */
export interface PresupuestoActivo {
  id: string;
  clienteNombre: string;
  clienteApellido: string;
  nota: string | null;
  createdBy: string | null;
}

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
  /** A qué precio se cobra el carrito entero; `"mixto"` si hay de los dos, `null` si está vacío. */
  priceKind: CartPriceKind | "mixto" | null;
  /** Interruptor de este carrito: lo que se agrega entra a estándar mientras esté encendido; siempre `false` para la caja. No se recuerda (28/10/2026): arranca apagado y dura lo que dura el carrito. */
  cobrarEstandar: boolean;
  /** Pasa TODOS los renglones al precio elegido. No se guarda para el próximo carrito. No hace nada para la caja. */
  setCobrarEstandar(valor: boolean): void;
  /** `false` para la caja: la base no le entrega la tarifa MRW (decisión D4). */
  puedeCobrarEstandar: boolean;
  presupuestoActivo: PresupuestoActivo | null;
  /** Reemplaza el carrito por los renglones del presupuesto (a precio de HOY), lo deja como activo y abre el panel. */
  cargarPresupuesto(presupuesto: Presupuesto): void;
  marcarPresupuestoGuardado(activo: PresupuestoActivo): void;
  /** Quita el chip sin tocar los renglones (T5 lo usa al borrar el presupuesto abierto). */
  olvidarPresupuestoActivo(): void;
}

export const CarritoContext = createContext<InventarioCarritoValue | null>(null);

/** `null` fuera del provider: la fila del Inventario se renderiza sin él en tests y pantallas viejas. */
export function useInventarioCarrito(): InventarioCarritoValue | null {
  return useContext(CarritoContext);
}
