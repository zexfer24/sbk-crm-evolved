"use client";

import { useRef, type TouchEvent } from "react";

/**
 * Cuánto hay que mantener el dedo para que salga el menú. Medio segundo es
 * lo que usan Android e iOS: más corto lo dispara un desplazamiento que
 * arranca lento, más largo se siente roto.
 */
const LONG_PRESS_MS = 500;

/**
 * El equivalente al click derecho en un teléfono.
 *
 * Devuelve además `consumeClick`, porque una pulsación larga termina soltando
 * el dedo y soltar el dedo es un click: sin consultarlo, se abriría el menú y
 * detrás se dispararía la acción normal del elemento.
 */
export function useLongPress(onLongPress: (position: { x: number; y: number }) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);

  function cancel() {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  return {
    /** true si este click viene de una pulsación larga y hay que ignorarlo. */
    consumeClick() {
      if (!fired.current) return false;
      fired.current = false;
      return true;
    },
    handlers: {
      onTouchStart(event: TouchEvent) {
        const touch = event.touches[0];
        if (!touch) return;
        const { clientX: x, clientY: y } = touch;
        fired.current = false;
        cancel();
        timer.current = setTimeout(() => {
          fired.current = true;
          onLongPress({ x, y });
        }, LONG_PRESS_MS);
      },
      onTouchMove: cancel,
      onTouchEnd: cancel,
      onTouchCancel: cancel,
    },
  };
}
