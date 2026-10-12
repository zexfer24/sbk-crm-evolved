import type { ParseResult } from "@/lib/inventory";
import { CRM_TIME_ZONE } from "@/lib/time-zone";

// ---------------------------------------------------------------------------
// Calculadora Cashea (12/10/2026, plan "Calculadora Cashea en el Inventario").
//
// Lógica pura que usa el asesor desde el modal del Inventario para contestar
// "¿cuánto pago con Cashea?". Seba (la IA) NO la usa: las cuotas que Seba le
// calculó de memoria a un cliente el 13/9/2026 salieron mal, y por eso el
// cálculo vive en código y en centavos enteros, nunca en flotantes.
//
// Todas las reglas de Cashea están en `CASHEA`: cambiar una regla es cambiar
// ese objeto, no el algoritmo.
// ---------------------------------------------------------------------------

export type NivelCashea = 1 | 2 | 3 | 4 | 5 | 6;
export type CuotasCashea = 3 | 6;

export interface ConfigCashea {
  /** Con monto ESTRICTAMENTE mayor a este (centavos) se habilitan 6 cuotas. */
  UMBRAL_6_CUOTAS_CENTS: number;
  /** Porcentaje de inicial por nivel, sin promoción. */
  INICIAL_ESTANDAR: Record<NivelCashea, number>;
  /** Porcentaje de inicial por nivel cuando Cashea baja la inicial. */
  INICIAL_BAJADA: Record<NivelCashea, number>;
  DIAS_ENTRE_CUOTAS: number;
}

/** Única fuente de las reglas de Cashea. Cambiar una regla = cambiar este objeto. */
export const CASHEA: Readonly<ConfigCashea> = {
  UMBRAL_6_CUOTAS_CENTS: 10_000,
  INICIAL_ESTANDAR: { 6: 20, 5: 20, 4: 25, 3: 30, 2: 50, 1: 60 },
  INICIAL_BAJADA: { 6: 0, 5: 10, 4: 20, 3: 30, 2: 40, 1: 50 },
  DIAS_ENTRE_CUOTAS: 14,
};

/** Del nivel más alto (menos inicial) al más bajo: el orden de la comparativa. */
export const NIVELES_CASHEA: readonly NivelCashea[] = [6, 5, 4, 3, 2, 1];

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Dólares a centavos enteros. Lo inválido (NaN, negativo, infinito) vale 0. */
export function toCents(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) return 0;
  return Math.round(usd * 100);
}

/** Un monto en centavos que no sea entero no negativo se trata como 0. */
function normalizarCents(cents: number): number {
  return Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
}

export function cuotasDisponibles(montoCents: number, config: ConfigCashea = CASHEA): CuotasCashea[] {
  return montoCents > config.UMBRAL_6_CUOTAS_CENTS ? [3, 6] : [3];
}

export function porcentajeInicial(nivel: NivelCashea, bajada: boolean, config: ConfigCashea = CASHEA): number {
  return (bajada ? config.INICIAL_BAJADA : config.INICIAL_ESTANDAR)[nivel];
}

export interface PlanCashea {
  montoCents: number;
  nivel: NivelCashea;
  pct: number;
  bajada: boolean;
  /** Cuotas efectivas (puede diferir de las pedidas: ver `ajustado`). */
  cuotas: CuotasCashea;
  /** `true` si se pidieron 6 cuotas y el monto no las habilita. */
  ajustado: boolean;
  cuotasDisponibles: CuotasCashea[];
  inicialCents: number;
  financiadoCents: number;
  /** La cuota base (todas menos la última). */
  cuotaCents: number;
  /** Largo = cuotas; la última absorbe la diferencia del redondeo. */
  montosCuotasCents: number[];
}

export function calcularCashea(
  entrada: { montoCents: number; nivel: NivelCashea; cuotas: CuotasCashea; bajada: boolean },
  config: ConfigCashea = CASHEA,
): PlanCashea {
  const montoCents = normalizarCents(entrada.montoCents);
  const disponibles = cuotasDisponibles(montoCents, config);
  const ajustado = !disponibles.includes(entrada.cuotas);
  const cuotas: CuotasCashea = ajustado ? 3 : entrada.cuotas;

  const pct = porcentajeInicial(entrada.nivel, entrada.bajada, config);
  const inicialCents = Math.round((montoCents * pct) / 100);
  const financiadoCents = montoCents - inicialCents;

  // La cuota base se trunca y la última absorbe la diferencia: así la suma
  // es exacta al centavo y ningún cliente paga de más ni de menos que el
  // total. El caso real del 13/9/2026 ($122, N3, 6 cuotas) quedó fijado en
  // el test como referencia del redondeo.
  const cuotaCents = Math.floor(financiadoCents / cuotas);
  const montosCuotasCents = Array.from({ length: cuotas }, (_, i) =>
    i < cuotas - 1 ? cuotaCents : financiadoCents - cuotaCents * (cuotas - 1),
  );

  return {
    montoCents,
    nivel: entrada.nivel,
    pct,
    bajada: entrada.bajada,
    cuotas,
    ajustado,
    cuotasDisponibles: disponibles,
    inicialCents,
    financiadoCents,
    cuotaCents,
    montosCuotasCents,
  };
}

