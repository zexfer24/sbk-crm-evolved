"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Ancho inicial de un gráfico antes de medir (servidor, primer render, jsdom,
 * donde no hay layout ni `ResizeObserver`). Es el ancho con el que los gráficos
 * nacieron en el plan "Paneles" (13/11/2026).
 */
export const ANCHO_INICIAL_GRAFICO = 600;

/** Ancho mínimo con el que se dibuja: un contenedor oculto (0 px) no puede dar un viewBox degenerado. */
const ANCHO_MINIMO_GRAFICO = 120;

/**
 * Mide el ancho en píxeles de un contenedor y lo mantiene al día (15/11/2026).
 *
 * Por qué existe: los gráficos dibujaban sobre un `viewBox` fijo de 600 px que
 * el navegador estiraba al ancho del contenedor, y el texto de los ejes
 * escalaba con él: medido con Playwright, 30 px de alto a 1440 px y 8 px a
 * 390 px (la interfaz usa 11). Con un `viewBox` del mismo ancho que el
 * contenedor, 1 unidad del SVG = 1 px de pantalla y texto y trazos conservan
 * su tamaño.
 *
 * La medida llega por el callback del `ResizeObserver` (que dispara también al
 * empezar a observar), nunca con un `setState` síncrono dentro del efecto.
 * Sin `ResizeObserver` se queda en `ANCHO_INICIAL_GRAFICO`.
 */
export function useAnchoMedido(): { ref: RefObject<HTMLDivElement | null>; ancho: number } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [ancho, setAncho] = useState(ANCHO_INICIAL_GRAFICO);

  useEffect(() => {
    const elemento = ref.current;
    if (!elemento || typeof ResizeObserver === "undefined") return;
    const observador = new ResizeObserver((entradas) => {
      const medido = entradas[entradas.length - 1]?.contentRect?.width;
      if (typeof medido !== "number" || !Number.isFinite(medido)) return;
      setAncho(Math.max(ANCHO_MINIMO_GRAFICO, Math.round(medido)));
    });
    observador.observe(elemento);
    return () => observador.disconnect();
  }, []);

  return { ref, ancho };
}
