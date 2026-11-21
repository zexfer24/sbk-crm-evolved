import type { BusinessHours, DayKey } from "@/lib/business-hours";
import { tiendaVisible, type Vista } from "@/lib/paneles/canal";
import { diaAbierto, metaDelDia, racha } from "@/lib/paneles/rendimiento";
import {
  sumaCanales,
  type CanalId,
  type CanalVentas,
  type MetaVenta,
  type PanelConversaciones,
  type PanelVentas,
  type PanelVentasActivas,
} from "@/lib/paneles/parse";
import { crmDayKey, shiftDayKey, todayKey } from "@/lib/sales-day";
import { CRM_TIME_ZONE } from "@/lib/time-zone";
import type { SerieGrafico } from "@/components/paneles/panel-graficos";

/**
 * La aritmética de Analíticas (plan "Paneles", C5, 13/11/2026), sin React:
 * cada función recibe el dato ya leído y, si hace falta un "hoy", lo recibe
 * como parámetro. Nada acá lee el reloj, para que los tests no dependan de él.
 *
 * Regla de siempre: `null` es "no se puede calcular" y la pantalla pinta «—»;
 * ninguna de estas funciones devuelve 0 para tapar un dato que falta.
 */

export type Medida = "ingresos" | "envios";

/** Los dos canales de una vista: el resumen los suma, los otros miran uno. */
export function canalesDeVista(dato: PanelVentas, vista: Vista): CanalVentas {
  return vista === "resumen" ? sumaCanales(dato) : dato.canales[vista];
}

// ---------------------------------------------------------------------------
// Variación y formatos de tiempo
// ---------------------------------------------------------------------------

/** Cambio relativo en %. `null` si falta alguno de los dos o el previo es 0 (no se divide). */
export function variacionPct(actual: number | null, previo: number | null): number | null {
  if (actual === null || previo === null || !(previo > 0)) return null;
  return ((actual - previo) / previo) * 100;
}

/** «30 min», «5 h» o «3 d»: la antigüedad en la unidad que se lee de un vistazo. */
export function formatoEdad(horas: number): string {
  if (horas < 1) return `${Math.max(1, Math.round(horas * 60))} min`;
  if (horas < 24) return `${Math.round(horas)} h`;
  return `${Math.round(horas / 24)} d`;
}

export function horasDesde(iso: string, ahora: Date): number {
  return Math.max(0, (ahora.getTime() - new Date(iso).getTime()) / 3_600_000);
}

const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export const MESES_LARGOS = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

function conIntl(opciones: Intl.DateTimeFormatOptions, instante: string): string {
  // `es-VE` imprime «nov.» en Node 26 y «nov» en otras versiones de ICU: se quita el punto.
  return new Intl.DateTimeFormat("es-VE", { timeZone: CRM_TIME_ZONE, ...opciones })
    .format(new Date(instante))
    .replace(/\./g, "");
}

