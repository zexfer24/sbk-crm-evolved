import { formatoUsd } from "@/components/paneles/panel-marco";

/**
 * Formatos de Analíticas (plan "Paneles", C5, 13/11/2026). `null` es "no se
 * puede calcular" y siempre sale como «—»: nunca un cero que parezca verdad.
 */

export { formatoUsd };

const DECIMALES = (n: number) => ({ minimumFractionDigits: n, maximumFractionDigits: n });

export function formatoEntero(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("es-VE");
}

/** `fraccion` de 0 a 1 → «25 %». */
export function formatoFraccion(fraccion: number | null | undefined): string {
  if (fraccion === null || fraccion === undefined || !Number.isFinite(fraccion)) return "—";
  return `${Math.round(fraccion * 100)} %`;
}

/** Bolívares con la tasa del día; «—» si no hay tasa o no hay monto. */
export function formatoBs(usd: number | null, tasa: number): string {
  if (usd === null || !(tasa > 0)) return "—";
  return `Bs. ${(usd * tasa).toLocaleString("es-VE", DECIMALES(2))}`;
}

/**
 * Dólares para los ejes y las lecturas del gráfico: enteros si lo son (las
 * marcas del eje siempre lo son), con centavos si no, y «k» desde 10 mil para
 * que la etiqueta del eje quepa en el margen del SVG.
 */
export function usdGrafico(n: number): string {
  if (Number.isInteger(n)) {
    if (n >= 10_000) return `$${(n / 1000).toLocaleString("es-VE", { maximumFractionDigits: 1 })}k`;
    return `$${n.toLocaleString("es-VE")}`;
  }
  return formatoUsd(n);
}

/** «+12 %», «−4 %» o «0 %» (con el signo menos tipográfico). */
export function textoVariacion(pct: number): string {
  const redondeado = Math.round(pct);
  if (redondeado === 0) return "0 %";
  return `${redondeado > 0 ? "+" : "−"}${Math.abs(redondeado)} %`;
}

/** «+5 pp» / «−2 pp»: diferencia en puntos porcentuales entre dos fracciones. */
export function textoPuntos(actual: number, previo: number): string {
  const pp = Math.round((actual - previo) * 100);
  if (pp === 0) return "0 pp";
  return `${pp > 0 ? "+" : "−"}${Math.abs(pp)} pp`;
}

/** Iniciales para el avatar: «Ana Pérez» → «AP». */
export function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[1][0]).toUpperCase();
}
