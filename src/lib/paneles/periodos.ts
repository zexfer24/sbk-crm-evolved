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
 * Medianoche de Caracas del lunes 16/11/2026 (`2026-11-16T00:00:00-04:00`): el
 * primer instante con datos que los paneles aceptan contar. Atado por test a
 * `public.paneles_inicio()` (`paneles-inicio-paridad.test.ts`).
 *
 * Historia: el 16/11/2026 a las 16:55 UTC se hizo un backfill de 205 fotos
 * `estimado = true` en `ventas_saint`, todas valuadas al precio de ESE día; las
 * ventas reales empiezan el 16/11. Con «7 días» el panel comparaba reales
 * contra estimados, y «Este mes», «30 días» y «Este año» comparaban contra $0.
 * Decisión D4 del operador (21/11/2026): un piso fijo, sin tabla ni
 * configuración; ningún período ni historia lee antes de él.
 */
export const INICIO_PANELES = new Date("2026-11-16T04:00:00Z");
export const TEXTO_INICIO_PANELES = "Los paneles cuentan desde el lunes 16/11/2026";
export const TEXTO_SIN_PREVIO = "Sin período anterior comparable (los datos empiezan el 16/11)";

/** «16/11» para un instante, en hora de Caracas (el día del piso en los avisos). */
export function etiquetaDiaMes(instante: Date): string {
  const [, mes, dia] = todayKey(instante).split("-");
  return `${dia}/${mes}`;
}

/** Un rango sin tramo (`hasta <= desde`): el período entero cae antes del piso. */
export function esRangoVacio(r: { desde: Date; hasta: Date }): boolean {
  return r.hasta.getTime() <= r.desde.getTime();
}

/**
 * Recorta `desde` al piso. Si eso deja un tramo vacío (el instante `hasta` no
 * llega al piso), el rango queda bien formado con `desde = hasta`.
 */
export function recortarAlPiso(desde: Date, hasta: Date, piso: Date | null): Date {
  if (piso === null) return desde;
  const recortado = desde.getTime() < piso.getTime() ? piso : desde;
  return recortado.getTime() >= hasta.getTime() ? hasta : recortado;
}

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

/**
 * La ventana del período, en hora de Caracas: desde su inicio hasta `ahora`,
 * sin leer antes de `piso`. El piso es un parámetro (default `INICIO_PANELES`)
 * y no una constante leída por dentro para que los tests de calendario con un
 * reloj anterior al 16/11 pasen `null` y sigan probando la aritmética pura.
 */
export function rangoDe(
  id: PeriodoId,
  ahora: Date = new Date(),
  piso: Date | null = INICIO_PANELES
): RangoPanel {
  return { desde: recortarAlPiso(desdeDe(id, ahora), ahora, piso), hasta: ahora, etiqueta: etiquetaDe(id) };
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
export function rangoPrevio(
  id: PeriodoId,
  ahora: Date = new Date(),
  piso: Date | null = INICIO_PANELES
): RangoPanel | null {
  // El previo se calcula SIEMPRE desde el período sin recortar: el recorte al
  // piso acortaría el tramo y comparar «7 días recortados» contra «7 días
  // enteros» es la trampa de «día parcial contra día completo».
  const previo = rangoPrevioCrudo(id, ahora);
  // Un previo que arranca antes del piso no se compara, aunque termine después:
  // un tramo recortado contra uno entero es la misma trampa.
  if (piso !== null && previo.desde.getTime() < piso.getTime()) return null;
  return previo;
}

function rangoPrevioCrudo(id: PeriodoId, ahora: Date): RangoPanel {
  const actual = rangoDe(id, ahora, null);
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

/**
 * Los únicos períodos que ofrece Asesores (15/11/2026). `panel_asesores` lee
 * `messages` y a 92 días tarda 1,3–1,5 s con 300 mil mensajes (a 30 días,
 * 0,7–0,9 s): un `?periodo=anio` pedía un año entero, la RPC lo recortaba a
 * 92 días y el control pintaba una opción que la pantalla no ofrece.
 */
export const PERIODOS_ASESORES: PeriodoId[] = ["hoy", "7d", "30d"];

/** El período de Asesores: solo hoy / 7d / 30d; `mes`, `anio` y lo desconocido caen en "hoy". */
export function periodoDeAsesores(valor: string | undefined): PeriodoId {
  return PERIODOS_ASESORES.find((id) => id === valor) ?? "hoy";
}
