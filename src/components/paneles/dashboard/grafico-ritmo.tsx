"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { anchoDeEtiqueta, gridValuesFor, pasoDeEtiquetas } from "@/lib/chart-scale";
import { useAnchoMedido } from "@/components/paneles/use-ancho-medido";
import { formatoUsd } from "@/components/paneles/panel-marco";

/**
 * Ritmo del día por hora (plan "Paneles", C4, 13/11/2026): lo acumulado real
 * contra la meta acumulada, en la tarjeta oscura. Es propio y no `LineaArea`
 * porque la línea real SE CORTA en la hora actual (las horas que faltan no
 * son 0, son futuro) y `LineaArea` no admite huecos.
 *
 * Mismas reglas de los gráficos de `panel-graficos.tsx`: `role="img"` con el
 * resumen en texto, lectura exacta por puntero y por teclado (flechas, Inicio,
 * Fin, Esc) y colores solo por `var(--pn-hero-*)`.
 *
 * Píxeles reales (15/11/2026): igual que `LineaArea`, dibuja sobre un `viewBox`
 * del mismo ancho que su contenedor (`useAnchoMedido`) y no sobre uno fijo de
 * 600 estirado, que escalaba el texto de los ejes (30 px de alto a 1440 px, 8 px
 * a 390 px) y engordaba los trazos. Cuántas horas se rotulan sale del ancho.
 */

const ALTO = 170;
const MARGEN_DER = 10;
const MARGEN_SUP = 10;
const MARGEN_INF = 24;

