import { businessStatus, type BusinessHours, type DayKey } from "@/lib/business-hours";
import type { Vista } from "@/lib/paneles/canal";
import {
  sumaCanales,
  type CanalId,
  type CanalVentas,
  type PanelVentas,
  type PanelVentasActivas,
} from "@/lib/paneles/parse";
import { crmDayKey, shiftDayKey, todayKey } from "@/lib/sales-day";
import { crmMinuteOfDay, crmWeekday } from "@/lib/time-zone";

/**
 * Cálculos puros del Dashboard de ventas (plan "Paneles", C4, 13/11/2026): lo
 * que las tarjetas derivan de los bloques que entrega `page.tsx`. Sin React ni
 * reloj propio (todo recibe `ahora`). Regla de siempre: `null` es "no se puede
 * calcular" y la pantalla pinta «—», nunca un 0 que parezca verdad.
 */

/** Los envíos a SAINT se registran desde esta fecha (medianoche de Caracas del 26/10/2026). */
export const FECHA_INICIO_ENVIOS = new Date("2026-10-26T04:00:00Z");

/** Un período que arranca antes del 26/10 incluye días sin envíos registrados: la pantalla lo avisa. */
export function periodoTocaAntesDeEnvios(desde: Date): boolean {
  return desde.getTime() < FECHA_INICIO_ENVIOS.getTime();
}

