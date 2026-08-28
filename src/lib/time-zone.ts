/**
 * El CRM opera en una sola zona horaria: la del equipo que atiende. El
 * gráfico de 24 h agrupa por esa hora local, no por la del navegador de
 * quien mira, para que todos vean el mismo día.
 */
export const CRM_TIME_ZONE = process.env.NEXT_PUBLIC_CRM_TIME_ZONE ?? "America/Caracas";

/** Diferencia entre la zona indicada y UTC en ese instante, en milisegundos. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );

  return asIfUtc - instant.getTime();
}

/** Medianoche a medianoche del día en curso en la zona del equipo. */
export function currentDayRange(timeZone: string, now: Date = new Date()): { from: Date; to: Date } {
  const offset = offsetMs(now, timeZone);
  const shifted = new Date(now.getTime() + offset);
  const startOfDay = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  );

  const from = new Date(startOfDay - offset);
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * Fecha y hora del instante dado, escritas en la zona del equipo.
 *
 * Existe porque el proceso NO corre en esa zona. El contenedor arranca con
 * `TZ` vacía, o sea en UTC: a las ocho de la noche en Barinas, `new Date()`
 * dentro de la app ya dice medianoche del día siguiente. Cuatro horas de
 * diferencia cruzan los tres saludos —y en el borde también el día de la
 * semana— así que cualquier texto que hable de la hora tiene que pasar por
 * acá y no por el reloj del proceso.
 *
 * Se le pasa `timeZone` a Intl en lugar de arreglar `TZ` en la imagen a
 * propósito: la zona del negocio ya está configurada en este archivo, y una
 * variable del sistema operativo la duplicaría. Dos fuentes para el mismo
 * dato terminan discrepando el día que alguien cambia una sola.
 */
/**
 * Minuto del día en la zona del equipo: 0 es medianoche, 1439 las 11:59 pm.
 *
 * Es la misma hora que `formatCrmDateTime` escribe en palabras, pero en un
 * número con el que se puede comparar. Existe porque hay decisiones que se
 * toman con la hora y no se le pueden delegar al modelo — cuál de los tres
 * saludos puede salir, por ejemplo (ver greeting-window.ts).
 */
export function crmMinuteOfDay(instant: Date = new Date(), timeZone: string = CRM_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  // `hour12: false` devuelve "24" para la medianoche en algunos motores; el
  // resto de este archivo hace el mismo módulo por la misma razón.
  return (get("hour") % 24) * 60 + get("minute");
}

export function formatCrmDateTime(instant: Date = new Date(), timeZone: string = CRM_TIME_ZONE): string {
  return new Intl.DateTimeFormat("es-VE", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}
