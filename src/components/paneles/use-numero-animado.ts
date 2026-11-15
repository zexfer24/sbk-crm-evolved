"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Cifra que sube o baja hasta su valor nuevo (plan "Paneles", 13/11/2026).
 *
 * Interpola con `requestAnimationFrame` desde el ÚLTIMO valor mostrado —no
 * desde el anterior pedido— hasta el nuevo en ~0,9 s con ease out: si el
 * período cambia a mitad de una animación, la cifra sigue desde donde iba en
 * vez de saltar de vuelta. Al MONTAR no cuenta desde cero: el primer valor se
 * pinta tal cual (el servidor ya lo mandó escrito, y un conteo al cargar
 * esconde el dato justo cuando el supervisor lo busca).
 *
 * Con `prefers-reduced-motion: reduce`, o en el servidor, devuelve el valor
 * final directo. En el servidor el snapshot es "reducido" a propósito: así el
 * HTML inicial y la hidratación coinciden y no hay nada que animar sin
 * navegador.
 */

const CONSULTA_MOVIMIENTO_REDUCIDO = "(prefers-reduced-motion: reduce)";

function suscribirse(avisar: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const consulta = window.matchMedia(CONSULTA_MOVIMIENTO_REDUCIDO);
  consulta.addEventListener?.("change", avisar);
  return () => consulta.removeEventListener?.("change", avisar);
}

function movimientoReducidoAhora(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(CONSULTA_MOVIMIENTO_REDUCIDO).matches;
}

const movimientoReducidoEnServidor = () => true;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export interface OpcionesNumeroAnimado {
  /** Duración de la interpolación. Por defecto 900 ms. */
  duracionMs?: number;
}

export function useNumeroAnimado(valor: number, opciones: OpcionesNumeroAnimado = {}): number {
  const duracionMs = opciones.duracionMs ?? 900;
  const reducido = useSyncExternalStore(suscribirse, movimientoReducidoAhora, movimientoReducidoEnServidor);
  const [mostrado, setMostrado] = useState(valor);
  // Último valor que se PINTÓ (no el último pedido): desde ahí arranca la
  // próxima animación.
  const ultimo = useRef(valor);

  useEffect(() => {
    if (reducido) {
      ultimo.current = valor;
      // Por rAF y no directo: un setState síncrono en el efecto dispara
      // `react-hooks/set-state-in-effect`, y además así, si el visor apaga la
      // preferencia a mitad de sesión, `mostrado` no queda con un valor viejo.
      const id = requestAnimationFrame(() => setMostrado(valor));
      return () => cancelAnimationFrame(id);
    }

    const desde = ultimo.current;
    if (desde === valor) return;

    const inicio = performance.now();
    let id = 0;
    const paso = () => {
      const t = Math.min(1, (performance.now() - inicio) / duracionMs);
      const actual = t >= 1 ? valor : desde + (valor - desde) * easeOutCubic(t);
      ultimo.current = actual;
      setMostrado(actual);
      if (t < 1) id = requestAnimationFrame(paso);
    };
    id = requestAnimationFrame(paso);
    return () => cancelAnimationFrame(id);
  }, [valor, reducido, duracionMs]);

  return reducido ? valor : mostrado;
}
