"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { ChevronDown } from "lucide-react";
import { Button, toast } from "@heroui/react";
import {
  ELECCION_CASHEA_INICIAL,
  bsDeCents,
  calcularCashea,
  formatBs,
  formatUsd,
  mensajeWhatsApp,
  parseMontoBsInput,
  parseMontoInput,
  toCents,
  type EleccionCashea,
} from "@/lib/cashea";
import { totalesCarrito } from "@/lib/inventario-carrito";
import { usdFromBs } from "@/lib/usd-price";
import { CasheaControles } from "@/components/cashea/cashea-controles";
import { CasheaResumen } from "@/components/cashea/cashea-resumen";
import { useInventarioCarrito } from "@/components/inventario/inventario-carrito-context";
import "./mostrador.css";

/**
 * Calculadora fija del mostrador (21/10/2026, plan "Presupuestos y mensajes
 * rápidos", T5, D6). El asesor ya tenía la calculadora Cashea por producto,
 * pero el cliente también pregunta «¿cuánto es en dólares?» con un monto en
 * bolívares en la mano, o «¿cuánto pago con Cashea?» por un total que no
 * armó en el carrito. Esta queda a la vista al bajar por la lista (sticky en
 * pantalla ancha, plegable en angosta).
 *
 * De bolívares a dólares SIEMPRE con `usdFromBs` (hacia arriba al décimo,
 * a favor del negocio): nunca `bs / rate` en este archivo ni una mención al
 * redondeo en la pantalla (CLAUDE.md, 27/9/2026). De dólares a bolívares,
 * `bsDeCents`. El estado es local; lo único que se recuerda, por asesor y en
 * este navegador, es la moneda elegida.
 */

export const CLAVE_MONEDA_PREFIX = "sbk:calculadora-mostrador:moneda:v1:";

type Moneda = "bs" | "usd";

function claveMoneda(agentId: string): string {
  return `${CLAVE_MONEDA_PREFIX}${agentId}`;
}

function leerMoneda(agentId: string): Moneda | null {
  try {
    const guardada = window.localStorage.getItem(claveMoneda(agentId));
    return guardada === "bs" || guardada === "usd" ? guardada : null;
  } catch {
    // Modo privado o almacenamiento bloqueado: se usa el valor por defecto.
    return null;
  }
}

function guardarMoneda(agentId: string, moneda: Moneda): void {
  try {
    window.localStorage.setItem(claveMoneda(agentId), moneda);
  } catch {
    // Sin almacenamiento la calculadora funciona igual, solo no recuerda.
  }
}

/** `localStorage` no avisa cambios dentro de la misma pestaña; el valor se lee al montar y al cambiar de asesor. */
function suscribir(): () => void {
  return () => {};
}

interface CalculadoraMostradorProps {
  /** `0` o menos: hoy no hay tasa BCV y solo se puede escribir en dólares. */
  bcvRate: number;
  /** Total del carrito en dólares, o `null` si está vacío o algún renglón no tiene precio. */
  totalCarritoUsd: number | null;
  agentId: string;
}

