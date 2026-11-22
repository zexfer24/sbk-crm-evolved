import type { BusinessHours } from "@/lib/business-hours";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";
import type { Bloque, BloqueConTope } from "@/lib/paneles-data";
import { rangosDelDashboard } from "@/lib/paneles/rangos";
import type {
  CanalVentas,
  MetaVenta,
  PanelConversaciones,
  PanelVentas,
  PanelVentasActivas,
} from "@/lib/paneles/parse";
import type { DashboardViewProps } from "@/components/paneles/dashboard-view";

/**
 * Datos de prueba del Dashboard (plan "Paneles", C4, 13/11/2026). Respetan la
 * forma de `docs/paneles-contrato.md`; los tests parten de este caso y le
 * cambian solo lo que les importa. Solo los usan los tests.
 */

/** Viernes 13/11/2026, 6:30 pm en Caracas (la tienda abre de lunes a viernes, 8 a 18). */
export const AHORA = new Date("2026-11-13T18:30:00-04:00");
/** Domingo 15/11/2026: la tienda no abre. */
export const AHORA_DOMINGO = new Date("2026-11-15T11:00:00-04:00");

export const ok = <T,>(dato: T): Bloque<T> => ({ ok: true, dato });
export const caido = (detalle = "No se pudo leer las ventas."): Bloque<never> => ({
  ok: false,
  motivo: "error",
  detalle,
});

export function canal(extra: Partial<CanalVentas> = {}): CanalVentas {
  return { ingresos: 0, envios: 0, unidades: 0, ticket: null, estimados: 0, sin_monto: 0, ...extra };
}

export function ventas(extra: Partial<PanelVentas> = {}): PanelVentas {
  return {
    granularidad: "dia",
    canales: {
      online: canal({ ingresos: 800, envios: 8, unidades: 20, ticket: 100 }),
      tienda: canal({ ingresos: 434.5, envios: 5, unidades: 9, ticket: 86.9 }),
    },
    serie: [
      { t: "2026-11-11T00:00:00-04:00", online: 200, tienda: 100, envios_online: 2, envios_tienda: 1 },
      { t: "2026-11-12T00:00:00-04:00", online: 300, tienda: 150, envios_online: 3, envios_tienda: 2 },
      { t: "2026-11-13T00:00:00-04:00", online: 300, tienda: 184.5, envios_online: 3, envios_tienda: 2 },
    ],
    perfil_horario: [],
    personas: [
      { agent_id: "a1", nombre: "Asesor 1", rol: "agent", canal: "online", ingresos: 500, envios: 5, unidades: 12 },
      { agent_id: "a2", nombre: "Asesor 2", rol: "agent", canal: "online", ingresos: 300, envios: 3, unidades: 8 },
      { agent_id: "c1", nombre: "Caja 1", rol: "caja", canal: "tienda", ingresos: 434.5, envios: 5, unidades: 9 },
    ],
    top_repuestos: [
      { codprod: "LF09", nombre: "Pastillas de freno SBR", unidades: 14, ingresos: 420, unidades_online: 10, unidades_tienda: 4 },
      { codprod: "AC01", nombre: "Aceite 20W50", unidades: 9, ingresos: 180, unidades_online: 2, unidades_tienda: 7 },
    ],
    tipo_precio: { online: { promocion: 2, estandar: 6 }, tienda: { promocion: 1, estandar: 4 } },
    estado: { transito: { envios: 0, monto: null }, error: { envios: 0 }, sin_foto: 0, duplicados: 0 },
    recurrentes: {
      online: { compradores: 0, regresan: 0 },
      tienda: { compradores: 0, regresan: 0 },
      genericos_excluidos: 0,
    },
    ...extra,
  };
}