export function GraficoRitmo({
  real,
  meta,
  desdeHora,
  hastaHora,
  horaActual,
  ariaLabel,
}: {
  /** Lo vendido hasta el cierre de cada hora 0..`horaActual`. */
  real: number[];
  /** La meta acumulada al cierre de cada hora (24 valores). */
  meta: number[];
  /** Primera y última hora del eje X (inclusive). */
  desdeHora: number;
  hastaHora: number;
  /** La hora de Caracas en curso: la línea real termina ahí. */
  horaActual: number;
  ariaLabel: string;
}) {
  const [activa, setActiva] = useState<number | null>(null);
  const { ref: lienzoRef, ancho } = useAnchoMedido();

  const horas = Array.from({ length: Math.max(hastaHora - desdeHora + 1, 1) }, (_, i) => desdeHora + i);

  const maximo = Math.max(...horas.map((h) => meta[h] ?? 0), ...real, 1);
  const pico = Math.ceil(maximo / 100) * 100 || 1;
  const etiquetaY = (valor: number) => formatoUsd(valor).replace(",00", "");
  const anchoY = Math.max(0, ...gridValuesFor(pico).map((v) => anchoDeEtiqueta(etiquetaY(v))));
  const margenIzq = Math.ceil(Math.max(32, anchoY + 10));
  const plotW = ancho - margenIzq - MARGEN_DER;
  const plotH = ALTO - MARGEN_SUP - MARGEN_INF;
  // Rótulos de hora ("08") centrados en cada hora: caben los que entren entre dos horas consecutivas.
  const pasoHoras = pasoDeEtiquetas(horas.length <= 1 ? plotW : plotW / (horas.length - 1), anchoDeEtiqueta("00"));
  const xDe = (h: number) => margenIzq + (horas.length <= 1 ? plotW / 2 : ((h - desdeHora) / (horas.length - 1)) * plotW);
  const yDe = (v: number) => MARGEN_SUP + plotH - (Math.max(0, v) / pico) * plotH;

  const trazo = (valores: { h: number; v: number }[]) =>
    valores.map(({ h, v }, i) => `${i === 0 ? "M" : "L"}${xDe(h).toFixed(1)} ${yDe(v).toFixed(1)}`).join(" ");

  const puntosMeta = horas.map((h) => ({ h, v: meta[h] ?? 0 }));
  const puntosReal = horas.filter((h) => h <= horaActual && real[h] !== undefined).map((h) => ({ h, v: real[h] }));

  const lectura =
    activa === null
      ? null
      : {
          hora: activa,
          real: activa <= horaActual ? (real[activa] ?? 0) : null,
          meta: meta[activa] ?? 0,
        };
  const textoLectura = lectura
    ? `${String(lectura.hora).padStart(2, "0")}:00. Real ${lectura.real === null ? "—" : formatoUsd(lectura.real)}, meta ${formatoUsd(lectura.meta)}.`
    : "";

  function elegirPorPuntero(evento: PointerEvent<SVGRectElement>) {
    const caja = evento.currentTarget.getBoundingClientRect();
    if (caja.width <= 0) return;
    const fraccion = Math.min(1, Math.max(0, (evento.clientX - caja.left) / caja.width));
    setActiva(desdeHora + Math.round(fraccion * (horas.length - 1)));
  }

  function alTeclear(evento: KeyboardEvent<HTMLElement>) {
    let siguiente: number | null;
    switch (evento.key) {
      case "ArrowRight":
      case "ArrowDown":
        siguiente = activa === null ? desdeHora : Math.min(hastaHora, activa + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        siguiente = activa === null ? hastaHora : Math.max(desdeHora, activa - 1);
        break;
      case "Home":
        siguiente = desdeHora;
        break;
      case "End":
        siguiente = hastaHora;
        break;
      case "Escape":
        siguiente = null;
        break;
      default:
        return;
    }
    evento.preventDefault();
    setActiva(siguiente);
  }

  return (
    <div className="pd-ritmo" onPointerLeave={() => setActiva(null)}>
      <div ref={lienzoRef} className="pn-graf__lienzo" role="img" aria-label={ariaLabel} tabIndex={0} onKeyDown={alTeclear}>
        <svg className="pn-svg" viewBox={`0 0 ${ancho} ${ALTO}`} aria-hidden="true">
          <g className="pd-ritmo__rejilla">
            {gridValuesFor(pico).map((valor) => (
              <g key={valor}>
                <line x1={margenIzq} x2={margenIzq + plotW} y1={yDe(valor)} y2={yDe(valor)} />
                <text x={margenIzq - 6} y={yDe(valor) + 3.5} textAnchor="end">
                  {etiquetaY(valor)}
                </text>
              </g>
            ))}
            {horas.map((h, i) =>
              i % pasoHoras === 0 ? (
                <text key={h} x={xDe(h)} y={ALTO - 6} textAnchor="middle">
                  {String(h).padStart(2, "0")}
                </text>
              ) : null
            )}
          </g>
          <path className="pd-ritmo__meta" d={trazo(puntosMeta)} fill="none" strokeWidth={2} strokeDasharray="5 5" strokeLinecap="round" />
          {puntosReal.length > 0 && (
            <path className="pd-ritmo__real" d={trazo(puntosReal)} fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          )}
          {lectura && (
            <g aria-hidden="true">
              <line className="pd-ritmo__cursor" x1={xDe(lectura.hora)} x2={xDe(lectura.hora)} y1={MARGEN_SUP} y2={MARGEN_SUP + plotH} />
              <circle className="pd-ritmo__punto-meta" cx={xDe(lectura.hora)} cy={yDe(lectura.meta)} r={4} />
              {lectura.real !== null && <circle className="pd-ritmo__punto-real" cx={xDe(lectura.hora)} cy={yDe(lectura.real)} r={4} />}
            </g>
          )}
          <rect
            x={margenIzq}
            y={MARGEN_SUP}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerEnter={elegirPorPuntero}
            onPointerMove={elegirPorPuntero}
            onPointerDown={elegirPorPuntero}
          />
        </svg>
      </div>
      <p className="pd-ritmo__lectura" aria-live="polite">
        {textoLectura}
      </p>
    </div>
  );
}
