"use client";

import { useCallback, useEffect, useRef } from "react";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";

/**
 * Ventana de agrupación para refrescos disparados por tiempo real. Un
 * cliente que manda varios mensajes seguidos, o varios agentes moviendo
 * conversaciones a la vez, no deben disparar un refetch completo por cada
 * evento.
 */
export const REALTIME_DEBOUNCE_MS = 750;

/**
 * Cada cuánto se rearma la vista entera aunque no haya pasado nada.
 *
 * Aplicar los cambios en memoria quitó la red que había: antes, cualquier
 * desincronización se corregía sola en el refetch siguiente. Si un campo se
 * queda sin mapear, sin esto la vista mostraría el valor viejo hasta que
 * alguien recargue. Cinco minutos devuelve esa reparación por muy poco: es
 * un refresco cada cinco minutos en vez de uno por cada evento.
 */
export const SAFETY_REFRESH_MS = 5 * 60 * 1000;

export interface UseLiveRefreshOptions {
  debounceMs?: number;
  /** null desactiva la pasada de fondo periódica. */
  safetyMs?: number | null;
}

/**
 * El régimen común de "mantener una vista al día con realtime" sin que las
 * peticiones crezcan con el número de eventos por el de pestañas abiertas:
 *
 * - Los pedidos se agrupan: varios eventos casi simultáneos son UN refetch.
 * - Con la pestaña oculta no se refresca nada — un asesor deja el CRM abierto
 *   todo el día en una pestaña de fondo, y ese trabajo constante que nadie
 *   mira le quita aire al que sí tiene el CRM delante. Mientras no se ve, se
 *   anota; al volver, una sola puesta al día.
 * - Una pasada de fondo espaciada repara cualquier deriva.
 *
 * Devuelve la función para pedir un refresco (la que se llama desde los
 * handlers de realtime). `refresh` puede cambiar de identidad entre renders:
 * se guarda la última versión y no se re-suscribe nada.
 */
export function useLiveRefresh(
  refresh: () => void | Promise<void>,
  { debounceMs = REALTIME_DEBOUNCE_MS, safetyMs = SAFETY_REFRESH_MS }: UseLiveRefreshOptions = {}
): () => void {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  const scheduleRefresh = useDebouncedCallback(() => refreshRef.current(), debounceMs);

  /** Quedó un cambio sin atender porque la pestaña no estaba a la vista. */
  const pendingWhileHidden = useRef(false);

  const request = useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) {
      pendingWhileHidden.current = true;
      return;
    }
    scheduleRefresh();
  }, [scheduleRefresh]);

  // Red de seguridad contra la deriva. No corre con la pestaña oculta: ahí ya
  // se anota el pendiente y se pone al día al volver.
  useEffect(() => {
    if (safetyMs === null) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refreshRef.current();
    }, safetyMs);

    return () => clearInterval(timer);
  }, [safetyMs]);

  useEffect(() => {
    function onVisibilityChange() {
      if (document.hidden || !pendingWhileHidden.current) return;
      pendingWhileHidden.current = false;
      // Directo y no por el agrupador: al volver a la pestaña se quiere la
      // vista al día ya, no tres cuartos de segundo después.
      refreshRef.current();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  return request;
}
