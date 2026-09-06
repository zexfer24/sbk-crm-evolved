import { CRM_TIME_ZONE, crmMinuteOfDay, crmWeekday, currentDayRange } from "@/lib/time-zone";

// ---------------------------------------------------------------------------
// El horario de atención vive en `agent_settings.business_hours` (migración
// 20260906010000, "B1") como un jsonb con la forma de abajo. Este módulo es
// la única fuente de verdad sobre qué hace ese jsonb: validarlo, decir si la
// tienda está abierta ahora, y escribir en prosa la línea que el turno de IA
// recibe en TURNO ACTUAL en vez de deducir la hora del texto (5/9/2026,
// "El reloj dice la verdad").
//
// Puro a propósito: sin React, sin Supabase. Lo llama tanto el turno de IA
// (server) como el panel de control (cliente) y el tablero de "atascados".
// ---------------------------------------------------------------------------

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type TimeRange = [string, string];
export type BusinessHours = Record<DayKey, TimeRange[]>;

/** Orden natural de la semana, de lunes a domingo — el que usa la prosa. */
const DAY_KEYS: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** `crmWeekday` devuelve 0 = domingo; este arreglo traduce ese índice a la clave del jsonb. */
const DAY_KEY_BY_WEEKDAY: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const DAY_NAMES: Record<DayKey, string> = {
  mon: "lunes",
  tue: "martes",
  wed: "miércoles",
  thu: "jueves",
  fri: "viernes",
  sat: "sábado",
  sun: "domingo",
};

/** Igual al default de la migración B1: lunes a viernes 8 am a 6 pm, fin de semana cerrado. */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  mon: [["08:00", "18:00"]],
  tue: [["08:00", "18:00"]],
  wed: [["08:00", "18:00"]],
  thu: [["08:00", "18:00"]],
  fri: [["08:00", "18:00"]],
  sat: [],
  sun: [],
};

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isValidRange(range: unknown): range is TimeRange {
  if (!Array.isArray(range) || range.length !== 2) return false;
  const [inicio, fin] = range;
  if (typeof inicio !== "string" || typeof fin !== "string") return false;
  if (!HHMM_RE.test(inicio) || !HHMM_RE.test(fin)) return false;
  return hhmmToMinutes(inicio) < hhmmToMinutes(fin);
}

/**
 * Valida la forma del jsonb que guarda `agent_settings.business_hours`.
 *
 * Nunca lanza: lo llama un turno de IA, y una fila rota en la base no puede
 * tumbar la respuesta al cliente. Ante cualquier cosa que no calce del todo
 * —falta un día, una franja no es `[string, string]`, una hora no es
 * `HH:MM`, o el fin no es estrictamente posterior al inicio— se devuelve el
 * horario por defecto completo, nunca una mezcla parcial: una fila a medio
 * romper es tan inválida como una vacía.
 */
export function parseBusinessHours(raw: unknown): BusinessHours {
  if (typeof raw !== "object" || raw === null) return DEFAULT_BUSINESS_HOURS;

  const objeto = raw as Record<string, unknown>;
  const resultado = {} as BusinessHours;

  for (const dia of DAY_KEYS) {
    const franjas = objeto[dia];
    if (!Array.isArray(franjas) || !franjas.every(isValidRange)) {
      return DEFAULT_BUSINESS_HOURS;
    }
    resultado[dia] = franjas as TimeRange[];
  }

  return resultado;
}

// ---------------------------------------------------------------------------
// Franja del día (mañana / tarde / noche), con los MISMOS bordes que traía
// `greeting-window.ts` antes del 5/9/2026: la fuente pasa a ser este módulo
// y `greeting-window.ts` importa de acá para no tener dos copias del mismo
// número que un día se desincronicen.
// ---------------------------------------------------------------------------

export type DayBand = "mañana" | "tarde" | "noche";

export interface BandWindow {
  from: number;
  to: number;
}

/**
 * Bordes en minutos desde medianoche, escritos como datos (no como
 * condicionales) para que mover uno solo — por ejemplo la noche de 19:01 a
 * 19:00 — rompa un test de `dayBand` sin tocar ninguna otra línea de código.
 */
export const DAY_BANDS: Record<DayBand, BandWindow> = {
  "mañana": { from: 0, to: 11 * 60 + 59 },
  tarde: { from: 12 * 60, to: 19 * 60 },
  noche: { from: 19 * 60 + 1, to: 23 * 60 + 59 },
};

