"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Agrupa llamadas rápidas seguidas en una sola ejecución del callback,
 * `delayMs` después de la última. Pensado para refrescos disparados por
 * eventos en tiempo real (varios INSERT casi simultáneos no deben disparar
 * un refetch completo cada uno).
 */
export function useDebouncedCallback(callback: () => void, delayMs: number): () => void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      callbackRef.current();
    }, delayMs);
  }, [delayMs]);
}
