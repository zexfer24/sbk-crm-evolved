"use client";

import { useNumeroAnimado } from "@/components/paneles/use-numero-animado";

/**
 * Cifra de Asesores que pasa del valor anterior al nuevo al cambiar de período
 * (plan "Paneles", 13/11/2026). `null` es «—» y no anima: un hook no puede ser
 * condicional, así que el que anima vive aparte y solo se monta con un número.
 */
function CifraAnimada({ valor, formato }: { valor: number; formato: (n: number) => string }) {
  return <>{formato(useNumeroAnimado(valor))}</>;
}

export function Cifra({ valor, formato }: { valor: number | null | undefined; formato: (n: number) => string }) {
  if (valor === null || valor === undefined || !Number.isFinite(valor)) return <>—</>;
  return <CifraAnimada valor={valor} formato={formato} />;
}

export const entero = (n: number) => Math.round(n).toLocaleString("es-VE");
