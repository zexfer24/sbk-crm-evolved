import { TrendingUp } from "lucide-react";
import { venezuelaDate } from "@/lib/bcv-schedule";

export interface BcvRateSummary {
  rate: number;
  /** Fecha desde la que rige la tasa, según el BCV (YYYY-MM-DD). */
  rateDate: string;
  /** true cuando bcv.org.ve no respondió y se está mostrando la última guardada. */
  isStale: boolean;
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
 * El BCV publica el sábado la tasa que entra en vigencia el lunes, así que
 * durante el fin de semana la fecha de la tasa está en el futuro. Decir solo
 * "24 ago." cuando es sábado 22 se lee como un error; "rige lun 24" explica
 * por qué el número es el que es.
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
