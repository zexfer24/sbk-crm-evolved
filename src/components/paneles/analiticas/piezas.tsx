"use client";

import type { ReactNode } from "react";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { useNumeroAnimado } from "@/components/paneles/use-numero-animado";
import { variacionPct } from "./datos";
import { textoPuntos, textoVariacion } from "./formato";

/**
 * Piezas chicas que comparten las secciones de Analíticas (plan "Paneles", C5,
 * 13/11/2026).
 */

/**
 * Una cifra que pasa del valor anterior al nuevo al cambiar de vista o de
 * período (`useNumeroAnimado`); `null` es «—», nunca 0. El hook se llama
 * siempre —las reglas de los hooks no admiten un `if` antes—, con 0 si no hay dato.
 */
export function Cifra({ valor, formato }: { valor: number | null; formato: (n: number) => string }) {
  const animado = useNumeroAnimado(valor ?? 0);
  return <>{valor === null ? "—" : formato(animado)}</>;
}

function Tendencia({ delta }: { delta: number }) {
  if (delta > 0) return <TrendingUp size={13} aria-hidden="true" />;
  if (delta < 0) return <TrendingDown size={13} aria-hidden="true" />;
  return <Minus size={13} aria-hidden="true" />;
}

function claseDe(delta: number): string {
  if (delta > 0) return "pn-chip pn-chip--bien";
  if (delta < 0) return "pn-chip pn-chip--critico";
  return "pn-chip pn-chip--neutro";
}

/**
 * Texto corto del chip cuando NO existe un período anterior comparable (21/11/2026:
 * el previo arrancaría antes del 16/11/2026). El largo, con el porqué, va en el
 * chip de contexto («Contra: …») y en el bloque «Variación» de Ingresos.
 */
export const TEXTO_SIN_PERIODO_ANTERIOR = "Sin período anterior comparable";

function ChipSinPeriodoAnterior() {
  return <span className="pn-chip pn-chip--neutro">{TEXTO_SIN_PERIODO_ANTERIOR}</span>;
}

/**
 * Variación porcentual contra el período anterior; sin base previa lo dice, no
 * inventa 0 %. Con `sinPrevio` (no hay período anterior comparable) dice eso, y
 * nunca calcula un porcentaje contra nada.
 */
export function ChipVariacion({
  actual,
  previo,
  sinPrevio = false,
}: {
  actual: number | null;
  previo: number | null;
  sinPrevio?: boolean;
}) {
  if (sinPrevio) return <ChipSinPeriodoAnterior />;
  const pct = variacionPct(actual, previo);
  if (pct === null) return <span className="pn-chip pn-chip--neutro">Sin base previa</span>;
  return (
    <span className={claseDe(pct)} title="Contra el período anterior">
      <Tendencia delta={pct} />
      {textoVariacion(pct)}
    </span>
  );
}

/** Diferencia en puntos porcentuales entre dos tasas (conversión, clientes que regresan). */
export function ChipPuntos({
  actual,
  previo,
  sinPrevio = false,
}: {
  actual: number | null;
  previo: number | null;
  sinPrevio?: boolean;
}) {
  if (sinPrevio) return <ChipSinPeriodoAnterior />;
  if (actual === null || previo === null) return <span className="pn-chip pn-chip--neutro">Sin base previa</span>;
  const delta = actual - previo;
  return (
    <span className={claseDe(delta)} title="Contra el período anterior">
      <Tendencia delta={delta} />
      {textoPuntos(actual, previo)}
    </span>
  );
}

/**
 * La caja con id de cada sección: ocupa el ancho entero del bento y adentro
 * lleva su propia grilla de 12 columnas.
 */
export function Seccion({ id, indice, children }: { id: string; indice: number; children: ReactNode }) {
  return (
    <section id={id} className="pn-c12 an-sec an-sube" style={{ ["--i" as string]: indice }}>
      <div className="pn-bento">{children}</div>
    </section>
  );
}
