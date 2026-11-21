import type { BusinessHours, DayKey } from "@/lib/business-hours";
import { todayKey } from "@/lib/sales-day";
import { canalesVisibles } from "./canal";
import type { CanalId, MetaVenta } from "./parse";

/**
 * Metas, curva horaria, proyección y racha del Dashboard de ventas (plan
 * "Paneles", 13/11/2026). Puro: sin React ni Supabase, y nada lee el reloj.
 * `null` significa "no se puede calcular" y la pantalla pinta "—", nunca 0.
 */

// `Date#getUTCDay`: 0 = domingo. Mismo arreglo que `DAY_KEY_BY_WEEKDAY` de
// business-hours.ts, que no se exporta; el día viene como clave plana
// `YYYY-MM-DD`, así que no hay zona horaria de por medio.
const DIA_POR_SEMANA: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function diaDeSemana(dia: string): DayKey {
  const [anio, mes, d] = dia.split("-").map(Number);
  return DIA_POR_SEMANA[new Date(Date.UTC(anio, mes - 1, d)).getUTCDay()];
}

/** ¿El horario de atención tiene abierto ese día (`YYYY-MM-DD`)? Un día sin ningún tramo es cerrado. */
export function diaAbierto(dia: string, horario: BusinessHours): boolean {
  return horario[diaDeSemana(dia)].length > 0;
}

function metaVigente(metas: MetaVenta[], canal: CanalId, dia: string): number | null {
  let elegida: MetaVenta | null = null;
  for (const meta of metas) {
    if (meta.canal !== canal || meta.vigente_desde > dia) continue;
    // `YYYY-MM-DD` ordena igual como texto que como fecha.
    if (elegida === null || meta.vigente_desde > elegida.vigente_desde) elegida = meta;
  }
  return elegida?.monto_usd ?? null;
}

/**
 * La meta de ventas de un día. La vigente de un canal es la fila con el
 * `vigente_desde` más alto que no pase de ese día. Un día cerrado según el
 * horario de atención no tiene meta (`null`), igual que un día anterior a
 * toda meta. "resumen" suma las de los canales VISIBLES y, si solo uno tiene
 * meta, vale esa: no hay razón para esconder la meta que sí existe. Con la
 * tienda oculta (D1, 21/11/2026) "resumen" es la meta online sola, aunque haya
 * una meta de tienda guardada: esa fila no se toca, solo no se suma.
 */
export function metaDelDia(
  metas: MetaVenta[],
  canal: CanalId | "resumen",
  dia: string,
  horario: BusinessHours
): number | null {
  if (!diaAbierto(dia, horario)) return null;

  if (canal !== "resumen") return metaVigente(metas, canal, dia);

  const vigentes = canalesVisibles()
    .map((c) => metaVigente(metas, c, dia))
    .filter((m): m is number => m !== null);
  if (vigentes.length === 0) return null;
  return vigentes.reduce((suma, m) => suma + m, 0);
}

/** Días con ventas que hacen falta para fiarse de la forma del día. */
export const MIN_DIAS_CURVA = 10;

type DiaDeHistoria = { dia: string; porHora: number[] };

/**
 * ÚNICA función que decide qué día de la historia sirve para la curva (D2 y A2,
 * 21/11/2026): una forma de 24 horas, con ventas (total > 0) y, si hay piso, de
 * ese día en adelante (`YYYY-MM-DD` ordena igual como texto que como fecha).
 * `curvaHoraria` y `diasConVentasParaCurva` pasan las dos por acá: así el «van N»
 * de la pantalla nunca puede contar un día que la curva descartaría.
 */
function diasValidosParaCurva(historia: DiaDeHistoria[], piso: Date | null): DiaDeHistoria[] {
  const desde = piso === null ? null : todayKey(piso);
  return historia.filter(({ dia, porHora }) => {
    if (desde !== null && dia < desde) return false;
    if (porHora.length !== 24) return false;
    return porHora.reduce((suma, v) => suma + v, 0) > 0;
  });
}

/**
 * Cuántos días de la historia cuentan para la curva: CON VENTAS (no días
 * corridos: un día con total 0 no cuenta) y desde el piso de datos. Es el «van N»
 * del Dashboard.
 */
