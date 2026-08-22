"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * Ancho real del elemento, en píxeles.
 *
 * Lo usan los gráficos para dibujarse a escala 1:1. Un SVG con `viewBox`
 * fijo estirado al ancho del panel escala TODO su contenido, márgenes
 * internos incluidos: con un viewBox de 640 en un panel de 1500 el margen
 * se multiplica por 2,4 y el eje termina desalineado del resto del texto.
 */
export function useElementWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => setWidth(element.clientWidth || fallback);
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fallback]);

  return [ref, width] as const;
}
