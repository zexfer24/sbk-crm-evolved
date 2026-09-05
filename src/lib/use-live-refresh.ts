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

/**
 * Cuánto puede pasar sin un refresco real antes de que volver a la pestaña
 * fuerce uno igual, aunque no haya nada anotado como pendiente (F9,
 * 4/9/2026). Sin esto, una pestaña que se cae del realtime (wifi, reinicio
 * del proxy) y se queda oculta un rato largo no anotaba nada —el canal
 * simplemente dejó de escuchar, no hay evento que perderse— y al volver a
 * mirarla se quedaba con lo último que alcanzó a bajar hasta la próxima
 * pasada de fondo, hasta 5 minutos después. Dos minutos es menos que
 * `SAFETY_REFRESH_MS`: visitar la pestaña adelanta esa reparación en vez de
 * esperarla.
 */
export const STALE_AFTER_MS = 2 * 60 * 1000;

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

  /**
   * Cuándo corrió el último refresco de verdad (F9, 4/9/2026). Se fija en el
   * efecto de abajo, no acá arriba: `Date.now()` durante el render es una
   * llamada impura que puede repetirse en un re-render sin que nada haya
   * pasado de verdad (la regla `react-hooks/purity` lo marca). Arranca en
   * `null` y el primer efecto lo pone en el momento del montaje: los datos
   * iniciales ya vinieron al día del servidor, así que ocultar la pestaña y
   * volver enseguida no debe contar como "vieja" — solo importa el tiempo
   * SIN refrescar de ahí en adelante.
   */
  const lastRefreshAt = useRef<number | null>(null);
  useEffect(() => {
    if (lastRefreshAt.current === null) lastRefreshAt.current = Date.now();
  }, []);

  function runRefresh() {
    lastRefreshAt.current = Date.now();
    return refreshRef.current();
  }

  const scheduleRefresh = useDebouncedCallback(() => runRefresh(), debounceMs);

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
      runRefresh();
    }, safetyMs);

    return () => clearInterval(timer);
  }, [safetyMs]);

  useEffect(() => {
    function onVisibilityChange() {
      if (document.hidden) return;
      // Vuelve a la pestaña: refresca si quedó algo anotado, o si ya pasó
      // demasiado tiempo sin un refresco real — un canal que se cayó del
      // realtime mientras la pestaña estaba oculta no anota nada (no hay
      // evento que perderse, el canal simplemente no estaba escuchando), así
      // que sin este segundo motivo la vista se quedaba con datos viejos
      // hasta la pasada de fondo de `SAFETY_REFRESH_MS`.
      const staleForTooLong =
        lastRefreshAt.current === null || Date.now() - lastRefreshAt.current > STALE_AFTER_MS;
      if (!pendingWhileHidden.current && !staleForTooLong) return;
      pendingWhileHidden.current = false;
      // Directo y no por el agrupador: al volver a la pestaña se quiere la
      // vista al día ya, no tres cuartos de segundo después.
      runRefresh();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  return request;
}