export function CalculadoraMostrador({ bcvRate, totalCarritoUsd, agentId }: CalculadoraMostradorProps) {
  const sinTasa = !(bcvRate > 0);

  // La moneda recordada se lee con `useSyncExternalStore`: en el servidor y en
  // la hidratación vale `null` (arranca en Bs) y recién ahí se aplica lo guardado,
  // sin desajuste entre el HTML del servidor y el del navegador.
  const almacenada = useSyncExternalStore(
    suscribir,
    useCallback(() => leerMoneda(agentId), [agentId]),
    () => null,
  );
  const [elegida, setElegida] = useState<Moneda | null>(null);
  const moneda: Moneda = sinTasa ? "usd" : (elegida ?? almacenada ?? "bs");

  const [borrador, setBorrador] = useState("");
  const [eleccion, setEleccion] = useState<EleccionCashea>(ELECCION_CASHEA_INICIAL);
  const [abierta, setAbierta] = useState(false);

  function cambiarMoneda(nueva: Moneda) {
    if (nueva === moneda) return;
    // El número escrito en una moneda no significa lo mismo en la otra.
    setBorrador("");
    setElegida(nueva);
    guardarMoneda(agentId, nueva);
  }

  function usarTotalDelCarrito() {
    if (totalCarritoUsd === null || totalCarritoUsd <= 0) return;
    // Pasa a dólares sin recordarlo: es un atajo, no la preferencia del asesor.
    setElegida("usd");
    setBorrador(totalCarritoUsd.toFixed(2));
  }

  // En Bs se acepta el punto de miles y la coma decimal («18.524,40»); en $,
  // el parser de dólares de siempre (21/10/2026, T11).
  const parseado = moneda === "bs" ? parseMontoBsInput(borrador) : parseMontoInput(borrador);
  const errorMonto = parseado.ok ? null : parseado.error;

  const montoEscrito = parseado.ok ? parseado.value : null;
  const usd =
    montoEscrito === null ? null : moneda === "usd" ? montoEscrito : usdFromBs(montoEscrito, bcvRate);
  const montoCents = usd === null ? 0 : toCents(usd);

  const plan = calcularCashea({ montoCents, ...eleccion });

  // Si el monto baja a $100 o menos con 6 cuotas elegidas, el plan ya se calcula
  // con 3; aquí además se registra para que subir el monto de nuevo NO reviva
  // el 6 (el asesor no lo volvió a pedir). Misma regla que el carrito, hecha
  // durante el render y no en un efecto (`react-hooks/set-state-in-effect`).
  if (plan.ajustado && eleccion.cuotas !== ELECCION_CASHEA_INICIAL.cuotas) {
    setEleccion({ ...eleccion, cuotas: ELECCION_CASHEA_INICIAL.cuotas });
  }

  async function copiarPlan() {
    try {
      await navigator.clipboard.writeText(mensajeWhatsApp(plan));
      toast.success("Plan copiado");
    } catch {
      toast.danger("No se pudo copiar");
    }
  }

  const tasaTexto = bcvRate.toFixed(2);
  const bsDelMonto = bsDeCents(montoCents, bcvRate);
  const tieneTotal = totalCarritoUsd !== null && totalCarritoUsd > 0;

  return (
    <aside className="dash-panel inv-calc" aria-label="Calculadora del mostrador">
      <button
        type="button"
        className="inv-calc-toggle"
        aria-expanded={abierta}
        aria-controls="calc-cuerpo"
        onClick={() => setAbierta((v) => !v)}
      >
        <span>Calculadora</span>
        <ChevronDown size={16} aria-hidden="true" style={{ transform: abierta ? "rotate(180deg)" : undefined }} />
      </button>
      <h2 className="inv-calc-titulo">Calculadora</h2>

      <div id="calc-cuerpo" className="inv-calc-cuerpo" data-abierta={abierta ? "true" : "false"}>
        <div className="inv-calc-moneda" role="group" aria-label="Moneda del monto">
          <button
            type="button"
            className="inv-calc-opcion"
            aria-pressed={moneda === "bs"}
            disabled={sinTasa}
            onClick={() => cambiarMoneda("bs")}
          >
            Bs
          </button>
          <button
            type="button"
            className="inv-calc-opcion"
            aria-pressed={moneda === "usd"}
            onClick={() => cambiarMoneda("usd")}
          >
            $
          </button>
        </div>

        {sinTasa && <p className="inv-calc-aviso">Sin tasa BCV de hoy: escribe el monto en dólares</p>}

        <div className="inv-calc-campo">
          <label htmlFor="calc-monto">{moneda === "bs" ? "Monto en bolívares" : "Monto en dólares"}</label>
          <input
            id="calc-monto"
            className="inv-calc-input"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder={moneda === "bs" ? "Ej. 18.524,40" : "Ej. 86"}
            value={borrador}
            onChange={(e) => setBorrador(e.target.value)}
          />
        </div>
        {errorMonto && (
          <p className="inv-calc-aviso" data-tone="error">
            {errorMonto}
          </p>
        )}

        {tieneTotal && (
          <div className="inv-calc-acciones">
            <Button variant="secondary" size="sm" onPress={usarTotalDelCarrito}>
              Usar total del carrito
            </Button>
          </div>
        )}

        {usd !== null && (
          <p className="inv-calc-resultado" data-testid="calc-resultado">
            {moneda === "bs" ? (
              <>
                <small>{`÷ tasa BCV de hoy (${tasaTexto})`}</small>
                <strong className="lm-num">{formatUsd(montoCents)}</strong>
              </>
            ) : bsDelMonto !== null ? (
              <>
                <small>{`× tasa BCV de hoy (${tasaTexto})`}</small>
                <strong className="lm-num">{formatBs(bsDelMonto)}</strong>
              </>
            ) : (
              <>
                <small>Sin tasa para pasar a bolívares</small>
                <strong className="lm-num">{formatUsd(montoCents)}</strong>
              </>
            )}
          </p>
        )}

        {montoCents > 0 && (
          <>
            <CasheaControles montoCents={montoCents} eleccion={eleccion} onChange={setEleccion} />
            <CasheaResumen plan={plan} bcvRate={bcvRate} mostrarBs notaCadencia />
            <div className="inv-calc-acciones">
              <Button variant="primary" size="sm" onPress={copiarPlan}>
                Copiar plan
              </Button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * La calculadora de la vista: toma el total del carrito del contexto (el
 * componente de la vista queda por FUERA del provider, así que no puede leerlo
 * él mismo). Sin provider o con algún renglón sin precio, no hay total que
 * ofrecer.
 */
export function CalculadoraMostradorConCarrito({ bcvRate, agentId }: Omit<CalculadoraMostradorProps, "totalCarritoUsd">) {
  const carrito = useInventarioCarrito();
  const totales = carrito
    ? totalesCarrito(carrito.lineas, bcvRate, { activo: false, ...ELECCION_CASHEA_INICIAL })
    : null;
  const total = totales && totales.renglones > 0 && totales.unpricedCount === 0 ? totales.usd : null;

  return <CalculadoraMostrador bcvRate={bcvRate} totalCarritoUsd={total} agentId={agentId} />;
}
