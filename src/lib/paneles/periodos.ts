import { shiftDayKey, todayKey } from "@/lib/sales-day";
import { CRM_TIME_ZONE, currentDayRange } from "@/lib/time-zone";

/**
 * Períodos de los paneles (Dashboard, Analíticas, Asesores), plan "Paneles"
 * del 13/11/2026. Todo se corta en hora de Caracas con las mismas piezas que
 * ya usa la bandeja (`currentDayRange`, `todayKey`, `shiftDayKey`): la
 * medianoche del negocio tiene UNA sola fuente (trampa "habló hoy" de
 * CLAUDE.md), y recalcularla acá desalinearía los paneles de la bandeja.
 *
 * Puro a propósito: sin React ni Supabase, y siempre recibe `ahora` para que
 * los tests nunca dependan del reloj real.
 */

export type PeriodoId = "hoy" | "7d" | "30d" | "mes" | "anio";

export const PERIODOS: { id: PeriodoId; etiqueta: string }[] = [
  { id: "hoy", etiqueta: "Hoy" },
  { id: "7d", etiqueta: "7 días" },
  { id: "30d", etiqueta: "30 días" },
  { id: "mes", etiqueta: "Este mes" },
  { id: "anio", etiqueta: "Este año" },
];

export interface RangoPanel {
  desde: Date;
  hasta: Date;
  etiqueta: string;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Instante de la medianoche de Caracas del día `YYYY-MM-DD`. Se pide el rango
 * del mediodía UTC de esa fecha: en cualquier zona del mundo ese instante cae
 * dentro del mismo día calendario, así que `currentDayRange` devuelve la
 * medianoche correcta sin armar offsets a mano.
 */
function inicioDeDia(key: string): Date {
  const [anio, mes, dia] = key.split("-").map(Number);
  return currentDayRange(CRM_TIME_ZONE, new Date(Date.UTC(anio, mes - 1, dia, 12))).from;
}

function claveMes(anio: number, mes: number): string {
  return `${anio}-${String(mes).padStart(2, "0")}-01`;
}

function partesDeHoy(ahora: Date): { anio: number; mes: number; dia: number } {
  const [anio, mes, dia] = todayKey(ahora).split("-").map(Number);
  return { anio, mes, dia };
}

function etiquetaDe(id: PeriodoId): string {
  return PERIODOS.find((p) => p.id === id)?.etiqueta ?? id;
}

function desdeDe(id: PeriodoId, ahora: Date): Date {
  const hoy = todayKey(ahora);
  const { anio, mes } = partesDeHoy(ahora);
  switch (id) {
    case "hoy":
      return inicioDeDia(hoy);
    case "7d":
      return inicioDeDia(shiftDayKey(hoy, -6));
    case "30d":
      return inicioDeDia(shiftDayKey(hoy, -29));
    case "mes":
      return inicioDeDia(claveMes(anio, mes));
    case "anio":
      return inicioDeDia(`${anio}-01-01`);
  }
}

/** La ventana del período, en hora de Caracas: desde su inicio hasta `ahora`. */
export function rangoDe(id: PeriodoId, ahora: Date = new Date()): RangoPanel {
  return { desde: desdeDe(id, ahora), hasta: ahora, etiqueta: etiquetaDe(id) };
}

const ETIQUETAS_PREVIAS: Record<PeriodoId, string> = {
  hoy: "Mismo día de la semana pasada",
  "7d": "7 días anteriores",
  "30d": "30 días anteriores",
  mes: "Mes anterior",
  anio: "Año anterior",
};

/**
 * La ventana equivalente anterior, para comparar "mismo tramo contra mismo
 * tramo" y nunca un día parcial contra uno completo.
 *
 * - hoy / 7d / 30d: la misma ventana corrida 7 / 7 / 30 días hacia atrás
 *   (hoy compara contra el mismo día de la semana pasada hasta la misma hora).
 * - mes / anio: desde el inicio del mes/año anterior, con la misma duración
 *   transcurrida; si el período anterior es más corto (31 de marzo contra
 *   febrero) el tope es el inicio del período actual, nunca un traslape.
 */
export function rangoPrevio(id: PeriodoId, ahora: Date = new Date()): RangoPanel {
  const actual = rangoDe(id, ahora);
  const etiqueta = ETIQUETAS_PREVIAS[id];

  if (id === "hoy" || id === "7d") {
    return {
      desde: new Date(actual.desde.getTime() - 7 * DIA_MS),
      hasta: new Date(actual.hasta.getTime() - 7 * DIA_MS),
      etiqueta,
    };
  }
  if (id === "30d") {
    return {
      desde: new Date(actual.desde.getTime() - 30 * DIA_MS),
      hasta: new Date(actual.hasta.getTime() - 30 * DIA_MS),
      etiqueta,
    };
  }

  const { anio, mes } = partesDeHoy(ahora);
  const claveAnterior = id === "mes" ? (mes === 1 ? claveMes(anio - 1, 12) : claveMes(anio, mes - 1)) : `${anio - 1}-01-01`;
  const desde = inicioDeDia(claveAnterior);
  const transcurrido = actual.hasta.getTime() - actual.desde.getTime();
  const hasta = new Date(Math.min(desde.getTime() + transcurrido, actual.desde.getTime()));
  return { desde, hasta, etiqueta };
}

/**
 * Las RPC que leen `messages` (`panel_conversaciones`, `panel_asesores`)
 * rechazan rangos de más de 92 días con `22023`. Esto recorta el inicio a
 * `hasta − maxDias` ANTES de llamarlas y dice si recortó, para que la pantalla
 * avise "mostrando los últimos 92 días" en vez de mostrar un error.
 */
export function topeMensajes(
  rango: { desde: Date; hasta: Date },
  maxDias = 92
): { desde: Date; hasta: Date; recortado: boolean } {
  const minimo = rango.hasta.getTime() - maxDias * DIA_MS;
  if (rango.desde.getTime() >= minimo) {
    return { desde: rango.desde, hasta: rango.hasta, recortado: false };
  }
  return { desde: new Date(minimo), hasta: rango.hasta, recortado: true };
}

/** El período que viene en `?periodo=`; cualquier valor desconocido es "hoy". */
export function periodoDesdeParam(valor: string | undefined): PeriodoId {
  return PERIODOS.find((p) => p.id === valor)?.id ?? "hoy";
}