/** Ventas de hoy por hora: 5 ventas repartidas entre las 9 y las 14; la serie llega hasta las 18. */
export function ventasHoy(extra: Partial<PanelVentas> = {}): PanelVentas {
  const montos: Record<number, [number, number]> = { 9: [100, 0], 11: [200, 50], 14: [150, 100] };
  const serie = Array.from({ length: 19 }, (_, h) => {
    const [online, tienda] = montos[h] ?? [0, 0];
    const hh = String(h).padStart(2, "0");
    return {
      t: `2026-11-13T${hh}:00:00-04:00`,
      online,
      tienda,
      envios_online: online > 0 ? 1 : 0,
      envios_tienda: tienda > 0 ? 1 : 0,
    };
  });
  return ventas({
    granularidad: "hora",
    canales: {
      online: canal({ ingresos: 450, envios: 3, unidades: 6, ticket: 150 }),
      tienda: canal({ ingresos: 150, envios: 2, unidades: 3, ticket: 75 }),
    },
    serie,
    ...extra,
  });
}

/** `n` días de historia, todos con la misma forma horaria: la mitad a las 10 y la mitad a las 15. */
export function historia(n: number): PanelVentas {
  const perfil = Array.from({ length: n }, (_, i) => {
    const dia = `2026-10-${String(1 + i).padStart(2, "0")}`;
    const online = Array<number>(24).fill(0);
    online[10] = 100;
    online[15] = 100;
    return { dia, online, tienda: Array<number>(24).fill(0) };
  });
  return ventas({ serie: [], perfil_horario: perfil });
}

/** Los campos que un ítem trae desde el 22/11/2026; en null es lo que entrega una base sin la migración. */
const SIN_DESGLOSE_ITEM = { origen: null, equipo: null, ventana: null, ventana_hasta: null, conversation_id: null } as const;

/** Domingo 22/11/2026, 12:00 en Caracas: el «ahora» de los fixtures con desglose (sin depender del reloj real). */
export const AHORA_ACTIVAS = new Date("2026-11-22T12:00:00-04:00");

const hace = (horas: number) => new Date(AHORA_ACTIVAS.getTime() - horas * 3600_000).toISOString();
const en = (horas: number) => new Date(AHORA_ACTIVAS.getTime() + horas * 3600_000).toISOString();

type ItemActiva = PanelVentasActivas["items"][number];
type Celda = { monto: number | null; cantidad: number };
const vacia = (): Celda => ({ monto: null, cantidad: 0 });
const ventanasVacias = () => ({ abierta: vacia(), por_cerrar: vacia(), cerrada: vacia(), no_aplica: vacia() });
const equiposVacios = () => ({ online: vacia(), tienda: vacia(), sin_dato: vacia() });

/**
 * Como la RPC nueva: presupuestos y carritos de varios orígenes, equipos y
 * ventanas, TODO coherente (los agregados cuadran con los ítems y entre sí;
 * `calculos.test.ts` lo verifica para que nadie lo rompa). Los montos del
 * ejemplo: total 700 en 7 ítems (online 460 en 5, tienda 240 en 2), un ítem
 * sin precio, un presupuesto de Inventario armado por un ASESOR (equipo
 * online, canal tienda) y otro por una caja (equipo tienda).
 */
