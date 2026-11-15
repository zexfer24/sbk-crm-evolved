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
    // El servidor los entrega del más viejo al más nuevo; los tests desordenan a propósito cuando hace falta.
    items: [
      { tipo: "presupuesto", id: "p-viejo", canal: "tienda", responsable: "Caja 1", cliente: "Pedro Pérez", monto: 100, unidades: 2, desde: "2026-11-01T10:00:00-04:00" },
      { tipo: "carrito", id: "c-medio", canal: "online", responsable: "Asesor 1", cliente: "Ana Gómez", monto: 100, unidades: 1, desde: "2026-11-08T10:00:00-04:00" },
      { tipo: "presupuesto", id: "p-medio", canal: "tienda", responsable: "Caja 1", cliente: "Luis Rojas", monto: 150, unidades: 3, desde: "2026-11-10T10:00:00-04:00" },
      { tipo: "carrito", id: "c-nuevo", canal: "online", responsable: "Asesor 2", cliente: "Rosa Díaz", monto: 250, unidades: 4, desde: "2026-11-13T09:00:00-04:00" },
      { tipo: "presupuesto", id: "p-nuevo", canal: "online", responsable: "Asesor 2", cliente: "Marta Silva", monto: null, unidades: 1, desde: "2026-11-13T12:00:00-04:00" },
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
  const rangos = rangosDelDashboard("hoy", AHORA);
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
