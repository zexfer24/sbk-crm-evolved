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
