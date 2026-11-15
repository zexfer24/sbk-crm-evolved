import { todayKey } from "@/lib/sales-day";
import { rangoDe, rangoPrevio, type PeriodoId, type RangoPanel } from "./periodos";

/**
 * Los rangos que cada página de los paneles pide a la base (plan "Paneles",
 * 13/11/2026). Viven acá y no en `page.tsx` para probarlos con un reloj fijo y
 * porque las vistas finales (C4–C6) no deberían tener que tocar las páginas:
 * cada página lee de una vez TODO lo que su panel va a necesitar.
 *
 * Todo se corta en la medianoche de Caracas (la misma de la bandeja, vía
 * `periodos.ts`); Caracas no tiene horario de verano, así que restar días
 * enteros de 24 h desde esa medianoche cae siempre en otra medianoche.
 */

const DIA_MS = 24 * 60 * 60 * 1000;

function rango(desde: Date, hasta: Date, etiqueta: string): RangoPanel {
  return { desde, hasta, etiqueta };
}

export interface RangosDelDashboard {
  periodo: RangoPanel;
  previo: RangoPanel;
  /** De la medianoche de hoy a ahora: granularidad por hora (avance del día). */
  hoy: RangoPanel;
  /**
   * Los 40 días ANTERIORES a hoy, sin hoy: su `perfil_horario` alimenta la
   * curva horaria de la proyección y su `serie`, la racha de metas cumplidas.
   */
  historia: RangoPanel;
  /** Del 1/1 a ahora: el tablero mensual. */
  anio: RangoPanel;
  /** `YYYY-MM-DD` de hoy en Caracas. */
  hoyClave: string;
}

export function rangosDelDashboard(periodo: PeriodoId, ahora: Date = new Date()): RangosDelDashboard {
  const hoy = rangoDe("hoy", ahora);
  return {
    periodo: rangoDe(periodo, ahora),
    previo: rangoPrevio(periodo, ahora),
    hoy,
    historia: rango(new Date(hoy.desde.getTime() - 40 * DIA_MS), hoy.desde, "Últimos 40 días"),
    anio: rangoDe("anio", ahora),
    hoyClave: todayKey(ahora),
  };
}

export interface RangosDeAnaliticas {
  periodo: RangoPanel;
  previo: RangoPanel;
  anio: RangoPanel;
  /** Los últimos 40 días INCLUYENDO hoy: el calendario de rendimiento. */
  ultimos40: RangoPanel;
}

export function rangosDeAnaliticas(periodo: PeriodoId, ahora: Date = new Date()): RangosDeAnaliticas {
  const hoy = rangoDe("hoy", ahora);
  return {
    periodo: rangoDe(periodo, ahora),
    previo: rangoPrevio(periodo, ahora),
    anio: rangoDe("anio", ahora),
    ultimos40: rango(new Date(hoy.desde.getTime() - 39 * DIA_MS), ahora, "Últimos 40 días"),
  };
}
