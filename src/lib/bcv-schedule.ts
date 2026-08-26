// ---------------------------------------------------------------------------
// Cuándo hay que volver a preguntarle la tasa al BCV.
//
// El BCV no publica todos los días. El sábado publica la tasa que va a regir
// el lunes, y el domingo no publica nada. O sea que la tasa leída el sábado
// es la buena para sábado, domingo y lunes — hasta que el lunes el BCV
// publique una nueva, que puede ser igual o distinta.
//
// De ahí salen dos reglas: el domingo no se sale a la red (no hay nada nuevo
// que buscar), y el lunes sí se sale aunque ya haya una tasa del sábado,
// porque es el día en que puede cambiar.
// ---------------------------------------------------------------------------

/**
 * Venezuela es UTC-4 y no cambia de hora. Sin fijar la zona, `toISOString()`
 * adelanta el día a las 20:00 hora local: un sábado a las 21:00 el sistema
 * creería que ya es domingo y se saltaría la lectura del sábado.
 */
export const VENEZUELA_TIME_ZONE = "America/Caracas";

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

/** Día de la semana (0 = domingo) de una fecha ISO corta, sin pasar por la zona local. */
export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

const SUNDAY = 0;

function previousDay(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
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

/**
 * ¿Hay que volver a leer bcv.org.ve, o sirve todavía lo guardado?
 *
 * Se decide por la fecha de LECTURA, no por la de vigencia: un sábado la tasa
 * guardada ya rige para el lunes, y comparar contra esa fecha futura llevaría
 * a no refrescar nunca.
 *
 * @param today      fecha de hoy en Venezuela (YYYY-MM-DD)
 * @param fetchedOn  día en que se leyó la tasa guardada, o null si se
 *                   desconoce (fila vieja o sembrada por el seed)
 */
export function shouldRefetchBcv(today: string, fetchedOn: string | null): boolean {
  // Sin saber cuándo se leyó, no se puede confiar en ella.
  if (!fetchedOn) return true;

  // Ya se leyó hoy: no se vuelve a molestar al BCV.
  if (fetchedOn === today) return false;

  // Domingo: el BCV no publica. Lo leído el sábado es lo vigente y lo seguirá
  // siendo hasta el lunes, así que no hay a qué salir.
  if (weekdayOf(today) === SUNDAY && fetchedOn === previousDay(today)) return false;

  return true;
}
