import { businessStatus, type BusinessHours, type DayKey } from "@/lib/business-hours";
import type { Vista } from "@/lib/paneles/canal";
import {
  EQUIPOS_ACTIVA,
  ORIGENES_ACTIVA,
  sumaCanales,
  type CanalId,
  type CanalVentas,
  type EquipoActiva,
  type MontoCantidad,
  type OrigenActiva,
  type PanelVentas,
  type PanelVentasActivas,
  type VentanaActiva,
} from "@/lib/paneles/parse";
import { crmDayKey, shiftDayKey, todayKey } from "@/lib/sales-day";
import { crmMinuteOfDay, crmWeekday } from "@/lib/time-zone";

/**
 * Cálculos puros del Dashboard de ventas (plan "Paneles", C4, 13/11/2026): lo
 * que las tarjetas derivan de los bloques que entrega `page.tsx`. Sin React ni
 * reloj propio (todo recibe `ahora`). Regla de siempre: `null` es "no se puede
 * calcular" y la pantalla pinta «—», nunca un 0 que parezca verdad.
 */

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

/**
 * Los orígenes que alimentan cada canal (22/11/2026). El canal sale del flujo:
 * un presupuesto de Inventario es de tienda aunque lo arme un asesor online;
 * carritos y presupuestos del chat son online. El equipo (rol de quien armó la
 * venta) es otra cosa y viaja aparte en `por_equipo`.
 */
export const ORIGENES_DE_CANAL: Record<CanalId, readonly OrigenActiva[]> = {
  online: ["carrito_chat", "presupuesto_chat"],
  tienda: ["presupuesto_inventario"],
};

/** Los orígenes que cuentan en una vista: los tres en el resumen, los del canal en un canal. */
export function origenesDeVista(vista: Vista): readonly OrigenActiva[] {
  return vista === "resumen" ? ORIGENES_ACTIVA : ORIGENES_DE_CANAL[vista];
}

export const ETIQUETA_ORIGEN: Record<OrigenActiva, string> = {
  carrito_chat: "Carritos del chat",
  presupuesto_chat: "Presupuestos del chat",
  presupuesto_inventario: "Presupuestos de Inventario",
};

export const ETIQUETA_EQUIPO: Record<EquipoActiva, string> = {
  online: "Asesores online",
  tienda: "Tienda (caja)",
  sin_dato: "Sin dato",
};

export const ETIQUETA_VENTANA: Record<VentanaActiva, string> = {
  abierta: "Abierta",
  por_cerrar: "Por cerrar",
  cerrada: "Cerrada",
  no_aplica: "Sin chat",
};

export interface DesgloseActivas {
  monto: number | null;
  cantidad: number;
  presupuestos: { monto: number | null; cantidad: number };
  carritos: { monto: number | null; cantidad: number };
  /** `null` en los cuatro de abajo con una base que todavía no trae el desglose. */
  porOrigen: Record<OrigenActiva, MontoCantidad> | null;
  porEquipo: Record<EquipoActiva, MontoCantidad> | null;
  porVentana: Record<VentanaActiva, MontoCantidad> | null;
  /** Ventas que quedaron fuera de la ventana de 48 h (no se cuentan arriba). */
  fuera: number | null;
}

function restar(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return centavos(Math.max(0, a - b));
}

/** Suma celdas: el monto es `null` solo si TODAS lo son; la cantidad siempre suma. */
function sumarCeldas(celdas: MontoCantidad[]): MontoCantidad {
  const conMonto = celdas.filter((c) => c.monto !== null);
  return {
    monto: conMonto.length === 0 ? null : centavos(conMonto.reduce((t, c) => t + (c.monto as number), 0)),
    cantidad: celdas.reduce((t, c) => t + c.cantidad, 0),
  };
}

const celdaVacia = (): MontoCantidad => ({ monto: null, cantidad: 0 });
const soloMontoYCantidad = (c: MontoCantidad): MontoCantidad => ({ monto: c.monto, cantidad: c.cantidad });

/**
 * Lo que sigue en curso según la vista. Con el desglose de la base (22/11/2026)
 * todo sale de sus agregados: por canal se suman SOLO los orígenes del canal
 * (canal != equipo: un presupuesto de Inventario armado por un asesor online es
 * de la vista Tienda y suma al equipo «Asesores online» solo en el resumen).
 *
 * Sin desglose (base vieja) el contrato solo trae el reparto
 * presupuestos/carritos del total; por canal viene un monto y una cantidad.
 * Como los carritos son SIEMPRE del chat (online) y los presupuestos de tienda
 * son todo lo de tienda: tienda = solo presupuestos; online = los carritos más
 * lo que sobra del canal.
 */
