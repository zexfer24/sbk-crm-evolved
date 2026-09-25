// ---------------------------------------------------------------------------
// Cuándo hay que volver a preguntarle la tasa al BCV.
//
// Hasta el 24/9/2026 la regla era por día calendario y por fin de semana
// (sábado se lee, domingo se reusa, lunes se relee). Se cayó ese día: la
// única lectura fue a las 07:08, ANTES de que el BCV publicara la tasa del
// 25 (que suele salir por la tarde); a las 23:53 el chip seguía mostrando
// 854,46 con 855,66 ya publicada, y la regla de "una vez por día" no tenía
// forma de saber que había una tasa más nueva esperando.
//
// La regla nueva es por HORARIO, contra un instante (`fetched_at`), no
// contra un día calendario (`fetched_on`): se decide "¿ya pasamos el último
// horario programado que todavía no vimos?". Un domingo cuesta un GET de
// más (el BCV no publica, así que la respuesta no cambia), pero se lee
// igual — más simple que mantener una excepción de fin de semana, y el
// costo es solo una llamada de red ociosa.
// ---------------------------------------------------------------------------

/**
 * Venezuela es UTC-4 y no cambia de hora. Sin fijar la zona, `toISOString()`
 * adelanta el día a las 20:00 hora local: un sábado a las 21:00 el sistema
 * creería que ya es domingo y se saltaría la lectura del sábado.
 */
export const VENEZUELA_TIME_ZONE = "America/Caracas";

/**
 * Horarios (hora de Venezuela) en que se vuelve a preguntar al BCV. El
 * operador puede cambiarlos. Las 18:00 existen porque el BCV suele publicar
 * por la tarde la tasa del día hábil siguiente; si algún día publica
 * después de las 18:00, la lectura de las 00:00 la trae antes de que rija.
 */
export const BCV_READ_HOURS = [0, 6, 12, 18] as const;

const DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: VENEZUELA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Fecha calendario en Venezuela, en formato ISO corto (YYYY-MM-DD). */
export function venezuelaDate(now: Date = new Date()): string {
  return DATE_FORMATTER.format(now);
}

/**
 * Cuántos días calendario separan dos fechas ISO cortas. Se usa para decir en
 * voz alta qué tan vieja es la tasa con la que se está cotizando.
 */
export function daysBetween(from: string, to: string): number {
  const start = new Date(`${from}T12:00:00Z`).getTime();
  const end = new Date(`${to}T12:00:00Z`).getTime();
  return Math.round((end - start) / 86_400_000);
}

const HOUR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: VENEZUELA_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

/** Hora del día (0-23) en Venezuela, sin pasar por la zona del proceso. */
function venezuelaHour(now: Date): number {
  return Number(HOUR_FORMATTER.format(now));
}

/**
 * El mayor horario programado (`BCV_READ_HOURS`) que ya haya llegado, en
 * hora de Venezuela, como instante UTC.
 *
 * Se arma con `Date.UTC(y, m - 1, d, h + 4)`: Venezuela es UTC-4 fijo (sin
 * horario de verano), así que sumarle 4 horas a la hora de Caracas da
 * directamente el instante UTC correspondiente, sin depender de la zona del
 * proceso (que en el contenedor corre en UTC).
 *
 * Si ninguno de los horarios de hoy llegó todavía (por ejemplo, son las
 * 03:00 VE y el primer horario es las 06:00), retrocede al último horario
 * del día anterior.
 */
export function lastScheduledRead(now: Date): Date {
  const isoDate = venezuelaDate(now);
  const [year, month, day] = isoDate.split("-").map(Number);
  const currentHour = venezuelaHour(now);

  const hoursTodayNotAfterNow = BCV_READ_HOURS.filter((hour) => hour <= currentHour);

  if (hoursTodayNotAfterNow.length > 0) {
    const hour = Math.max(...hoursTodayNotAfterNow);
    return new Date(Date.UTC(year, month - 1, day, hour + 4));
  }

  // Ninguno de los horarios de hoy llegó todavía: el vigente es el último
  // horario del día anterior (ej. 03:00 VE con horarios [0,6,12,18] → 00:00
  // del mismo día ya pasó, así que este caso no aplica ahí; pero con
  // horarios que no empiecen en 0, o a las 03:00 VE de un día cuyo primer
  // horario fuera, por ejemplo, 06:00, hay que retroceder al día anterior).
  const lastHourYesterday = Math.max(...BCV_READ_HOURS);
  const yesterday = new Date(Date.UTC(year, month - 1, day, lastHourYesterday + 4));
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return yesterday;
}

/**
 * ¿Hay que volver a leer bcv.org.ve, o sirve todavía lo guardado?
 *
 * Se decide contra el último HORARIO programado ya alcanzado, comparado
 * contra el instante en que se leyó por última vez — no contra un día
 * calendario. Así, si el BCV publica a las 18:00 la tasa del día hábil
 * siguiente, una lectura de las 12:30 queda vieja apenas se cumplen las
 * 18:00 del mismo día, sin esperar a que cambie la fecha.
 *
 * @param now           instante actual
 * @param lastFetchedAt instante en que se leyó la tasa guardada, o null si
 *                      se desconoce (fila vieja o sembrada por el seed)
 */
export function shouldRefetchBcv(now: Date, lastFetchedAt: Date | null): boolean {
  // Sin saber cuándo se leyó, no se puede confiar en ella.
  if (!lastFetchedAt) return true;

  return lastScheduledRead(now).getTime() > lastFetchedAt.getTime();
}
