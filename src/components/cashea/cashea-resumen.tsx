import { CASHEA, bsDeCents, formatBs, formatUsd, type PlanCashea } from "@/lib/cashea";
import "./cashea.css";

// Resumen del plan de Cashea: inicial, cuotas y financiado. No pinta el total
// (en $ ni en Bs.): lo hace quien lo use, en el mismo bloque. Sin estado.

interface CasheaResumenProps {
  plan: PlanCashea;
  bcvRate: number;
}

/** "$54,50 · Bs. 5.450,00"; sin tasa válida, solo el dólar. */
function dolaresYBolivares(cents: number, bcvRate: number): string {
  const bs = bsDeCents(cents, bcvRate);
  return bs === null ? formatUsd(cents) : `${formatUsd(cents)} · ${formatBs(bs)}`;
}

export function CasheaResumen({ plan, bcvRate }: CasheaResumenProps) {
  const ultima = plan.montosCuotasCents[plan.cuotas - 1];
  const notaCuotas = [
    ultima !== plan.cuotaCents ? `la última de ${formatUsd(ultima)}` : null,
    `cada ${CASHEA.DIAS_ENTRE_CUOTAS} días, sin intereses`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="cashea-resumen">
      <div className="cashea-resumen-fila">
        <span className="cashea-resumen-etiqueta">{`Inicial (${plan.pct}%)`}</span>
        <span className="cashea-resumen-valor lm-num">{dolaresYBolivares(plan.inicialCents, bcvRate)}</span>
      </div>
      <div className="cashea-resumen-fila">
        <span className="cashea-resumen-etiqueta">Cuotas</span>
        <span className="cashea-resumen-valor lm-num">
          {`${plan.cuotas} cuotas de ${dolaresYBolivares(plan.cuotaCents, bcvRate)}`}
          <span className="cashea-resumen-nota">{notaCuotas}</span>
        </span>
      </div>
      <div className="cashea-resumen-fila">
        <span className="cashea-resumen-etiqueta">Financiado</span>
        <span className="cashea-resumen-valor lm-num">{formatUsd(plan.financiadoCents)}</span>
      </div>
    </div>
  );
}