export function activasConDesglose(extra: Partial<PanelVentasActivas> = {}): PanelVentasActivas {
  const items: ItemActiva[] = [
    // Del más viejo al más nuevo, como los entrega el servidor.
    { tipo: "carrito", id: "c-cerrado", canal: "online", responsable: "Asesor 2", cliente: "Rosa Díaz", monto: 60, unidades: 1, desde: hace(30), origen: "carrito_chat", equipo: "sin_dato", ventana: "cerrada", ventana_hasta: hace(6), conversation_id: "conv-c-cerrado" },
    { tipo: "presupuesto", id: "p-inv-asesor", canal: "tienda", responsable: "Asesor 1", cliente: "Luis Rojas", monto: 90, unidades: 2, desde: hace(26), origen: "presupuesto_inventario", equipo: "online", ventana: "no_aplica", ventana_hasta: null, conversation_id: null },
    { tipo: "carrito", id: "c-por-cerrar", canal: "online", responsable: "Asesor 1", cliente: "Ana Gómez", monto: 80, unidades: 1, desde: hace(20), origen: "carrito_chat", equipo: "online", ventana: "por_cerrar", ventana_hasta: en(2.5), conversation_id: "conv-c-por-cerrar" },
    { tipo: "presupuesto", id: "p-chat", canal: "online", responsable: "Asesor 1", cliente: "Marta Silva", monto: 200, unidades: 3, desde: hace(10), origen: "presupuesto_chat", equipo: "online", ventana: "abierta", ventana_hasta: en(10), conversation_id: "conv-p-chat" },
    { tipo: "presupuesto", id: "p-inv-caja", canal: "tienda", responsable: "Caja 1", cliente: "Pedro Pérez", monto: 150, unidades: 4, desde: hace(5), origen: "presupuesto_inventario", equipo: "tienda", ventana: "no_aplica", ventana_hasta: null, conversation_id: null },
    { tipo: "carrito", id: "c-abierto", canal: "online", responsable: "Asesor 1", cliente: "Julia Pino", monto: 120, unidades: 2, desde: hace(3), origen: "carrito_chat", equipo: "online", ventana: "abierta", ventana_hasta: en(10), conversation_id: "conv-c-abierto" },
    { tipo: "carrito", id: "c-sin-precio", canal: "online", responsable: "Asesor 2", cliente: null, monto: null, unidades: 1, desde: hace(1), origen: "carrito_chat", equipo: "online", ventana: "abierta", ventana_hasta: en(23), conversation_id: "conv-c-sin-precio" },
  ];
  return {
    total: 700,
    presupuestos: { monto: 440, cantidad: 3, sin_precio: 0 },
    carritos: { monto: 260, cantidad: 4, sin_precio: 1 },
    por_canal: { online: { monto: 460, cantidad: 5 }, tienda: { monto: 240, cantidad: 2 } },
    antiguedad: [
      { tramo: "24h", monto: 550, cantidad: 5 },
      { tramo: "3d", monto: 150, cantidad: 2 },
      { tramo: "7d", monto: null, cantidad: 0 },
      { tramo: "30d", monto: null, cantidad: 0 },
    ],
    desglose: {
      tramos_48h: [
        { tramo: "12h", monto: 470, cantidad: 4 },
        { tramo: "24h", monto: 80, cantidad: 1 },
        { tramo: "48h", monto: 150, cantidad: 2 },
      ],
      fuera_de_ventana: { carritos: 2, presupuestos: 4, por_origen: { carrito_chat: 2, presupuesto_chat: 1, presupuesto_inventario: 3 } },
      por_origen: {
        carrito_chat: { monto: 260, cantidad: 4, sin_precio: 1 },
        presupuesto_chat: { monto: 200, cantidad: 1, sin_precio: 0 },
        presupuesto_inventario: { monto: 240, cantidad: 2, sin_precio: 0 },
      },
      por_equipo: { online: { monto: 490, cantidad: 5 }, tienda: { monto: 150, cantidad: 1 }, sin_dato: { monto: 60, cantidad: 1 } },
      por_origen_equipo: {
        carrito_chat: { ...equiposVacios(), online: { monto: 200, cantidad: 3 }, sin_dato: { monto: 60, cantidad: 1 } },
        presupuesto_chat: { ...equiposVacios(), online: { monto: 200, cantidad: 1 } },
        presupuesto_inventario: { ...equiposVacios(), online: { monto: 90, cantidad: 1 }, tienda: { monto: 150, cantidad: 1 } },
      },
      por_ventana: {
        abierta: { monto: 320, cantidad: 3 },
        por_cerrar: { monto: 80, cantidad: 1 },
        cerrada: { monto: 60, cantidad: 1 },
        no_aplica: { monto: 240, cantidad: 2 },
      },
      por_canal_ventana: {
        online: { ...ventanasVacias(), abierta: { monto: 320, cantidad: 3 }, por_cerrar: { monto: 80, cantidad: 1 }, cerrada: { monto: 60, cantidad: 1 } },
        tienda: { ...ventanasVacias(), no_aplica: { monto: 240, cantidad: 2 } },
      },
    },
    items,
    ...extra,
  };
}

/**
 * Producción tal como está hoy: todo son carritos del chat, no hay
 * presupuestos, el equipo «tienda» y «sin dato» están en 0 y hay varias
 * ventanas. Total 260 en 4 carritos, todos online.
 */