export function desgloseActivas(a: PanelVentasActivas, vista: Vista): DesgloseActivas {
  const dg = a.desglose;
  if (dg) {
    if (vista === "resumen") {
      return {
        monto: a.total,
        cantidad: a.presupuestos.cantidad + a.carritos.cantidad,
        presupuestos: { monto: a.presupuestos.monto, cantidad: a.presupuestos.cantidad },
        carritos: { monto: a.carritos.monto, cantidad: a.carritos.cantidad },
        porOrigen: {
          carrito_chat: soloMontoYCantidad(dg.por_origen.carrito_chat),
          presupuesto_chat: soloMontoYCantidad(dg.por_origen.presupuesto_chat),
          presupuesto_inventario: soloMontoYCantidad(dg.por_origen.presupuesto_inventario),
        },
        porEquipo: dg.por_equipo,
        porVentana: dg.por_ventana,
        fuera: dg.fuera_de_ventana.carritos + dg.fuera_de_ventana.presupuestos,
      };
    }
    const delCanal = ORIGENES_DE_CANAL[vista];
    const porEquipo = {} as Record<EquipoActiva, MontoCantidad>;
    for (const e of EQUIPOS_ACTIVA) porEquipo[e] = sumarCeldas(delCanal.map((o) => dg.por_origen_equipo[o][e]));
    const porOrigen = {} as Record<OrigenActiva, MontoCantidad>;
    for (const o of ORIGENES_ACTIVA) porOrigen[o] = delCanal.includes(o) ? soloMontoYCantidad(dg.por_origen[o]) : celdaVacia();
    return {
      monto: a.por_canal[vista].monto,
      cantidad: a.por_canal[vista].cantidad,
      presupuestos: sumarCeldas(delCanal.filter((o) => o !== "carrito_chat").map((o) => dg.por_origen[o])),
      carritos: vista === "online" ? soloMontoYCantidad(dg.por_origen.carrito_chat) : { monto: 0, cantidad: 0 },
      porOrigen,
      porEquipo,
      porVentana: dg.por_canal_ventana[vista],
      fuera: delCanal.reduce((t, o) => t + dg.fuera_de_ventana.por_origen[o], 0),
    };
  }

  const sinDesglose = { porOrigen: null, porEquipo: null, porVentana: null, fuera: null };
  if (vista === "resumen") {
    return {
      monto: a.total,
      cantidad: a.presupuestos.cantidad + a.carritos.cantidad,
      presupuestos: { monto: a.presupuestos.monto, cantidad: a.presupuestos.cantidad },
      carritos: { monto: a.carritos.monto, cantidad: a.carritos.cantidad },
      ...sinDesglose,
    };
  }
  const canal = a.por_canal[vista];
  if (vista === "tienda") {
    return {
      monto: canal.monto,
      cantidad: canal.cantidad,
      presupuestos: { monto: canal.monto, cantidad: canal.cantidad },
      carritos: { monto: 0, cantidad: 0 },
      ...sinDesglose,
    };
  }
  return {
    monto: canal.monto,
    cantidad: canal.cantidad,
    presupuestos: { monto: restar(canal.monto, a.carritos.monto), cantidad: Math.max(0, canal.cantidad - a.carritos.cantidad) },
    carritos: { monto: a.carritos.monto, cantidad: a.carritos.cantidad },
    ...sinDesglose,
  };
}

/**
 * Los orígenes que se pintan como fila en la tarjeta y en la hoja (22/11/2026):
 * los de la vista, salvo los presupuestos del chat mientras no haya ninguno
 * (hoy en producción todo son carritos y esa fila sería puro ruido). El
 * presupuesto de Inventario sí se pinta en el resumen aunque esté en 0, y no
 * en la vista Online, que no lo cuenta. Sin desglose (base vieja) no hay filas.
 */
export function origenesConFila(d: DesgloseActivas, vista: Vista): OrigenActiva[] {
  const porOrigen = d.porOrigen;
  if (!porOrigen) return [];
  return origenesDeVista(vista).filter((o) => o !== "presupuesto_chat" || porOrigen[o].cantidad > 0);
}

/**
 * «Ventana abierta» de la tarjeta: lo que todavía se puede escribir al cliente
 * sin plantilla, o sea abierta MÁS por cerrar. El monto es `null` solo si los
 * dos lo son.
 */
export function ventanaEscribible(porVentana: Record<VentanaActiva, MontoCantidad>): MontoCantidad {
  return sumarCeldas([porVentana.abierta, porVentana.por_cerrar]);
}

/** Los ítems de la vista, del más viejo al más nuevo (el servidor ya los manda así; no se confía). */
export function itemsDeVista(a: PanelVentasActivas, vista: Vista): PanelVentasActivas["items"] {
  return a.items
    .filter((i) => vista === "resumen" || i.canal === vista)
    .sort((x, y) => new Date(x.desde).getTime() - new Date(y.desde).getTime());
}

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Lo que lleva más de 24 h sin moverse: sale del conteo de 48 h en menos de un
 * día (22/11/2026). En el resumen con desglose lo dice el tramo «48h» de la
 * base; en un canal, o sin desglose, se cuentan los ítems de la vista (la lista
 * trae hasta 300, más que lo que cabe en 48 h).
 */
export function cantidadPorVencer(a: PanelVentasActivas, vista: Vista, ahora: Date): number {
  if (vista === "resumen" && a.desglose) return a.desglose.tramos_48h.find((t) => t.tramo === "48h")?.cantidad ?? 0;
  return itemsDeVista(a, vista).filter((i) => ahora.getTime() - new Date(i.desde).getTime() > DIA_MS).length;
}

const HORA_MS = 60 * 60 * 1000;

/**
 * Cuánto le queda a la ventana de 24 h de WhatsApp de una venta activa:
 * «quedan 3 h» (hacia abajo), «queda menos de 1 h», «Cerrada», «Sin chat» o «—»
 * si no se sabe. Una ventana que ya pasó pero todavía figura abierta (desfase
 * de segundos entre la base y el reloj) se lee «queda menos de 1 h».
 */
export function textoVentana(item: PanelVentasActivas["items"][number], ahora: Date): string {
  if (item.ventana === "cerrada") return ETIQUETA_VENTANA.cerrada;
  if (item.ventana === "no_aplica") return ETIQUETA_VENTANA.no_aplica;
  if (item.ventana === "abierta" || item.ventana === "por_cerrar") {
    if (!item.ventana_hasta) return "—";
    const horas = Math.floor((new Date(item.ventana_hasta).getTime() - ahora.getTime()) / HORA_MS);
    return horas < 1 ? "queda menos de 1 h" : `quedan ${horas} h`;
  }
  return "—";
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