function centavos(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Los totales del canal elegido; "resumen" suma los dos. */
export function canalDeVista(v: PanelVentas, vista: Vista): CanalVentas {
  return vista === "resumen" ? sumaCanales(v) : v.canales[vista];
}

/** La medida de cada tramo de la serie, para la vista elegida. */
export function serieDeVista(v: PanelVentas, vista: Vista, medida: "ingresos" | "envios"): number[] {
  return v.serie.map((p) => {
    const online = medida === "ingresos" ? p.online : p.envios_online;
    const tienda = medida === "ingresos" ? p.tienda : p.envios_tienda;
    if (vista === "online") return online;
    if (vista === "tienda") return tienda;
    return centavos(online + tienda);
  });
}

/**
 * Cambio porcentual con un decimal. `null` si falta el actual o el previo, o si
 * el previo es 0 (no se divide: "creció infinito" no es una cifra).
 */
export function variacion(actual: number | null, previo: number | null): number | null {
  if (actual === null || previo === null || !(previo > 0)) return null;
  return Math.round((actual / previo - 1) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Ventas activas
// ---------------------------------------------------------------------------

export interface DesgloseActivas {
  monto: number | null;
  cantidad: number;
  presupuestos: { monto: number | null; cantidad: number };
  carritos: { monto: number | null; cantidad: number };
}

function restar(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return centavos(Math.max(0, a - b));
}

/**
 * Lo que sigue en curso según la vista. El contrato solo trae el reparto
 * presupuestos/carritos del total; por canal viene un monto y una cantidad.
 * Como los carritos son SIEMPRE del chat (online) y los presupuestos de tienda
 * son todo lo de tienda: tienda = solo presupuestos; online = los carritos más
 * lo que sobra del canal.
 */
export function desgloseActivas(a: PanelVentasActivas, vista: Vista): DesgloseActivas {
  if (vista === "resumen") {
    return {
      monto: a.total,
      cantidad: a.presupuestos.cantidad + a.carritos.cantidad,
      presupuestos: { monto: a.presupuestos.monto, cantidad: a.presupuestos.cantidad },
      carritos: { monto: a.carritos.monto, cantidad: a.carritos.cantidad },
    };
  }
  const canal = a.por_canal[vista];
  if (vista === "tienda") {
    return {
      monto: canal.monto,
      cantidad: canal.cantidad,
      presupuestos: { monto: canal.monto, cantidad: canal.cantidad },
      carritos: { monto: 0, cantidad: 0 },
    };
  }
  return {
    monto: canal.monto,
    cantidad: canal.cantidad,
    presupuestos: { monto: restar(canal.monto, a.carritos.monto), cantidad: Math.max(0, canal.cantidad - a.carritos.cantidad) },
    carritos: { monto: a.carritos.monto, cantidad: a.carritos.cantidad },
  };
}

/** Los ítems de la vista, del más viejo al más nuevo (el servidor ya los manda así; no se confía). */
export function itemsDeVista(a: PanelVentasActivas, vista: Vista): PanelVentasActivas["items"] {
  return a.items
    .filter((i) => vista === "resumen" || i.canal === vista)
    .sort((x, y) => new Date(x.desde).getTime() - new Date(y.desde).getTime());
}

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Cuántos ítems sin enviar llevan más de 7 días. En el resumen lo dice el tramo
 * "30d" (el último: más de 7 días); el desglose por tramo no viene por canal,
 * así que en un canal se mira la lista de los 30 más viejos, que es donde
 * estarían.
 */
export function cantidadItemsViejos(a: PanelVentasActivas, vista: Vista, ahora: Date): number {
  if (vista === "resumen") return a.antiguedad.find((t) => t.tramo === "30d")?.cantidad ?? 0;
  return itemsDeVista(a, vista).filter((i) => ahora.getTime() - new Date(i.desde).getTime() > 7 * DIA_MS).length;
}

export function hayItemsViejos(a: PanelVentasActivas, vista: Vista, ahora: Date): boolean {
  return cantidadItemsViejos(a, vista, ahora) > 0;
}

/** "20 min", "5 h", "3 d": la unidad más grande que cabe. */
export function antiguedadTexto(desde: string, ahora: Date): string {
  const minutos = Math.floor((ahora.getTime() - new Date(desde).getTime()) / 60000);
  if (minutos < 1) return "menos de 1 min";
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `${horas} h`;
  return `${Math.floor(horas / 24)} d`;
}

// ---------------------------------------------------------------------------
// Rendimiento del día
// ---------------------------------------------------------------------------

const DIA_POR_SEMANA: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function aHoras(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h + m / 60;
}

/**
 * El horario de atención de HOY como una sola ventana en horas fraccionales
 * (8 a 18 = `{ desde: 8, hasta: 18 }`); varias franjas se unen de la primera
 * apertura a la última cierre. `null` si hoy la tienda no abre.
 */
export function ventanaDeHoy(horario: BusinessHours, ahora: Date): { desde: number; hasta: number } | null {
  const franjas = horario[DIA_POR_SEMANA[crmWeekday(ahora)]];
  if (franjas.length === 0) return null;
  return {
    desde: Math.min(...franjas.map(([inicio]) => aHoras(inicio))),
    hasta: Math.max(...franjas.map(([, fin]) => aHoras(fin))),
  };
}

/**
 * La próxima apertura de la tienda (15/11/2026, para la tarjeta de rendimiento
 * en un día cerrado): el día `YYYY-MM-DD` de Caracas en que abre y cómo decirlo
 * («el lunes», «8:00 am»). El texto sale de `businessStatus` —que ya sabe leer el
 * horario y no se duplica—; acá solo se le añade la fecha, que la tarjeta
 * necesita para preguntarle a `metaDelDia` qué meta regirá ese día. `null` si la
 * tienda está abierta ahora o si no abre ningún día de la semana.
 */
export function proximaApertura(
  horario: BusinessHours,
  ahora: Date
): { dia: string; etiqueta: string; hora: string } | null {
  const apertura = businessStatus(ahora, horario).nextOpening;
  if (!apertura) return null;

  const hoy = todayKey(ahora);
  if (apertura.dayLabel === "hoy") return { dia: hoy, etiqueta: apertura.dayLabel, hora: apertura.time };

  const semana = crmWeekday(ahora);
  for (let desplazamiento = 1; desplazamiento <= 7; desplazamiento++) {
    if (horario[DIA_POR_SEMANA[(semana + desplazamiento) % 7]].length > 0) {
      return { dia: shiftDayKey(hoy, desplazamiento), etiqueta: apertura.dayLabel, hora: apertura.time };
    }
  }
  return null;
}

/** Un horario que abre todos los días: para leer la meta vigente de HOY aunque hoy sea cerrado. */
export const HORARIO_SIEMPRE_ABIERTO: BusinessHours = {
  mon: [["00:00", "23:59"]],
  tue: [["00:00", "23:59"]],
  wed: [["00:00", "23:59"]],
  thu: [["00:00", "23:59"]],
  fri: [["00:00", "23:59"]],
  sat: [["00:00", "23:59"]],
  sun: [["00:00", "23:59"]],
};

/** La hora de Caracas de un instante, entera (0–23). */
export function horaEnteraDeCaracas(instante: Date): number {
  return Math.floor(crmMinuteOfDay(instante) / 60);
}

/** Lo vendido hasta el cierre de cada hora (0..`hastaHora`), para la vista elegida: la línea real del ritmo. */
export function acumuladoPorHora(v: PanelVentas, vista: Vista, hastaHora: number): number[] {
  const porHora = Array<number>(hastaHora + 1).fill(0);
  const valores = serieDeVista(v, vista, "ingresos");
  v.serie.forEach((p, i) => {
    const hora = horaEnteraDeCaracas(new Date(p.t));
    if (hora >= 0 && hora <= hastaHora) porHora[hora] += valores[i];
  });
  let suma = 0;
  return porHora.map((monto) => {
    suma += monto;
    return centavos(suma);
  });
}

/**
 * La meta acumulada al cierre de cada hora (24 valores). Con curva horaria es
 * la forma habitual del día; sin ella, una recta de 0 a la meta durante el
 * horario de atención. Sin ninguna de las dos (día cerrado), ceros.
 */
export function metaAcumuladaPorHora(
  meta: number,
  curva: number[] | null,
  ventana: { desde: number; hasta: number } | null
): number[] {
  return Array.from({ length: 24 }, (_, h) => {
    if (curva) return centavos(meta * curva[h]);
    if (!ventana) return 0;
    const fraccion = Math.min(1, Math.max(0, (h + 1 - ventana.desde) / (ventana.hasta - ventana.desde)));
    return centavos(meta * fraccion);
  });
}

// ---------------------------------------------------------------------------
// Tablero mensual
// ---------------------------------------------------------------------------

/**
 * Los 12 meses del año con lo enviado por canal. La serie puede llegar por día
 * (el año tiene menos de 93 días hasta principios de abril) o por mes: se
 * agrupa por el mes de Caracas de cada tramo en los dos casos.
 */
export function ingresosPorMes(v: PanelVentas, anio: number): { mes: number; online: number; tienda: number }[] {
  const meses = Array.from({ length: 12 }, (_, i) => ({ mes: i + 1, online: 0, tienda: 0 }));
  for (const p of v.serie) {
    const [a, m] = crmDayKey(p.t).split("-").map(Number);
    if (a !== anio) continue;
    meses[m - 1].online = centavos(meses[m - 1].online + p.online);
    meses[m - 1].tienda = centavos(meses[m - 1].tienda + p.tienda);
  }
  return meses;
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

/** Quien armó y envió, sumado entre canales en el resumen o solo el canal de la vista. */
export function enviosPorPersona(
  v: PanelVentas,
  vista: Vista
): { agent_id: string; nombre: string; rol: string; envios: number; ingresos: number | null; canal: CanalId | null }[] {
  const mapa = new Map<string, { agent_id: string; nombre: string; rol: string; envios: number; ingresos: number | null; canal: CanalId | null }>();
  for (const p of v.personas) {
    if (vista !== "resumen" && p.canal !== vista) continue;
    const previa = mapa.get(p.agent_id);
    if (!previa) {
      mapa.set(p.agent_id, { agent_id: p.agent_id, nombre: p.nombre, rol: p.rol, envios: p.envios, ingresos: p.ingresos, canal: p.canal });
      continue;
    }
    previa.envios += p.envios;
    previa.ingresos = previa.ingresos === null && p.ingresos === null ? null : centavos((previa.ingresos ?? 0) + (p.ingresos ?? 0));
    previa.canal = null;
  }
  return [...mapa.values()].sort((a, b) => b.envios - a.envios || (b.ingresos ?? 0) - (a.ingresos ?? 0));
}

/** "AB" para "Ana Borges"; "?" sin nombre. */
export function iniciales(nombre: string): string {
  const palabras = nombre.trim().split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return "?";
  if (palabras.length === 1) return palabras[0].slice(0, 2).toUpperCase();
  return (palabras[0][0] + palabras[palabras.length - 1][0]).toUpperCase();
}
