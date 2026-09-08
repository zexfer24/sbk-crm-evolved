"use client";

import { useMemo } from "react";
import { useClock } from "@/lib/use-clock";
import { CRM_TIME_ZONE, currentDayRange } from "@/lib/time-zone";
import type { InboxDayScope } from "@/lib/types";

/**
 * El corte "habló hoy" de la bandeja (T1 del plan "Seis frentes del buzón",
 * 8/9/2026): la medianoche de HOY en `America/Caracas`, en ISO, o `null`
 * cuando el visor tiene el interruptor "Ver todo" activo (`scope === "all"`)
 * — en ese caso no hay nada que cortar.
 *
 * ÚNICA fuente del corte: el mismo string viaja a las consultas
 * (`FetchConversationsOptions.since`, `fetchInboxCounts`, `data.ts`) y al
 * filtro en memoria (`matchesDay`, `inbox-filters.ts`). Que las tres partes
 * calculen la medianoche cada una por su cuenta es justo lo que haría que un
 * chat entrara en la lista pero no en el conteo, o viceversa, si alguna
 * quedara un milisegundo desalineada con las otras.
 *
 * `useClock()` cuantiza al minuto (`src/lib/use-clock.ts`) para que este
 * hook se entere de que rodó el día sin que nadie recargue la página, pero
 * `currentDayRange` solo cambia de valor una vez cada 24 h: el `useMemo` de
 * acá abajo depende de `dayStartMs` —el instante de esa medianoche, no del
 * tick del reloj— así que el string que sale de este hook (y que otros
 * efectos usan como dependencia) se mantiene REFERENCIALMENTE estable
 * entre los 1.440 minutos de un mismo día y solo cambia dos veces por día:
 * una vez al rodar la medianoche, y una vez si el visor toca el
 * interruptor.
 */
export function useInboxDay(scope: InboxDayScope): string | null {
  const clock = useClock();
  // Cómputo barato (unos pocos `Intl.DateTimeFormat`, la misma técnica que ya
  // usa `business-hours.ts` en cada turno de la IA): recalcularlo en cada
  // render no pesa, lo que sí importa es que el string de abajo NO cambie de
  // referencia en cada uno de esos renders.
  const dayStartMs = currentDayRange(CRM_TIME_ZONE, new Date(clock)).from.getTime();

  return useMemo(() => {
    if (scope === "all") return null;
    return new Date(dayStartMs).toISOString();
  }, [scope, dayStartMs]);
}
