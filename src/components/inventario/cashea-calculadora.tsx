"use client";

import { useId, useState } from "react";
import { Calculator } from "lucide-react";
import { Button, Modal, toast } from "@heroui/react";
import {
  NIVELES_CASHEA,
  calcularCashea,
  comparativaNiveles,
  cronogramaCashea,
  cuotasDisponibles,
  formatFechaCuota,
  formatUsd,
  mensajeWhatsApp,
  parseMontoInput,
  porcentajeInicial,
  toCents,
  type CuotasCashea,
  type NivelCashea,
} from "@/lib/cashea";
import { productPriceUsd } from "@/lib/sale-cart";
import type { Product } from "@/lib/types";

interface CasheaCalculadoraProps {
  product: Product;
  bcvRate: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

const NIVEL_INICIAL: NivelCashea = 6;
const CUOTAS_INICIALES: CuotasCashea = 3;

/**
 * Calculadora Cashea (12/10/2026, plan "Calculadora Cashea en el Inventario",
 * T2). El cliente pregunta "¿cuánto pago con Cashea?" y el asesor hacía la
 * cuenta a mano; el 13/9/2026 la IA la hizo de memoria y le salió mal, por eso
 * el cálculo vive en `cashea.ts` (centavos enteros) y este modal solo lo
 * pinta. Seba no pasa por acá.
 *
 * Todo el estado es local y se descarta al cerrar: no se guarda nada (ni
 * base ni localStorage). El precio sale SIEMPRE de `productPriceUsd`, el mismo
 * número que ve el asesor en la fila, el carrito y Seba.
 */
export function CasheaCalculadora({ product, bcvRate, isOpen, onOpenChange }: CasheaCalculadoraProps) {
  const ids = useId();
  const cantidadId = `${ids}-cantidad`;
  const manualId = `${ids}-manual`;

  const [cantidadDraft, setCantidadDraft] = useState("1");
  const [montoManualDraft, setMontoManualDraft] = useState("");
  const [nivel, setNivel] = useState<NivelCashea>(NIVEL_INICIAL);
  const [cuotasElegidas, setCuotasElegidas] = useState<CuotasCashea>(CUOTAS_INICIALES);
  const [bajada, setBajada] = useState(false);

  function reset() {
    setCantidadDraft("1");
    setMontoManualDraft("");
    setNivel(NIVEL_INICIAL);
    setCuotasElegidas(CUOTAS_INICIALES);
    setBajada(false);
  }

  function handleOpenChange(open: boolean) {
    if (!open) reset();
    onOpenChange(open);
  }

  const precioUnitario = productPriceUsd(product, bcvRate);

  const cantidadNum = Number(cantidadDraft);
  const cantidad = Number.isInteger(cantidadNum) && cantidadNum >= 1 ? cantidadNum : 1;

  const manual = parseMontoInput(montoManualDraft);
  const manualCents = manual.ok && manual.value !== null ? toCents(manual.value) : null;
  const montoCents = manualCents ?? (precioUnitario === null ? 0 : toCents(precioUnitario) * cantidad);

  const plan = calcularCashea({ montoCents, nivel, cuotas: cuotasElegidas, bajada });
  const seisDisponible = cuotasDisponibles(montoCents).includes(6);

  // Si el monto baja a $100 o menos con 6 elegidas, el plan ya se calcula con
  // 3; aquí además se registra, para que subir el monto de nuevo NO reviva el
  // 6 por su cuenta (el asesor no lo volvió a pedir). Se hace durante el
  // render y no en un efecto: `react-hooks/set-state-in-effect` lo prohíbe.
  if (plan.ajustado && cuotasElegidas !== CUOTAS_INICIALES) {
    setCuotasElegidas(CUOTAS_INICIALES);
  }

  const cronograma = cronogramaCashea(plan, new Date());
  const comparativa = comparativaNiveles(montoCents, plan.cuotas, bajada);
  const mensaje = mensajeWhatsApp(plan, product.name);
  const ultimaCuotaCents = plan.montosCuotasCents[plan.cuotas - 1];

  async function handleCopiar() {
    try {
      await navigator.clipboard.writeText(mensaje);
      toast.success("Plan copiado");
    } catch {
      toast.danger("No se pudo copiar");
    }
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={handleOpenChange}>
      <Modal.Backdrop>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon>
                <Calculator size={18} />
              </Modal.Icon>
              <Modal.Heading>Calcular con Cashea</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="inv-cashea-body">
              <p className="inv-cashea-producto">{product.name}</p>

              <div className="inv-cashea-montos">
                <div className="inv-cashea-campo">
                  <label htmlFor={cantidadId}>Cantidad</label>
                  <input
                    id={cantidadId}
                    className="inv-cashea-input"
                    type="number"
                    min={1}
                    step={1}
                    value={cantidadDraft}
                    onChange={(e) => setCantidadDraft(e.target.value)}
                  />
                </div>
                <div className="inv-cashea-campo">
                  <label htmlFor={manualId}>Monto manual ($)</label>
                  <input
                    id={manualId}
                    className="inv-cashea-input"
                    inputMode="decimal"
                    placeholder="Opcional"
                    value={montoManualDraft}
                    onChange={(e) => setMontoManualDraft(e.target.value)}
                  />
                </div>
              </div>
              {!manual.ok && (
                <p className="inv-cashea-aviso" data-tone="error">
                  {manual.error}
                </p>
              )}
              {montoManualDraft.trim() !== "" && (
                <Button variant="secondary" size="sm" onPress={() => setMontoManualDraft("")}>
                  Usar precio del producto
                </Button>
              )}

              {precioUnitario !== null ? (
                <p className="inv-cashea-nota">
                  Precio unitario {formatUsd(toCents(precioUnitario))} × {cantidad}
                </p>
              ) : (
                <p className="inv-cashea-aviso" role="status">
                  Sin tasa BCV: escribe el monto en dólares
                </p>
              )}

              <p className="inv-cashea-monto">
                <span>Monto a financiar</span>
                <strong className="lm-num" data-testid="cashea-monto">
                  {formatUsd(montoCents)}
                </strong>
              </p>

              <div className="inv-cashea-bloque">
                <span className="lm-eyebrow">Nivel Cashea</span>
                <div className="inv-cashea-niveles" role="radiogroup" aria-label="Nivel Cashea">
                  {NIVELES_CASHEA.map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={nivel === n}
                      className="inv-cashea-opcion"
                      onClick={() => setNivel(n)}
                    >
                      {`N${n} · ${porcentajeInicial(n, bajada)} %`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="inv-cashea-bloque">
                <span className="lm-eyebrow">Cuotas</span>
                <div className="inv-cashea-cuotas" role="group" aria-label="Cuotas">
                  <button
                    type="button"
                    className="inv-cashea-opcion"
                    aria-pressed={plan.cuotas === 3}
                    onClick={() => setCuotasElegidas(3)}
                  >
                    3 cuotas
                  </button>
                  <button
                    type="button"
                    className="inv-cashea-opcion"
                    aria-pressed={plan.cuotas === 6}
                    disabled={!seisDisponible}
                    onClick={() => setCuotasElegidas(6)}
                  >
                    6 cuotas
                  </button>
                </div>
                {!seisDisponible && (
                  <p className="inv-cashea-nota" role="status">
                    Con montos de $100 o menos solo está disponible el plan de 3 cuotas
                  </p>
                )}
              </div>

              {/* P2: si la bajada es definitiva, se borra este bloque */}
              <div className="inv-cashea-bajada">
                <button
                  type="button"
                  className="ac-switch"
                  role="switch"
                  aria-checked={bajada}
                  data-on={bajada}
                  aria-label="Bajada de inicial"
                  onClick={() => setBajada((v) => !v)}
                />
                <span>Bajada de inicial</span>
              </div>

              <dl className="inv-cashea-resumen">
                <div>
                  <dt>Inicial</dt>
                  <dd className="lm-num" data-testid="cashea-inicial">
                    {`${formatUsd(plan.inicialCents)} (${plan.pct} %)`}
                  </dd>
                </div>
                <div>
                  <dt>Cada cuota</dt>
                  <dd className="lm-num">
                    {formatUsd(plan.cuotaCents)}
                    {ultimaCuotaCents !== plan.cuotaCents && (
                      <small className="inv-cashea-ultima">{` · la última, ${formatUsd(ultimaCuotaCents)}`}</small>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Monto financiado</dt>
                  <dd className="lm-num">{formatUsd(plan.financiadoCents)}</dd>
                </div>
                <div>
                  <dt>Monto total</dt>
                  <dd className="lm-num">{formatUsd(montoCents)}</dd>
                </div>
              </dl>

              <div className="inv-cashea-bloque">
                <span className="lm-eyebrow">Cronograma</span>
                <ol className="inv-cashea-cronograma" aria-label="Cronograma de pagos">
                  {cronograma.map((c) => (
                    <li key={c.numero} className="lm-num">
                      {c.numero === 0
                        ? `Hoy · Inicial · ${formatUsd(c.montoCents)}`
                        : `${formatFechaCuota(c.fecha)} · Cuota ${c.numero} · ${formatUsd(c.montoCents)}`}
                    </li>
                  ))}
                </ol>
                <p className="inv-cashea-nota">Fechas de referencia; las fija Cashea.</p>
              </div>

              <div className="inv-cashea-bloque">
                <span className="lm-eyebrow">Comparar niveles</span>
                <div className="inv-cashea-tabla-wrap">
                  <table className="inv-cashea-tabla">
                    <thead>
                      <tr>
                        <th scope="col">Nivel</th>
                        <th scope="col">Inicial</th>
                        <th scope="col">Cuota</th>
                        <th scope="col">Financiado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparativa.map((fila) => (
                        <tr key={fila.nivel} aria-current={fila.nivel === nivel ? "true" : undefined}>
                          <td>{`N${fila.nivel}`}</td>
                          <td className="lm-num">{formatUsd(fila.inicialCents)}</td>
                          <td className="lm-num">{formatUsd(fila.cuotaCents)}</td>
                          <td className="lm-num">{formatUsd(fila.financiadoCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="inv-cashea-bloque">
                <span className="lm-eyebrow">Mensaje para WhatsApp</span>
                <textarea
                  className="inv-cashea-input inv-cashea-mensaje"
                  readOnly
                  rows={6}
                  aria-label="Mensaje para WhatsApp"
                  value={mensaje}
                />
                <div>
                  <Button variant="primary" size="sm" isDisabled={montoCents === 0} onPress={handleCopiar}>
                    Copiar
                  </Button>
                </div>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => handleOpenChange(false)}>
                Cerrar
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
