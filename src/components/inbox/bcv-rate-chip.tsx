import { TrendingUp, TriangleAlert } from "lucide-react";
import { venezuelaDate } from "@/lib/bcv-schedule";
import { formatearDesde, type BcvAlerta } from "@/lib/bcv-alerta";

export interface BcvRateSummary {
  rate: number;
  /** Fecha desde la que rige la tasa, según el BCV (YYYY-MM-DD). */
  rateDate: string;
  /** true cuando bcv.org.ve no respondió y se está mostrando la última guardada. */
  isStale: boolean;
  /**
   * Más de 8 h sin una lectura buena del BCV (`alertaDeTasa`). Ausente o `null`
   * = sin alerta, o sin tabla de estado todavía: el chip se ve como siempre.
   */
  alerta?: BcvAlerta | null;
}

const BS_FORMAT = new Intl.NumberFormat("es-VE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatDay(rateDate: string): string {
  // Mediodía UTC para que el día no se corra al formatear en otra zona.
  return new Date(`${rateDate}T12:00:00Z`).toLocaleDateString("es-VE", {
    day: "numeric",
    month: "short",
  });
}

/**
 * El BCV suele publicar por la tarde la tasa que entra en vigencia el día
 * hábil siguiente, así que la fecha de la tasa puede estar en el futuro —
 * hasta el 24/9/2026 eso pasaba solo el fin de semana (sábado publicando la
 * del lunes); desde el plan "La tasa BCV se lee cuatro veces al día"
 * (25/9/2026, `BCV_READ_HOURS` en `bcv-schedule.ts`) puede pasar CUALQUIER
 * día hábil, ya con la lectura de las 18:00. Decir solo "24 ago." cuando ya
 * rige el 25 se lee como un error; "rige 25 sep." explica por qué el número
 * es el que es.
 */
function describeValidity(rateDate: string): { short: string; long: string } {
  const today = venezuelaDate();
  const day = formatDay(rateDate);

  if (rateDate > today) {
    return {
      short: `rige ${day}`,
      long: `El BCV ya publicó la tasa que entra en vigencia el ${day}. Es la que se está usando.`,
    };
  }

  return { short: day, long: `Tasa oficial del BCV vigente desde el ${day}.` };
}

export function BcvRateChip({ rate }: { rate: BcvRateSummary }) {
  if (rate.alerta) return <BcvRateChipAlerta rate={rate} alerta={rate.alerta} />;

  const { short, long } = describeValidity(rate.rateDate);
  const title = rate.isStale
    ? `${long} No se pudo consultar al BCV ahora, se muestra la última guardada.`
    : long;

  return (
    <div className="crm-bcv" data-stale={rate.isStale} title={title}>
      <TrendingUp size={13} aria-hidden="true" />
      <span className="crm-bcv-label">BCV</span>
      <span className="crm-bcv-rate lm-num">{BS_FORMAT.format(rate.rate)}</span>
      <span className="crm-bcv-unit">Bs/$</span>
      <span className="crm-bcv-date">{short}</span>
    </div>
  );
}

/**
 * Desde el 19/11/2026 la lectura del BCV falló dos días seguidos y el chip
 * seguía mostrando la tasa como si nada (con una tasa cargada a mano ni
 * `isStale` se marcaba). En alerta el chip conserva el número —es la tasa con
 * la que se está cotizando— pero cambia la fecha por "sin actualizar desde …"
 * y se pinta con el rojo de peligro, distinto del ámbar de `data-stale`, que
 * solo dice "esta vez no contestó". El último error va en el title: es para
 * quien administra, no para el asesor del mostrador.
 */
function BcvRateChipAlerta({ rate, alerta }: { rate: BcvRateSummary; alerta: BcvAlerta }) {
  const desde = alerta.desde ? formatearDesde(alerta.desde) : null;
  const etiqueta = desde ? `sin actualizar desde ${desde}` : "sin actualizar";
  const accesible = desde ? `Tasa sin actualizar desde ${desde}` : "Tasa sin actualizar";
  const title =
    (desde ? `Tasa BCV sin actualizar desde ${desde}.` : "Tasa BCV sin actualizar.") +
    (alerta.ultimoError ? ` Último error: ${alerta.ultimoError}` : "");

  return (
    <div
      className="crm-bcv"
      data-stale={rate.isStale}
      data-alerta="true"
      role="group"
      aria-label={accesible}
      title={title}
    >
      <TriangleAlert size={13} aria-hidden="true" />
      <span className="crm-bcv-label">BCV</span>
      <span className="crm-bcv-rate lm-num">{BS_FORMAT.format(rate.rate)}</span>
      <span className="crm-bcv-unit">Bs/$</span>
      <span className="crm-bcv-date">{etiqueta}</span>
    </div>
  );
}
