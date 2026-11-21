"use client";

import { useCallback, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Refresco automático de los paneles (plan "Los paneles cuentan desde el lunes
 * 16/11/2026 y se refrescan solos", T5, 21/11/2026).
 *
 * Hasta esa fecha cada `page.tsx` de /panel leía todo en el servidor UNA vez y
 * quedaba como foto fija desde que se abría la pestaña: el access log de
 * Traefik del 21/11 mostró las RPC `panel_*` solo en navegaciones completas,
 * nunca en segundo plano, y `router.refresh()` solo se usaba en «Reintentar»
 * y al guardar una meta. Un supervisor que dejaba el panel abierto miraba
 * cifras de hace horas sin saberlo.
 *
 * Ahora cada refresco es `startTransition(() => router.refresh())`: el servidor
 * vuelve a leer la página (con el `ahora` nuevo, que la cabecera pinta como
 * «Actualizado a las …») sin recargar la pestaña ni perder el estado del
 * cliente. Costo medido de un refresco: 0,2–1,2 s de RPC por panel; con 1–3
 * personas mirando, 60 s es seguro.
 *
 * - Solo corre con la pestaña visible (mismo patrón que `use-reloj.ts`): un
 *   panel que nadie mira no justifica pedirle nada a la base.
 * - Al volver a la pestaña se pone al día si pasaron más de
 *   `REFRESCO_AL_VOLVER_MS` desde el último refresco, y el intervalo
 *   rearranca desde ese momento.
 * - Si un refresco todavía está en curso, el tick se salta: los renders no se
 *   apilan aunque el servidor tarde más que el intervalo.
 *
 * `staleTimes.dynamic = 30` de `next.config.ts` deja de importar para esto:
 * `router.refresh()` siempre pide al servidor, no consulta el caché de
 * navegación del router.
 */

export const INTERVALO_REFRESCO_MS = 60_000;
export const REFRESCO_AL_VOLVER_MS = 30_000;

export function useRefrescoDelPanel(intervaloMs: number = INTERVALO_REFRESCO_MS): {
  /** Refresco a mano, inmediato (salvo que ya haya uno en curso). */
  refrescar: () => void;
  /** `true` mientras la transición del refresco está pendiente. */
  refrescando: boolean;
} {
  const router = useRouter();
  const [refrescando, startTransition] = useTransition();

  // Refs que espejan el último render: el callback del intervalo vive muchos
  // renders y no puede leer variables cerradas (`refrescando` quedaría viejo,
  // y `router` cambia de identidad en algunos entornos).
  const routerRef = useRef(router);
  const enCursoRef = useRef(false);
  const ultimoRefrescoRef = useRef(0);

  useEffect(() => {
    routerRef.current = router;
    enCursoRef.current = refrescando;
  });

  const refrescar = useCallback(() => {
    if (enCursoRef.current) return;
    ultimoRefrescoRef.current = Date.now();
    startTransition(() => routerRef.current.refresh());
  }, [startTransition]);

  useEffect(() => {
    ultimoRefrescoRef.current = Date.now();

    let id: ReturnType<typeof setInterval> | null = null;
    const arrancar = () => {
      if (id === null) id = setInterval(refrescar, intervaloMs);
    };
    const parar = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const alCambiarVisibilidad = () => {
      if (document.hidden) {
        parar();
        return;
      }
      if (Date.now() - ultimoRefrescoRef.current > REFRESCO_AL_VOLVER_MS) refrescar();
      // Siempre rearranca: el próximo tick llega `intervaloMs` después de volver.
      parar();
      arrancar();
    };

    if (!document.hidden) arrancar();
    document.addEventListener("visibilitychange", alCambiarVisibilidad);
    return () => {
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
      parar();
    };
  }, [intervaloMs, refrescar]);

  return { refrescar, refrescando };
}
