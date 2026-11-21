import { todayKey } from "@/lib/sales-day";

/**
 * La regla compartida de «Mes a mes» (plan "Paneles", 15/11/2026): Analíticas y
 * el Tablero de ingresos del Dashboard no pintan meses sin registro.
 *
 * Desde el 21/11/2026 el límite es el piso de los paneles (`INICIO_PANELES`,
 * 16/11/2026; ver `periodos.ts`): nada anterior se lee ni se pinta, así que el
 * tablero arranca en el mes del piso (`mesesDelTablero`). Antes (15/11) cortaba
 * en el primer mes con algún envío, porque los envíos a SAINT solo se
 * registraban desde finales de octubre y enero a septiembre en $0,00 parecían
 * «no vendimos nada»; esa regla (`mesesDesdeElPrimerEnvio`) queda para cuando no hay piso. Un
 * mes vacío DESPUÉS del primero sí se conserva: ahí hay registro y el cero es
 * verdad.
 */
type MesConEnvios = { online: number; tienda: number; envios: number };

/**
 * Sin piso: parte del primer mes con algún envío. Sin ningún envío en el año,
 * lista vacía. Vivía en `analiticas/datos.ts`; se movió aquí para que el
 * Dashboard la reuse.
 */
export function mesesDesdeElPrimerEnvio<T extends MesConEnvios>(meses: T[]): T[] {
  const primero = meses.findIndex((m) => m.envios > 0 || m.online > 0 || m.tienda > 0);
  return primero === -1 ? [] : meses.slice(primero);
}

function mesYAnioDe(piso: Date): { anio: number; mes: number; dia: number } {
  const [anio, mes, dia] = todayKey(piso).split("-").map(Number);
  return { anio, mes, dia };
}

/**
 * Los meses que pinta el tablero. `meses` va en orden desde enero (el índice 0
 * es enero; puede llegar hasta el mes en curso o hasta diciembre). Con piso en
 * ese `anio` corta los meses ANTERIORES al del piso y conserva los posteriores
 * aunque estén vacíos; sin piso, o con un piso de un año anterior (todo el año
 * es posterior), cae en `mesesDesdeElPrimerEnvio`.
 */
export function mesesDelTablero<T extends MesConEnvios>(meses: T[], anio: number, piso: Date | null): T[] {
  if (piso === null) return mesesDesdeElPrimerEnvio(meses);
  const del = mesYAnioDe(piso);
  if (del.anio !== anio) return mesesDesdeElPrimerEnvio(meses);
  return meses.slice(del.mes - 1);
}

/**
 * Rotula el mes del piso con el día desde el que cuenta: «Nov (desde el 16)».
 * `mes` es 1–12. Otro mes, otro año, sin piso o un piso en día 1 devuelven la
 * etiqueta tal cual.
 */
export function rotuloDelMes(etiqueta: string, anio: number, mes: number, piso: Date | null): string {
  if (piso === null) return etiqueta;
  const del = mesYAnioDe(piso);
  if (del.anio !== anio || del.mes !== mes || del.dia === 1) return etiqueta;
  return `${etiqueta} (desde el ${del.dia})`;
}

/** ¿El mes (1–12) es el del piso y este arranca a mitad de mes (el mes viene recortado)? */
export function esMesRecortadoPorElPiso(anio: number, mes: number, piso: Date | null): boolean {
  if (piso === null) return false;
  const del = mesYAnioDe(piso);
  return del.anio === anio && del.mes === mes && del.dia !== 1;
}