/** `numero` 0 es la inicial, que se paga hoy. */
export interface FechaCuota {
  numero: number;
  fecha: Date;
  montoCents: number;
}

export function cronogramaCashea(plan: PlanCashea, hoy: Date, config: ConfigCashea = CASHEA): FechaCuota[] {
  const inicial: FechaCuota = { numero: 0, fecha: hoy, montoCents: plan.inicialCents };
  const cuotas = plan.montosCuotasCents.map((montoCents, i): FechaCuota => ({
    numero: i + 1,
    // Se suman milisegundos y no días de calendario porque Venezuela no tiene
    // horario de verano: 14 días son siempre 14 × 24 h en America/Caracas.
    fecha: new Date(hoy.getTime() + config.DIAS_ENTRE_CUOTAS * (i + 1) * MS_POR_DIA),
    montoCents,
  }));
  return [inicial, ...cuotas];
}

export interface FilaComparativa {
  nivel: NivelCashea;
  pct: number;
  inicialCents: number;
  cuotaCents: number;
  financiadoCents: number;
}

export function comparativaNiveles(
  montoCents: number,
  cuotas: CuotasCashea,
  bajada: boolean,
  config: ConfigCashea = CASHEA,
): FilaComparativa[] {
  // Pasa por `calcularCashea` para que la tabla use las mismas cuotas
  // efectivas que el plan (sin 6 disponibles, 3) y nunca diverja de él.
  return NIVELES_CASHEA.map((nivel) => {
    const plan = calcularCashea({ montoCents, nivel, cuotas, bajada }, config);
    return {
      nivel,
      pct: plan.pct,
      inicialCents: plan.inicialCents,
      cuotaCents: plan.cuotaCents,
      financiadoCents: plan.financiadoCents,
    };
  });
}

const montoFormatter = new Intl.NumberFormat("es-VE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  // es-VE hereda de "es" un mínimo de 2 dígitos para agrupar ("1350,00"); el
  // mostrador quiere siempre el punto de miles.
  useGrouping: "always",
});

/** "$1.350,00": coma decimal, punto de miles. */
export function formatUsd(cents: number): string {
  return `$${montoFormatter.format(cents / 100)}`;
}

const fechaFormatter = new Intl.DateTimeFormat("es-VE", {
  timeZone: CRM_TIME_ZONE,
  day: "numeric",
  month: "short",
});

/** "26 oct": día y mes corto en la zona del CRM, sin el punto que Intl suele agregar. */
export function formatFechaCuota(fecha: Date): string {
  return fechaFormatter.format(fecha).replace(/\./g, "");
}

export function mensajeWhatsApp(plan: PlanCashea, producto: string): string {
  const dias = CASHEA.DIAS_ENTRE_CUOTAS;
  const ultima = plan.montosCuotasCents[plan.cuotas - 1];
  const resto =
    ultima === plan.cuotaCents
      ? `Resto: ${plan.cuotas} cuotas de ${formatUsd(plan.cuotaCents)}, cada ${dias} días, sin intereses.`
      : `Resto: ${plan.cuotas} cuotas: ${plan.cuotas - 1} de ${formatUsd(plan.cuotaCents)} y la última de ${formatUsd(ultima)}, cada ${dias} días, sin intereses.`;
  return [
    `¡Hola! Te comparto el plan con Cashea para ${producto}:`,
    `Monto total: ${formatUsd(plan.montoCents)}`,
    `Nivel Cashea: ${plan.nivel}`,
    `Inicial (${plan.pct}%): ${formatUsd(plan.inicialCents)}`,
    resto,
    "¿Te lo apartamos?",
  ].join("\n");
}

/** Tope del monto a calcular: de sobra para cualquier compra del mostrador. */
const MAX_MONTO_USD = 1_000_000;

/**
 * Monto en DÓLARES (no centavos) escrito por el asesor. Vacío es válido
 * (`null`: todavía no hay monto). Mismo patrón que `parseWeightInput`: coma o
 * punto decimal, sin negativos; "1.234" es error a propósito, porque el punto
 * es decimal y no de miles y aceptarlo leería $1,23.
 */
export function parseMontoInput(raw: string): ParseResult<number | null> {
  const text = raw.trim().replace(",", ".");
  if (!text) return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return { ok: false, error: "Escribe un monto en dólares, con hasta dos decimales." };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: "Escribe un monto en dólares, con hasta dos decimales." };
  if (value > MAX_MONTO_USD) return { ok: false, error: "Ese monto es demasiado grande." };
  return { ok: true, value };
}
