"use client";

import { useSyncExternalStore } from "react";

const TICK_MS = 60_000;

/**
 * Reloj compartido para los contadores de espera del dashboard.
 *
 * El valor se cuantiza al minuto: así el HTML que genera el servidor y el
 * primer render del navegador coinciden al hidratar, y aun así "hace 3 h"
 * sigue avanzando solo sin que nadie recargue la página.
 */
function currentMinute(): number {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

let snapshot = currentMinute();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  snapshot = currentMinute();

  if (timer === null) {
    timer = setInterval(() => {
      snapshot = currentMinute();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return snapshot;
}

/**
 * En servidor hay que leer la hora en cada render, no la del arranque del
 * proceso: si no, un servidor que lleva horas vivo pinta duraciones viejas
 * y la hidratación falla al no coincidir con lo que calcula el navegador.
 */
function getServerSnapshot(): number {
  return currentMinute();
}

export function useClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
