"use client";

import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useNumeroAnimado } from "@/components/paneles/use-numero-animado";

/**
 * Piezas chicas que comparten las tarjetas del Dashboard (plan "Paneles", C4,
 * 13/11/2026).
 */

/**
 * Una cifra que pasa del valor anterior al nuevo cuando cambia la vista o el
 * período (`useNumeroAnimado`: sin movimiento reducido cuenta; con él, salta al
 * final). `null` es "no se puede calcular" y se pinta «—», nunca 0.
 */
export function Cifra({
  valor,
  formato,
  className,
}: {
  valor: number | null;
  formato: (n: number) => string;
  className?: string;
}) {
  const animado = useNumeroAnimado(valor ?? 0);
  return <span className={className}>{valor === null ? "—" : formato(animado)}</span>;
}

/** «12,2» para 12.2: un decimal como máximo, coma decimal. */
export function formatoDecimal(n: number): string {
  return n.toLocaleString("es-VE", { maximumFractionDigits: 1 });
}

export function formatoEntero(n: number): string {
  return Math.round(n).toLocaleString("es-VE");
}

export function formatoPorcentaje(n: number): string {
  return `${formatoDecimal(n)} %`;
}

/**
 * Chip de variación contra el período previo. El sentido va en el ícono y en
 * el signo del texto, no solo en el color. `variacion` null con previo leído =
 * "Sin referencia" (el previo no tuvo ventas con qué comparar).
 */
export function ChipVariacion({ variacion, contra }: { variacion: number | null; contra: string }): ReactNode {
  if (variacion === null) {
    return (
      <span className="pn-chip pn-chip--neutro">
        <Minus size={13} aria-hidden="true" />
        Sin referencia previa
      </span>
    );
  }
  const sube = variacion >= 0;
  const Icono = sube ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={sube ? "pn-chip pn-chip--bien" : "pn-chip pn-chip--critico"}>
      <Icono size={13} aria-hidden="true" />
      {sube ? "+" : "−"}
      {formatoPorcentaje(Math.abs(variacion))} vs. {contra}
    </span>
  );
}

/** Texto en singular/plural sin armar la frase a mano en cada sitio. */
export function plural(n: number, singular: string, pluralTexto: string): string {
  return n === 1 ? singular : pluralTexto;
}
