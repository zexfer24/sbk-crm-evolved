"use client";

import Link from "next/link";
import type { EquipoActiva, MontoCantidad, PanelVentasActivas } from "@/lib/paneles/parse";
import { formatoUsd } from "@/components/paneles/panel-marco";
import { textoVentana } from "@/components/paneles/dashboard/calculos";

/**
 * Lo que comparten la tarjeta «Ventas activas», su hoja y la tabla de
 * Analíticas (22/11/2026, plan "Ventas activas"): cómo se dice el equipo de una
 * venta, el chip de su ventana de WhatsApp y el enlace al chat.
 */

type ItemActiva = PanelVentasActivas["items"][number];

/** El equipo (rol de quien armó la venta) con palabras de negocio; «—» si el ítem no lo trae. */
export const ETIQUETA_EQUIPO_ITEM: Record<EquipoActiva, string> = {
  online: "Online",
  tienda: "Tienda (caja)",
  sin_dato: "Sin dato",
};

export function textoEquipoItem(item: ItemActiva): string {
  return item.equipo ? ETIQUETA_EQUIPO_ITEM[item.equipo] : "—";
}

/** `N · $X` de una celda de la matriz; un cero es «0» (no «0 · —»), y un monto sin calcular es «—». */
export function textoCelda(c: MontoCantidad): string {
  return c.cantidad === 0 ? "0" : `${c.cantidad} · ${formatoUsd(c.monto)}`;
}

/**
 * La ventana de WhatsApp de una venta: el chip dice cuánto le queda («quedan 3
 * h»), «Cerrada» (solo plantilla) o «Sin chat», y mientras todavía se le puede
 * escribir al cliente (abierta o por cerrar) trae el enlace al chat. Por cerrar
 * va en alerta: es lo que hay que atender primero.
 */
export function VentanaDeItem({ item, ahora }: { item: ItemActiva; ahora: Date }) {
  const puedeEscribirse = (item.ventana === "abierta" || item.ventana === "por_cerrar") && item.conversation_id !== null;
  return (
    <span className="pd-ventana">
      <span className={`pn-chip ${item.ventana === "por_cerrar" ? "pn-chip--alerta" : "pn-chip--neutro"}`}>
        {textoVentana(item, ahora)}
      </span>
      {puedeEscribirse && (
        <Link className="pd-ventana__chat" href={`/inbox?conversation=${item.conversation_id}`}>
          Abrir chat
        </Link>
      )}
    </span>
  );
}