export function diasConVentasParaCurva(historia: DiaDeHistoria[], piso: Date | null = null): number {
  return diasValidosParaCurva(historia, piso).length;
}

/**
 * La proporción acumulada del día por hora, a partir de días con ventas:
 * `curva[h]` es la fracción de las ventas del día que ya se había hecho al
 * CERRAR la hora `h` (0 = 00:00–00:59), 24 valores de 0 a 1.
 *
 * Cada día aporta su propia forma y se promedian las formas, no los montos:
 * así un día excepcional (una venta enorme) no aplasta a los demás. La regla es
 * «días CON VENTAS», no días corridos: un día sin ventas, o con una forma que no
 * es de 24 horas, no cuenta. Con `piso`, tampoco cuenta un día anterior a él (el
 * 16/11/2026 no hay datos comparables antes; la forma horaria de antes del piso
 * no se usa, decisión D2). Con menos de `MIN_DIAS_CURVA` días válidos devuelve
 * `null`: una curva con poca historia proyectaría disparates y es mejor no
 * proyectar.
 */
export function curvaHoraria(historia: DiaDeHistoria[], piso: Date | null = null): number[] | null {
  const validos = diasValidosParaCurva(historia, piso);
  if (validos.length < MIN_DIAS_CURVA) return null;

  const formas = validos.map(({ porHora }) => {
    const total = porHora.reduce((suma, v) => suma + v, 0);
    let acumulado = 0;
    return porHora.map((v) => {
      acumulado += v;
      return acumulado / total;
    });
  });

  return Array.from({ length: 24 }, (_, h) => formas.reduce((suma, forma) => suma + forma[h], 0) / formas.length);
}

function redondearCentavos(monto: number): number {
  return Math.round(monto * 100) / 100;
}

/**
 * Cuánto cerraría el día si siguiera el ritmo habitual: lo logrado hasta
 * ahora entre la fracción que normalmente ya se vendió a esta hora.
 * `horaActual` es fraccional en hora de Caracas (10,5 = 10:30) y se
 * interpola dentro de la hora. `null` sin curva, o mientras la curva dice que
 * a esta hora normalmente todavía no se vende nada (dividiría entre cero).
 */
export function proyeccion(logradoHastaAhora: number, horaActual: number, curva: number[] | null): number | null {
  if (curva === null || curva.length !== 24) return null;

  const t = Math.min(Math.max(horaActual, 0), 24);
  let fraccion: number;
  if (t >= 24) {
    fraccion = curva[23];
  } else {
    const h = Math.floor(t);
    const previo = h === 0 ? 0 : curva[h - 1];
    fraccion = previo + (curva[h] - previo) * (t - h);
  }

  if (!(fraccion > 0)) return null;
  return redondearCentavos(logradoHastaAhora / fraccion);
}

/**
 * Días seguidos con la meta cumplida, contando hacia atrás desde el más
 * reciente de la lista (quien llama pasa los días hasta AYER: hoy aún no
 * terminó). Un día sin meta —cerrado, o anterior a toda meta— no corta la
 * racha ni suma: un domingo no tiene por qué romper la racha del sábado.
 * Acepta los días en cualquier orden.
 */
export function racha(dias: { dia: string; logrado: number; meta: number | null }[]): number {
  const recientesPrimero = [...dias].sort((a, b) => b.dia.localeCompare(a.dia));

  let seguidos = 0;
  for (const { logrado, meta } of recientesPrimero) {
    if (meta === null || !(meta > 0)) continue;
    if (logrado >= meta) seguidos += 1;
    else break;
  }
  return seguidos;
}

/** Lo que falta para la meta; nunca negativo. `null` si falta un dato. */
export function faltante(logrado: number | null, meta: number | null): number | null {
  if (logrado === null || meta === null) return null;
  return redondearCentavos(Math.max(0, meta - logrado));
}

/**
 * Porcentaje de la meta alcanzado (0–100 o más), con un decimal. `null` sin
 * logrado, sin meta, o con meta 0 (no se divide).
 */
export function porcentaje(logrado: number | null, meta: number | null): number | null {
  if (logrado === null || meta === null || !(meta > 0)) return null;
  return Math.round((logrado / meta) * 1000) / 10;
}
