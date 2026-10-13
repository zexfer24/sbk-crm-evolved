import type { ReactNode } from "react";
import { CASHEA, bsDeCents, formatBs, formatUsd, type PlanCashea } from "@/lib/cashea";
import "./cashea.css";

// Resumen del plan de Cashea: inicial, cada cuota y monto financiado. El
// marcado y los textos son los de la calculadora (12/10/2026, plan "Carrito de
// cotización en el Inventario, con Cashea", T7), que es la referencia; el
// carrito lo usa igual, con los bolívares al lado del dólar. Sin estado.
//
// Quien lo use puede sumar filas propias como `children` (la calculadora le
// pone "Monto total"): caen dentro del mismo `<dl>`, con la misma grilla.

interface CasheaResumenProps {
  plan: PlanCashea;
  /** Tasa BCV para los bolívares; sin tasa válida no se pinta ninguna parte en Bs. */
  bcvRate?: number;
  /** `false` en la calculadora, que no muestra bolívares. Por defecto, sí (carrito). */
  mostrarBs?: boolean;
  /** Agrega "N cuotas, cada N días, sin intereses" bajo la cuota (el carrito: el operador pidió ver el número de cuotas en el total); la calculadora lo dice en su cronograma. */
  notaCadencia?: boolean;
  children?: ReactNode;
}

export function CasheaResumen({ plan, bcvRate = 0, mostrarBs = true, notaCadencia = false, children }: CasheaResumenProps) {
  const ultimaCuotaCents = plan.montosCuotasCents[plan.cuotas - 1];

  /** Los bolívares de una cifra, en su propia línea; nada si no hay que mostrarlos o falta la tasa. */
  function bolivares(cents: number): ReactNode {
    const bs = mostrarBs ? bsDeCents(cents, bcvRate) : null;
    return bs === null ? null : <small className="cashea-resumen-sub">{formatBs(bs)}</small>;
  }

  return (
    <dl className="cashea-resumen">
      <div>
        <dt>Inicial</dt>
        <dd className="lm-num" data-testid="cashea-inicial">
          {`${formatUsd(plan.inicialCents)} (${plan.pct} %)`}
          {bolivares(plan.inicialCents)}
        </dd>
      </div>
      <div>
        <dt>Cada cuota</dt>
        <dd className="lm-num">
          {formatUsd(plan.cuotaCents)}
          {ultimaCuotaCents !== plan.cuotaCents && (
            <small className="cashea-resumen-ultima">{` · la última, ${formatUsd(ultimaCuotaCents)}`}</small>
          )}
          {bolivares(plan.cuotaCents)}
          {notaCadencia && (
            <small className="cashea-resumen-sub">{`${plan.cuotas} cuotas, cada ${CASHEA.DIAS_ENTRE_CUOTAS} días, sin intereses`}</small>
          )}
        </dd>
      </div>
      <div>
        <dt>Monto financiado</dt>
        <dd className="lm-num">{formatUsd(plan.financiadoCents)}</dd>
      </div>
      {children}
    </dl>
  );
}