/** Franja del día en la que cae `now`, según los bordes de `DAY_BANDS`. */
export function dayBand(now: Date = new Date(), timeZone: string = CRM_TIME_ZONE): DayBand {
  const minuto = crmMinuteOfDay(now, timeZone);

  if (minuto >= DAY_BANDS["mañana"].from && minuto <= DAY_BANDS["mañana"].to) return "mañana";
  if (minuto >= DAY_BANDS.tarde.from && minuto <= DAY_BANDS.tarde.to) return "tarde";
  return "noche";
}

export function greetingFor(band: DayBand): string {
  switch (band) {
    case "mañana":
      return "buenos días";
    case "tarde":
      return "buenas tardes";
    case "noche":
      return "buenas noches";
  }
}

// ---------------------------------------------------------------------------
// Prosa: horas en formato "6:00 pm", días agrupados ("lunes a viernes") y el
// estado abierta/cerrada con la próxima apertura.
// ---------------------------------------------------------------------------

function minuteTo12Hour(minuto: number): string {
  const h = Math.floor(minuto / 60);
  const m = minuto % 60;
  const periodo = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${periodo}`;
}

function formatHHMM(hhmm: string): string {
  return minuteTo12Hour(hhmmToMinutes(hhmm));
}

function isNextInWeekOrder(previo: DayKey, actual: DayKey): boolean {
  return DAY_KEYS.indexOf(actual) === DAY_KEYS.indexOf(previo) + 1;
}

/**
 * El horario en prosa, agrupando días contiguos (en orden lunes→domingo) que
 * comparten exactamente las mismas franjas — hace falta para el horario
 * partido, donde dos días pueden tener franjas distintas aunque ambos estén
 * "abiertos". Los días cerrados (franja vacía) no se mencionan: el default
 * sale "lunes a viernes de 8:00 am a 6:00 pm", sin nombrar el fin de semana.
 */
export function describeSchedule(hours: BusinessHours): string {
  const grupos: { dias: DayKey[]; franjas: TimeRange[] }[] = [];

  for (const dia of DAY_KEYS) {
    const franjas = hours[dia];
    if (franjas.length === 0) continue;

    const clave = JSON.stringify(franjas);
    const ultimo = grupos[grupos.length - 1];
    const mismasFranjas = ultimo && JSON.stringify(ultimo.franjas) === clave;
    const esContiguo = ultimo && isNextInWeekOrder(ultimo.dias[ultimo.dias.length - 1], dia);

    if (ultimo && mismasFranjas && esContiguo) {
      ultimo.dias.push(dia);
    } else {
      grupos.push({ dias: [dia], franjas });
    }
  }

  if (grupos.length === 0) return "cerrado todos los días";

  return grupos
    .map(({ dias, franjas }) => {
      const rangoDias =
        dias.length === 1 ? DAY_NAMES[dias[0]] : `${DAY_NAMES[dias[0]]} a ${DAY_NAMES[dias[dias.length - 1]]}`;
      const rangoHoras = franjas.map(([inicio, fin]) => `${formatHHMM(inicio)} a ${formatHHMM(fin)}`).join(" y ");
      return `${rangoDias} de ${rangoHoras}`;
    })
    .join(", ");
}

export interface BusinessStatus {
  open: boolean;
  closesAt: string | null;
  /**
   * `dayLabel` es "hoy" si la próxima apertura cae en el mismo día local que
   * `now`, o el nombre del día con artículo ("el lunes", "el martes"...) para
   * cualquier otro caso — INCLUIDO el día calendario siguiente.
   *
   * No existe una etiqueta "mañana" a propósito (decisión del 5/9/2026):
   * `turnClockLine` ya usa "mañana" para nombrar la FRANJA del día ("franja:
   * mañana"), y una línea como "franja: mañana … abre mañana a las 8:00 am"
   * dice "mañana" dos veces con dos significados distintos (franja horaria
   * vs. día siguiente) en el mismo renglón — confundía al modelo. Decir
   * siempre el nombre del día ("abre el lunes a las 8:00 am") es inequívoco
   * sea hoy, mañana o dentro de una semana.
   */
  nextOpening: { dayLabel: string; time: string } | null;
}

/**
 * Si la tienda está abierta ahora mismo y, si no lo está, cuándo abre.
 *
 * `nextOpening` es null solo cuando no hay ninguna franja en los próximos
 * siete días — es decir, el horario completo está cerrado los siete días.
 */
export function businessStatus(
  now: Date = new Date(),
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS,
  timeZone: string = CRM_TIME_ZONE
): BusinessStatus {
  const minuto = crmMinuteOfDay(now, timeZone);
  const weekday = crmWeekday(now, timeZone);
  const hoyKey = DAY_KEY_BY_WEEKDAY[weekday];

  const franjaActiva = hours[hoyKey].find(
    ([inicio, fin]) => minuto >= hhmmToMinutes(inicio) && minuto <= hhmmToMinutes(fin)
  );

  if (franjaActiva) {
    return { open: true, closesAt: formatHHMM(franjaActiva[1]), nextOpening: null };
  }

  for (let offset = 0; offset <= 6; offset++) {
    const dow = (weekday + offset) % 7;
    const key = DAY_KEY_BY_WEEKDAY[dow];
    const candidatos = hours[key]
      .map(([inicio]) => inicio)
      .filter((inicio) => offset > 0 || hhmmToMinutes(inicio) > minuto);

    if (candidatos.length === 0) continue;

    const inicio = candidatos.reduce((min, actual) => (hhmmToMinutes(actual) < hhmmToMinutes(min) ? actual : min));
    // Sin etiqueta "mañana" para el día siguiente: ver el comentario de
    // `BusinessStatus.nextOpening` (5/9/2026) sobre por qué esa palabra
    // confunde al modelo cuando la línea también nombra la franja "mañana".
    const dayLabel = offset === 0 ? "hoy" : `el ${DAY_NAMES[key]}`;

    return { open: false, closesAt: null, nextOpening: { dayLabel, time: formatHHMM(inicio) } };
  }

  return { open: false, closesAt: null, nextOpening: null };
}

/** Fecha larga en español, en la zona del equipo: "viernes 5 de septiembre". */
function fechaLarga(now: Date, timeZone: string): string {
  const partes = new Intl.DateTimeFormat("es-VE", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes) => partes.find((parte) => parte.type === type)?.value ?? "";

  return `${get("weekday")} ${get("day")} de ${get("month")}`;
}

/**
 * La línea que va en el bloque `TURNO ACTUAL` del prompt: hora, franja,
 * saludo, horario de atención y si la tienda está abierta ahora mismo.
 *
 * Reemplaza el texto "Fecha y hora local: …" que obligaba al modelo a leer
 * "4:45 p. m." y deducir "tarde" solo — a veces mal. Acá la franja y el
 * horario ya vienen calculados; el modelo solo los copia (B3, 5/9/2026).
 */
export function turnClockLine(
  now: Date = new Date(),
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS,
  timeZone: string = CRM_TIME_ZONE
): string {
  const franja = dayBand(now, timeZone);
  const saludo = greetingFor(franja);
  const hora = minuteTo12Hour(crmMinuteOfDay(now, timeZone));
  const fecha = fechaLarga(now, timeZone);
  const horario = describeSchedule(hours);
  const estado = businessStatus(now, hours, timeZone);

  const lineaEstado = estado.open
    ? `ABIERTA, cierra a las ${estado.closesAt}`
    : estado.nextOpening
      ? `CERRADA, abre ${estado.nextOpening.dayLabel} a las ${estado.nextOpening.time}`
      : "CERRADA";

  return (
    `Hora local: ${fecha}, ${hora} — franja: ${franja} (saluda "${saludo}"). ` +
    `Horario de atención: ${horario}. ` +
    `Ahora mismo: ${lineaEstado}.`
  );
}

/**
 * Minutos de horario laboral entre dos instantes — 0 si `to` no es posterior
 * a `from`. Itera día a día en la zona del equipo (rangos de días, no de
 * años: no hace falta optimizar) sumando la parte de cada franja que cae
 * dentro de la ventana pedida.
 *
 * Existe para medir el atasco de "Con asesor" (Frente A): de noche o un
 * domingo un asesor no está atascado, y contar minutos de pared lo disfrazaba
 * de atendido.
 */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  hours: BusinessHours,
  timeZone: string = CRM_TIME_ZONE
): number {
  if (to.getTime() <= from.getTime()) return 0;

  let totalMs = 0;
  let cursorDia = currentDayRange(timeZone, from).from;

  while (cursorDia.getTime() < to.getTime()) {
    const weekday = crmWeekday(cursorDia, timeZone);
    const key = DAY_KEY_BY_WEEKDAY[weekday];

    for (const [inicio, fin] of hours[key]) {
      const inicioFranja = new Date(cursorDia.getTime() + hhmmToMinutes(inicio) * 60_000);
      const finFranja = new Date(cursorDia.getTime() + hhmmToMinutes(fin) * 60_000);

      const solapaInicio = Math.max(inicioFranja.getTime(), from.getTime());
      const solapaFin = Math.min(finFranja.getTime(), to.getTime());

      if (solapaFin > solapaInicio) {
        totalMs += solapaFin - solapaInicio;
      }
    }

    cursorDia = new Date(cursorDia.getTime() + 24 * 60 * 60 * 1000);
  }

  return Math.round(totalMs / 60_000);
}