export function activasComoHoy(extra: Partial<PanelVentasActivas> = {}): PanelVentasActivas {
  const items: ItemActiva[] = [
    { tipo: "carrito", id: "h-cerrado", canal: "online", responsable: "Asesor 1", cliente: "Rosa Díaz", monto: 30, unidades: 1, desde: hace(40), origen: "carrito_chat", equipo: "online", ventana: "cerrada", ventana_hasta: hace(16), conversation_id: "conv-h-cerrado" },
    { tipo: "carrito", id: "h-por-cerrar", canal: "online", responsable: "Asesor 2", cliente: "Ana Gómez", monto: 50, unidades: 2, desde: hace(18), origen: "carrito_chat", equipo: "online", ventana: "por_cerrar", ventana_hasta: en(3), conversation_id: "conv-h-por-cerrar" },
    { tipo: "carrito", id: "h-abierto-1", canal: "online", responsable: "Asesor 1", cliente: "Julia Pino", monto: 80, unidades: 1, desde: hace(6), origen: "carrito_chat", equipo: "online", ventana: "abierta", ventana_hasta: en(15), conversation_id: "conv-h-abierto-1" },
    { tipo: "carrito", id: "h-abierto-2", canal: "online", responsable: "Asesor 2", cliente: "Luis Rojas", monto: 100, unidades: 3, desde: hace(2), origen: "carrito_chat", equipo: "online", ventana: "abierta", ventana_hasta: en(20), conversation_id: "conv-h-abierto-2" },
  ];
  return {
    total: 260,
    presupuestos: { monto: null, cantidad: 0, sin_precio: 0 },
    carritos: { monto: 260, cantidad: 4, sin_precio: 0 },
    por_canal: { online: { monto: 260, cantidad: 4 }, tienda: vacia() },
    antiguedad: [
      { tramo: "24h", monto: 230, cantidad: 3 },
      { tramo: "3d", monto: 30, cantidad: 1 },
      { tramo: "7d", monto: null, cantidad: 0 },
      { tramo: "30d", monto: null, cantidad: 0 },
    ],
    desglose: {
      tramos_48h: [
        { tramo: "12h", monto: 180, cantidad: 2 },
        { tramo: "24h", monto: 50, cantidad: 1 },
        { tramo: "48h", monto: 30, cantidad: 1 },
      ],
      fuera_de_ventana: { carritos: 5, presupuestos: 0, por_origen: { carrito_chat: 5, presupuesto_chat: 0, presupuesto_inventario: 0 } },
      por_origen: {
        carrito_chat: { monto: 260, cantidad: 4, sin_precio: 0 },
        presupuesto_chat: { monto: null, cantidad: 0, sin_precio: 0 },
        presupuesto_inventario: { monto: null, cantidad: 0, sin_precio: 0 },
      },
      por_equipo: { ...equiposVacios(), online: { monto: 260, cantidad: 4 } },
      por_origen_equipo: {
        carrito_chat: { ...equiposVacios(), online: { monto: 260, cantidad: 4 } },
        presupuesto_chat: equiposVacios(),
        presupuesto_inventario: equiposVacios(),
      },
      por_ventana: {
        abierta: { monto: 180, cantidad: 2 },
        por_cerrar: { monto: 50, cantidad: 1 },
        cerrada: { monto: 30, cantidad: 1 },
        no_aplica: vacia(),
      },
      por_canal_ventana: {
        online: {
          abierta: { monto: 180, cantidad: 2 },
          por_cerrar: { monto: 50, cantidad: 1 },
          cerrada: { monto: 30, cantidad: 1 },
          no_aplica: vacia(),
        },
        tienda: ventanasVacias(),
      },
    },
    items,
    ...extra,
  };
}

