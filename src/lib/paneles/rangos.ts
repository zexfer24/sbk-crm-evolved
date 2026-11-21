import { todayKey } from "@/lib/sales-day";
import { INICIO_PANELES, rangoDe, rangoPrevio, recortarAlPiso, type PeriodoId, type RangoPanel } from "./periodos";

/**
 * Los rangos que cada página de los paneles pide a la base (plan "Paneles",
 * 13/11/2026). Viven acá y no en `page.tsx` para probarlos con un reloj fijo y
 * porque las vistas finales (C4–C6) no deberían tener que tocar las páginas:
 * cada página lee de una vez TODO lo que su panel va a necesitar.
 *
 * Todo se corta en la medianoche de Caracas (la misma de la bandeja, vía
 * `periodos.ts`); Caracas no tiene horario de verano, así que restar días
 * enteros de 24 h desde esa medianoche cae siempre en otra medianoche.
 *
 * Desde el 21/11/2026 ningún rango arranca antes del piso `INICIO_PANELES`
 * (16/11/2026; ver `periodos.ts`). El piso es un parámetro con default y viaja
 * en el resultado (`piso`) para que las vistas sepan desde dónde hay datos;
 * `null` conserva el cálculo de calendario puro. `previo` es `null` cuando el
 * período anterior no cabe entero desde el piso.
 */

const DIA_MS = 24 * 60 * 60 * 1000;

function rango(desde: Date, hasta: Date, etiqueta: string, piso: Date | null): RangoPanel {
  return { desde: recortarAlPiso(desde, hasta, piso), hasta, etiqueta };
}

/** ¿El piso acorta este período? (su inicio de calendario cae antes de él). */
function seRecorta(periodo: PeriodoId, ahora: Date, piso: Date | null): boolean {
  return piso !== null && rangoDe(periodo, ahora, null).desde.getTime() < piso.getTime();
}

export interface RangosDelDashboard {
  periodo: RangoPanel;
  /** `null` si el período anterior comparable empieza antes del piso. */
  previo: RangoPanel | null;
  /** El piso de datos con el que se calcularon estos rangos (`null` = sin piso). */
  piso: Date | null;
  /** `true` si el período, sin piso, habría empezado antes de él (el recorte cambió el tramo). */
  periodoRecortado: boolean;
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

export function rangosDelDashboard(
  periodo: PeriodoId,
  ahora: Date = new Date(),
  piso: Date | null = INICIO_PANELES
): RangosDelDashboard {
  const hoy = rangoDe("hoy", ahora, piso);
  // La historia termina en la medianoche de hoy: se parte de la medianoche REAL
  // de hoy (no de `hoy.desde`, que puede estar recortado al piso).
  const medianocheHoy = rangoDe("hoy", ahora, null).desde;
  return {
    periodo: rangoDe(periodo, ahora, piso),
    previo: rangoPrevio(periodo, ahora, piso),
    piso,
    periodoRecortado: seRecorta(periodo, ahora, piso),
    hoy,
    historia: rango(new Date(medianocheHoy.getTime() - 40 * DIA_MS), medianocheHoy, "Últimos 40 días", piso),
    anio: rangoDe("anio", ahora, piso),
    hoyClave: todayKey(ahora),
  };
}

export interface RangosDeAnaliticas {
  periodo: RangoPanel;
  /** `null` si el período anterior comparable empieza antes del piso. */
  previo: RangoPanel | null;
  /** El piso de datos con el que se calcularon estos rangos (`null` = sin piso). */
  piso: Date | null;
  /** `true` si el período, sin piso, habría empezado antes de él (el recorte cambió el tramo). */
  periodoRecortado: boolean;
  anio: RangoPanel;
  /** Los últimos 40 días INCLUYENDO hoy: el calendario de rendimiento. */
  ultimos40: RangoPanel;
}

export function rangosDeAnaliticas(
  periodo: PeriodoId,
  ahora: Date = new Date(),
  piso: Date | null = INICIO_PANELES
): RangosDeAnaliticas {
  const medianocheHoy = rangoDe("hoy", ahora, null).desde;
  return {
    periodo: rangoDe(periodo, ahora, piso),
    previo: rangoPrevio(periodo, ahora, piso),
    piso,
    periodoRecortado: seRecorta(periodo, ahora, piso),
    anio: rangoDe("anio", ahora, piso),
    ultimos40: rango(new Date(medianocheHoy.getTime() - 39 * DIA_MS), ahora, "Últimos 40 días", piso),
  };
}