/** El rótulo del eje X de un tramo de la serie, en hora de Caracas. */
export function etiquetaDeTramo(t: string, granularidad: PanelVentas["granularidad"]): string {
  if (granularidad === "hora") return conIntl({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, t);
  if (granularidad === "mes") return conIntl({ month: "short" }, t);
  return conIntl({ day: "numeric", month: "short" }, t);
}

/** «vie 13 nov» para una clave `YYYY-MM-DD`. */
export function etiquetaDeDia(clave: string): string {
  return conIntl({ weekday: "short", day: "numeric", month: "short" }, `${clave}T12:00:00Z`).replace(",", "");
}

// ---------------------------------------------------------------------------
// Ingresos en el tiempo
// ---------------------------------------------------------------------------

const COLOR_CANAL: Record<CanalId, string> = { online: "var(--pn-online)", tienda: "var(--pn-tienda)" };
const NOMBRE_CANAL: Record<CanalId, string> = { online: "Online", tienda: "En tienda" };

export function nombreDeCanal(canal: CanalId): string {
  return NOMBRE_CANAL[canal];
}

function valorDeTramo(fila: PanelVentas["serie"][number], canal: CanalId, medida: Medida): number {
  if (medida === "ingresos") return fila[canal];
  return canal === "online" ? fila.envios_online : fila.envios_tienda;
}

/**
 * Las series que dibuja el gráfico. En resumen cada canal es una línea, salvo
 * al comparar: la serie previa es la del TOTAL, y una línea por canal contra un
 * total previo no se puede leer, así que al comparar el resumen pasa a una
 * sola línea «Total» (la leyenda lo dice). Con la tienda oculta (D1,
 * 21/11/2026) el resumen es SIEMPRE una sola serie «Total» —la suma de los dos
 * canales— en el color online, sin desglose.
 */
export function serieDeMedida(
  dato: PanelVentas,
  vista: Vista,
  medida: Medida,
  comoTotal: boolean
): { series: SerieGrafico[]; valores: number[][] } {
  if (vista !== "resumen") {
    return {
      series: [{ id: vista, nombre: NOMBRE_CANAL[vista], color: COLOR_CANAL[vista] }],
      valores: dato.serie.map((fila) => [valorDeTramo(fila, vista, medida)]),
    };
  }
  if (comoTotal || !tiendaVisible()) {
    return {
      series: [{ id: "total", nombre: "Total", color: tiendaVisible() ? "var(--lm-ink)" : COLOR_CANAL.online }],
      valores: dato.serie.map((fila) => [valorDeTramo(fila, "online", medida) + valorDeTramo(fila, "tienda", medida)]),
    };
  }
  return {
    series: [
      { id: "online", nombre: NOMBRE_CANAL.online, color: COLOR_CANAL.online },
      { id: "tienda", nombre: NOMBRE_CANAL.tienda, color: COLOR_CANAL.tienda },
    ],
    valores: dato.serie.map((fila) => [valorDeTramo(fila, "online", medida), valorDeTramo(fila, "tienda", medida)]),
  };
}

/** El total de la vista por tramo (lo que se dibuja punteado al comparar). */
export function valoresPrevios(dato: PanelVentas, vista: Vista, medida: Medida): number[] {
  return dato.serie.map((fila) =>
    vista === "resumen"
      ? valorDeTramo(fila, "online", medida) + valorDeTramo(fila, "tienda", medida)
      : valorDeTramo(fila, vista, medida)
  );
}

// ---------------------------------------------------------------------------
// KPI de conversión y de clientes que regresan
// ---------------------------------------------------------------------------

export function tasaDeConversion(equipo: { atendidas: number; compraron: number }): {
  fraccion: number | null;
  compraron: number;
  atendidas: number;
} {
  return {
    fraccion: equipo.atendidas > 0 ? equipo.compraron / equipo.atendidas : null,
    compraron: equipo.compraron,
    atendidas: equipo.atendidas,
  };
}

export function tasaDeRegreso(
  recurrentes: PanelVentas["recurrentes"],
  vista: Vista
): { fraccion: number | null; regresan: number; compradores: number } {
  const canales: CanalId[] = vista === "resumen" ? ["online", "tienda"] : [vista];
  const compradores = canales.reduce((suma, c) => suma + recurrentes[c].compradores, 0);
  const regresan = canales.reduce((suma, c) => suma + recurrentes[c].regresan, 0);
  return { fraccion: compradores > 0 ? regresan / compradores : null, regresan, compradores };
}

// ---------------------------------------------------------------------------
// Embudo conversacional
// ---------------------------------------------------------------------------

export interface EtapaDelEmbudo {
  id: "escribieron" | "respondidas" | "con_carrito" | "compraron";
  etiqueta: string;
  valor: number;
  /** % de los que escribieron (0–100, redondeado). */
  pctDelInicio: number;
  /** Cuántos se perdieron respecto de la etapa anterior; `null` en la primera. Nunca negativo. */
  caida: { n: number; pct: number } | null;
}

export function etapasDelEmbudo(embudo: PanelConversaciones["embudo"]): EtapaDelEmbudo[] {
  const pasos: [EtapaDelEmbudo["id"], string, number][] = [
    ["escribieron", "Escribieron", embudo.escribieron],
    ["respondidas", "Respondidas", embudo.respondidas],
    ["con_carrito", "Con carrito", embudo.con_carrito],
    ["compraron", "Compraron", embudo.compraron],
  ];
  return pasos.map(([id, etiqueta, valor], i) => {
    const previo = i === 0 ? null : pasos[i - 1][2];
    const n = previo === null ? 0 : Math.max(0, previo - valor);
    return {
      id,
      etiqueta,
      valor,
      pctDelInicio: embudo.escribieron > 0 ? Math.round((valor * 100) / embudo.escribieron) : 0,
      caida: previo === null ? null : { n, pct: previo > 0 ? Math.round((n * 100) / previo) : 0 },
    };
  });
}

/** «De cada 100 que escribieron, N solo preguntaron y M compraron.»; `null` sin conversaciones. */
export function fraseDelEmbudo(
  embudo: PanelConversaciones["embudo"],
  resultados: PanelConversaciones["resultados"]
): string | null {
  if (!(embudo.escribieron > 0)) return null;
  const porCien = (n: number) => Math.round((n * 100) / embudo.escribieron);
  return `De cada 100 que escribieron, ${porCien(resultados.solo_preguntaron)} solo preguntaron y ${porCien(resultados.compraron)} compraron.`;
}

// ---------------------------------------------------------------------------
// Mapa de calor «Cuándo escriben»
// ---------------------------------------------------------------------------

const CLAVE_POR_DIA: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function aMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Las horas que muestra el mapa: de la apertura más temprana de la semana a la
 * última hora en que algún día sigue abierto (un cierre a las 18:00 deja 17 como
 * última hora; a las 18:30, 18). Sin ningún horario abierto, el día entero.
 */
export function horasDeAtencion(horario: BusinessHours): { desde: number; hasta: number } {
  let inicio = Infinity;
  let fin = -Infinity;
  for (const clave of CLAVE_POR_DIA) {
    for (const [a, b] of horario[clave]) {
      inicio = Math.min(inicio, aMinutos(a));
      fin = Math.max(fin, aMinutos(b));
    }
  }
  if (!Number.isFinite(inicio)) return { desde: 0, hasta: 23 };
  return { desde: Math.floor(inicio / 60), hasta: Math.ceil(fin / 60) - 1 };
}

/** ¿Ese día de la semana (0 = domingo) está abierto en esa hora (cualquier minuto de ella)? */
export function estaAbierto(horario: BusinessHours, diaSemana: number, hora: number): boolean {
  const ini = hora * 60;
  const fin = ini + 60;
  return horario[CLAVE_POR_DIA[diaSemana]].some(([a, b]) => aMinutos(a) < fin && aMinutos(b) > ini);
}

// ---------------------------------------------------------------------------
// Ventas activas
// ---------------------------------------------------------------------------

export interface FiltroActivas {
  tipo: "todos" | "presupuesto" | "carrito";
  canal: Vista;
  antiguedad: "todas" | "24h" | "3d" | "7d";
}

const HORAS_MINIMAS: Record<FiltroActivas["antiguedad"], number> = { todas: 0, "24h": 24, "3d": 72, "7d": 168 };

export function filtrarActivas(
  items: PanelVentasActivas["items"],
  filtro: FiltroActivas,
  ahora: Date
): PanelVentasActivas["items"] {
  return items.filter(
    (item) =>
      (filtro.tipo === "todos" || item.tipo === filtro.tipo) &&
      (filtro.canal === "resumen" || item.canal === filtro.canal) &&
      (filtro.antiguedad === "todas" || horasDesde(item.desde, ahora) > HORAS_MINIMAS[filtro.antiguedad])
  );
}

// ---------------------------------------------------------------------------
// Mes a mes
// ---------------------------------------------------------------------------

export interface MesDelAnio {
  /** `YYYY-MM`. */
  clave: string;
  /** 0 = enero. */
  mes: number;
  etiqueta: string;
  online: number;
  tienda: number;
  envios: number;
  enCurso: boolean;
}

/**
 * Los meses del año, de enero al mes en curso (hora de Caracas). Se agrupa por
 * el mes de cada tramo en vez de fiarse de `granularidad = "mes"`: la RPC
 * entrega días mientras el año tenga menos de 93, y esto sirve igual.
 */
export function mesesDelAnio(serie: PanelVentas["serie"], ahora: Date): MesDelAnio[] {
  const [anio, mesActual] = todayKey(ahora).split("-").map(Number);
  const meses: MesDelAnio[] = Array.from({ length: mesActual }, (_, i) => ({
    clave: `${anio}-${String(i + 1).padStart(2, "0")}`,
    mes: i,
    etiqueta: MESES_CORTOS[i],
    online: 0,
    tienda: 0,
    envios: 0,
    enCurso: i + 1 === mesActual,
  }));
  for (const fila of serie) {
    const clave = crmDayKey(fila.t).slice(0, 7);
    const mes = meses.find((m) => m.clave === clave);
    if (!mes) continue;
    mes.online += fila.online;
    mes.tienda += fila.tienda;
    mes.envios += fila.envios_online + fila.envios_tienda;
  }
  return meses;
}

// ---------------------------------------------------------------------------
// Rendimiento: calendario de metas
// ---------------------------------------------------------------------------

export interface DiaDeRendimiento {
  /** `YYYY-MM-DD`. */
  dia: string;
  /**
   * `"evaluado"`: un día hábil con meta, contado contra ella. `"sin_datos"`
   * (21/11/2026): un día hábil ANTERIOR al piso de los paneles; no hay con qué
   * evaluarlo, así que no lleva meta ni monto y no cuenta para nada.
   */
  estado: "evaluado" | "sin_datos";
  /** `null` solo en un día sin datos: nunca un 0 que parezca verdad. */
  logrado: number | null;
  /** `null` solo en un día sin datos. */
  meta: number | null;
  /** `null` mientras el día no termina (hoy) y en un día sin datos. */
  cumplida: boolean | null;
  enCurso: boolean;
}

/** Un día del calendario que sí se evaluó contra su meta. */
export type DiaEvaluado = DiaDeRendimiento & { estado: "evaluado"; logrado: number; meta: number };

export function esDiaEvaluado(d: DiaDeRendimiento): d is DiaEvaluado {
  return d.estado === "evaluado";
}

/** Cuántos días calendario cubre la ventana del calendario (los últimos 40, hoy incluido). */
const DIAS_DE_LA_VENTANA = 40;

/**
 * Los últimos `max` días hábiles con meta vigente. Un día cerrado, o anterior a
 * toda meta, no entra (igual que en `racha`: no corta nada ni suma). `hoy` queda
 * "en curso" y no cuenta como cumplido ni como fallado.
 *
 * Con `piso` (21/11/2026: los paneles cuentan desde el 16/11), un día hábil
 * ANTERIOR al día del piso —hasta donde llega la ventana de 40 días— sale como
 * `"sin_datos"`: la serie ya viene recortada al piso, así que sin esto el
 * calendario callaría por qué faltan días en vez de decirlo. Esos días no tienen
 * meta ni monto y los ignoran la racha, «Cumplidas», «evaluadas» y «Mejor día».
 * Sin piso el resultado es el de siempre.
 */
export function diasDeRendimiento({
  serie,
  metas,
  vista,
  horario,
  hoy,
  max = 30,
  piso = null,
}: {
  serie: PanelVentas["serie"];
  metas: MetaVenta[];
  vista: Vista;
  horario: BusinessHours;
  hoy: string;
  max?: number;
  piso?: Date | null;
}): DiaDeRendimiento[] {
  const logradoPorDia = new Map<string, number>();
  for (const fila of serie) {
    const dia = crmDayKey(fila.t);
    const monto = vista === "resumen" ? fila.online + fila.tienda : fila[vista];
    logradoPorDia.set(dia, (logradoPorDia.get(dia) ?? 0) + monto);
  }

  const desdePiso = piso === null ? null : todayKey(piso);

  const dias: DiaDeRendimiento[] = [];
  for (const dia of [...logradoPorDia.keys()].sort()) {
    if (desdePiso !== null && dia < desdePiso) continue; // lo anterior al piso se enumera aparte, como «sin datos»
    const meta = metaDelDia(metas, vista, dia, horario);
    if (meta === null || dia > hoy) continue;
    const logrado = logradoPorDia.get(dia) ?? 0;
    const enCurso = dia === hoy;
    dias.push({ dia, estado: "evaluado", logrado, meta, enCurso, cumplida: enCurso ? null : logrado >= meta });
  }

  if (desdePiso !== null) {
    const primero = shiftDayKey(hoy, -(DIAS_DE_LA_VENTANA - 1));
    for (let dia = primero; dia < desdePiso && dia <= hoy; dia = shiftDayKey(dia, 1)) {
      if (!diaAbierto(dia, horario)) continue;
      dias.push({ dia, estado: "sin_datos", logrado: null, meta: null, enCurso: false, cumplida: null });
    }
    dias.sort((a, b) => a.dia.localeCompare(b.dia));
  }
  return dias.slice(-max);
}

export function resumenDeRendimiento(dias: DiaDeRendimiento[]): {
  racha: number;
  mejor: { dia: string; logrado: number } | null;
  cumplidas: number;
  evaluadas: number;
} {
  // Un día sin datos no cuenta para nada: ni racha, ni cumplidas, ni evaluadas, ni mejor día.
  const evaluados = dias.filter(esDiaEvaluado);
  const terminados = evaluados.filter((d) => !d.enCurso);
  const mejor = evaluados.reduce<{ dia: string; logrado: number } | null>(
    (m, d) => (m === null || d.logrado > m.logrado ? { dia: d.dia, logrado: d.logrado } : m),
    null
  );
  return {
    racha: racha(terminados.map((d) => ({ dia: d.dia, logrado: d.logrado, meta: d.meta }))),
    mejor: mejor && mejor.logrado > 0 ? mejor : null,
    cumplidas: terminados.filter((d) => d.cumplida).length,
    evaluadas: terminados.length,
  };
}
