import { format } from "date-fns";
import { es } from "date-fns/locale";
import { CRM_TIME_ZONE } from "@/lib/time-zone";
import type { Sale } from "@/lib/types";

/**
 * Cortes de ventas por día de Caracas (T5, corrida "Los números del día",
 * 10/9/2026). `fetchSales` trae el histórico completo; el corte por día es
 * en memoria acá, sin tocar Supabase ni React.
 *
 * OJO: `dayKey` de `format.ts` agrupa con `new Date(iso).getFullYear()/
 * getMonth()/getDate()`, que lee el reloj del NAVEGADOR de quien mira — dos
 * asesores en dos zonas distintas verían el corte de "hoy" en un punto
 * distinto de la madrugada. Este módulo usa `Intl.DateTimeFormat` con
 * `timeZone` (la técnica de `time-zone.ts`) para que el día sea el mismo
 * para todos, sin importar dónde esté el navegador.
 */

/** `YYYY-MM-DD` del instante dado, en la zona indicada (la del equipo por default). */
export function crmDayKey(iso: string, timeZone: string = CRM_TIME_ZONE): string {
  // "en-CA" imprime `YYYY-MM-DD` directo, sin armar el string a mano con las partes.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Clave de HOY en la zona indicada. */
export function todayKey(now: Date = new Date(), timeZone: string = CRM_TIME_ZONE): string {
  return crmDayKey(now.toISOString(), timeZone);
}

/**
 * Suma (o resta) días a una clave `YYYY-MM-DD`, para las flechas ‹ › del
 * histórico. Aritmética en UTC sobre la clave misma, sin zona — la clave ya
 * es un día "plano", no un instante.
 */
export function shiftDayKey(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(
    shifted.getUTCDate()
  ).padStart(2, "0")}`;
}

/**
 * "10 de septiembre de 2026" para una clave `YYYY-MM-DD`. Mediodía UTC (igual
 * que `inventario-view.tsx` con `T12:00:00Z`) para que ningún huso local le
 * corra el día a `date-fns` al formatear.
 */
export function formatDayKey(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return format(new Date(Date.UTC(year, month - 1, day, 12)), "d 'de' MMMM 'de' yyyy", { locale: es });
}

/** Clave de día de una venta: por cuándo se CERRÓ, o por cuándo se creó si no cerró todavía. */
export function saleDayKey(sale: Sale, timeZone: string = CRM_TIME_ZONE): string {
  return crmDayKey(sale.dealClosedAt ?? sale.createdAt, timeZone);
}

/** Las ventas de un día exacto, más recientes primero (por cierre). */
export function salesOnDay(sales: Sale[], key: string, timeZone: string = CRM_TIME_ZONE): Sale[] {
  return sales
    .filter((sale) => saleDayKey(sale, timeZone) === key)
    .sort((a, b) => {
      const closedA = a.dealClosedAt ?? a.createdAt;
      const closedB = b.dealClosedAt ?? b.createdAt;
      return closedB.localeCompare(closedA);
    });
}

export interface SalesDaySummary {
  count: number;
  amountUsd: number;
  returned: number;
  amountVes: number;
}

function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * El resumen de un día: cuántas ventas GANADAS y su monto en dólares
 * (`closeSale` arma la orden en USD, así que un `dealCurrency` null se trata
 * como USD — nunca lo deja afuera del total), el monto ganado en VES aparte
 * (hoy no debería pasar, pero no se mezclan monedas en la misma suma) y
 * cuántas devoluciones tuvo el día.
 */
export function summarizeSalesDay(sales: Sale[], key: string, timeZone: string = CRM_TIME_ZONE): SalesDaySummary {
  const day = salesOnDay(sales, key, timeZone);

  let count = 0;
  let amountUsd = 0;
  let returned = 0;
  let amountVes = 0;

  for (const sale of day) {
    if (sale.dealStatus === "won") {
      const amount = sale.dealAmount ?? 0;
      if (sale.dealCurrency === "VES") {
        amountVes += amount;
      } else {
        // null o "USD": closeSale cierra siempre en USD.
        count += 1;
        amountUsd += amount;
      }
    } else if (sale.dealStatus === "returned") {
      returned += 1;
    }
  }

  return {
    count,
    amountUsd: roundCents(amountUsd),
    returned,
    amountVes: roundCents(amountVes),
  };
}

export interface SalesDayHistoryEntry {
  key: string;
  count: number;
  amountUsd: number;
  returned: number;
}

/**
 * Los últimos `limit` días CON ventas (cualquier estado), del más reciente
 * al más viejo. Un día sin ventas no genera fila — el histórico no rellena
 * huecos.
 */
export function salesDayHistory(
  sales: Sale[],
  limit = 30,
  timeZone: string = CRM_TIME_ZONE
): SalesDayHistoryEntry[] {
  const keys = new Set(sales.map((sale) => saleDayKey(sale, timeZone)));
  const sortedKeys = [...keys].sort((a, b) => b.localeCompare(a));

  return sortedKeys.slice(0, limit).map((key) => {
    const summary = summarizeSalesDay(sales, key, timeZone);
    return { key, count: summary.count, amountUsd: summary.amountUsd, returned: summary.returned };
  });
}
