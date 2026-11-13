import type { BusinessHours, DayKey } from "@/lib/business-hours";
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
 * toda meta. "resumen" suma las de los dos canales y, si solo uno tiene meta,
 * vale esa: no hay razón para esconder la meta que sí existe.
 */
export function metaDelDia(
  metas: MetaVenta[],
  canal: CanalId | "resumen",
  dia: string,
  horario: BusinessHours
): number | null {
  if (horario[diaDeSemana(dia)].length === 0) return null;

  if (canal !== "resumen") return metaVigente(metas, canal, dia);

  const online = metaVigente(metas, "online", dia);
  const tienda = metaVigente(metas, "tienda", dia);
  if (online === null && tienda === null) return null;
  return (online ?? 0) + (tienda ?? 0);
}

/** Días hábiles con ventas que hacen falta para fiarse de la forma del día. */
const MIN_DIAS_CURVA = 10;

/**
 * La proporción acumulada del día por hora, a partir de días hábiles con
 * ventas: `curva[h]` es la fracción de las ventas del día que ya se había
 * hecho al CERRAR la hora `h` (0 = 00:00–00:59), 24 valores de 0 a 1.
 *
 * Cada día aporta su propia forma y se promedian las formas, no los montos:
 * así un día excepcional (una venta enorme) no aplasta a los demás. Un día sin
 * ventas, o con una forma que no es de 24 horas, no cuenta. Con menos de 10
 * días válidos devuelve `null`: una curva con poca historia proyectaría
 * disparates y es mejor no proyectar.
 */
export function curvaHoraria(historia: { dia: string; porHora: number[] }[]): number[] | null {
  const formas: number[][] = [];

  for (const { porHora } of historia) {
    if (porHora.length !== 24) continue;
    const total = porHora.reduce((suma, v) => suma + v, 0);
    if (!(total > 0)) continue;

    let acumulado = 0;
    formas.push(
      porHora.map((v) => {
        acumulado += v;
        return acumulado / total;
      })
    );
  }

  if (formas.length < MIN_DIAS_CURVA) return null;
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
