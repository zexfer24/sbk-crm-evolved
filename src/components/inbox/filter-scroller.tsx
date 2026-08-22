"use client";

import { useRef, type ReactNode, type WheelEvent } from "react";

/**
 * Carril horizontal que se mueve con la rueda del ratón.
 *
 * Un ratón normal solo tiene rueda vertical, así que sobre una fila que
 * desborda a lo ancho el gesto natural no hace nada y la barra parece
 * atascada. Acá el desplazamiento vertical se traduce a horizontal.
 *
 * Solo se intercepta cuando de verdad hay algo a los lados y el gesto es
 * vertical: si el usuario ya está haciendo scroll horizontal (trackpad, rueda
 * inclinable) se deja pasar, y si la fila llegó a un extremo tampoco se
 * captura, para no secuestrar el scroll de la página.
 */
export function FilterScroller({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;

    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 0) return;

    // Gesto ya horizontal: el navegador lo maneja bien solo.
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

    const atStart = el.scrollLeft <= 0;
    const atEnd = el.scrollLeft >= overflow - 1;
    if ((event.deltaY < 0 && atStart) || (event.deltaY > 0 && atEnd)) return;

    event.preventDefault();
    el.scrollLeft += event.deltaY;
  }

  return (
    <div ref={ref} className={className} onWheel={handleWheel}>
      {children}
    </div>
  );
}