export function activas(extra: Partial<PanelVentasActivas> = {}): PanelVentasActivas {
  return {
    total: 600,
    presupuestos: { monto: 400, cantidad: 3, sin_precio: 0 },
    carritos: { monto: 200, cantidad: 2, sin_precio: 0 },
    por_canal: { online: { monto: 350, cantidad: 3 }, tienda: { monto: 250, cantidad: 2 } },
    antiguedad: [
      { tramo: "24h", monto: 300, cantidad: 2 },
      { tramo: "3d", monto: 100, cantidad: 1 },
      { tramo: "7d", monto: 100, cantidad: 1 },
      { tramo: "30d", monto: 100, cantidad: 1 },
    ],
    desglose: null,
    // El servidor los entrega del más viejo al más nuevo; los tests desordenan a propósito cuando hace falta.
    items: [
      { tipo: "presupuesto", id: "p-viejo", canal: "tienda", responsable: "Caja 1", cliente: "Pedro Pérez", monto: 100, unidades: 2, desde: "2026-11-01T10:00:00-04:00", ...SIN_DESGLOSE_ITEM },
      { tipo: "carrito", id: "c-medio", canal: "online", responsable: "Asesor 1", cliente: "Ana Gómez", monto: 100, unidades: 1, desde: "2026-11-08T10:00:00-04:00", ...SIN_DESGLOSE_ITEM },
      { tipo: "presupuesto", id: "p-medio", canal: "tienda", responsable: "Caja 1", cliente: "Luis Rojas", monto: 150, unidades: 3, desde: "2026-11-10T10:00:00-04:00", ...SIN_DESGLOSE_ITEM },
      { tipo: "carrito", id: "c-nuevo", canal: "online", responsable: "Asesor 2", cliente: "Rosa Díaz", monto: 250, unidades: 4, desde: "2026-11-13T09:00:00-04:00", ...SIN_DESGLOSE_ITEM },
      { tipo: "presupuesto", id: "p-nuevo", canal: "online", responsable: "Asesor 2", cliente: "Marta Silva", monto: null, unidades: 1, desde: "2026-11-13T12:00:00-04:00", ...SIN_DESGLOSE_ITEM },
    ],
    ...extra,
  };
}

export function conversaciones(extra: Partial<PanelConversaciones> = {}): BloqueConTope<PanelConversaciones> {
  const dato: PanelConversaciones = {
    embudo: { escribieron: 50, respondidas: 40, con_carrito: 12, compraron: 8 },
    resultados: { compraron: 8, reclamo: 1, carrito_sin_compra: 4, solo_preguntaron: 27, sin_respuesta: 10 },
    conversion: {
      equipo: { atendidas: 40, compraron: 8 },
      personas: [
        { agent_id: "a1", nombre: "Asesor 1", rol: "agent", atendidas: 20, compraron: 6 },
        { agent_id: "a2", nombre: "Asesor 2", rol: "agent", atendidas: 10, compraron: 1 },
        { agent_id: null, nombre: "Seba", rol: "ia", atendidas: 10, compraron: 1 },
      ],
    },
    calor: { valores: Array.from({ length: 7 }, () => Array<number>(24).fill(0)) },
    ...extra,
  };
  return { ok: true, dato, recortado: false };
}

export const METAS: MetaVenta[] = [
  { canal: "online", vigente_desde: "2026-10-01", monto_usd: 2000 },
  { canal: "tienda", vigente_desde: "2026-10-01", monto_usd: 1000 },
];

export function propsBase(extra: Partial<DashboardViewProps> = {}): DashboardViewProps {
  const rangos = rangosDelDashboard("hoy", AHORA, null);
  const horario: BusinessHours = DEFAULT_BUSINESS_HOURS;
  return {
    periodo: "hoy",
    vista: "resumen",
    ahora: AHORA,
    rangos,
    ventas: ok(ventas()),
    ventasPrevio: ok(
      ventas({
        canales: {
          online: canal({ ingresos: 600, envios: 5, unidades: 10, ticket: 120 }),
          tienda: canal({ ingresos: 500, envios: 5, unidades: 10, ticket: 100 }),
        },
      })
    ),
    ventasHoy: ok(ventasHoy()),
    ventasHistoria: ok(historia(12)),
    ventasAnio: ok(
      ventas({
        granularidad: "dia",
        serie: [
          { t: "2026-09-15T00:00:00-04:00", online: 1000, tienda: 500, envios_online: 10, envios_tienda: 5 },
          { t: "2026-10-15T00:00:00-04:00", online: 2000, tienda: 800, envios_online: 20, envios_tienda: 8 },
          { t: "2026-11-12T00:00:00-04:00", online: 800, tienda: 434.5, envios_online: 8, envios_tienda: 5 },
        ],
      })
    ),
    ventasActivas: ok(activas()),
    metas: ok(METAS),
    horario,
    conversaciones: conversaciones(),
    tasaBcv: 40,
    ...extra,
  };
}
