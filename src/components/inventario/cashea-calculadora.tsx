"use client";

import { useId, useState } from "react";
import { Calculator } from "lucide-react";
import { Button, Modal, toast } from "@heroui/react";
import {
  ELECCION_CASHEA_INICIAL,
  calcularCashea,
  comparativaNiveles,
  cronogramaCashea,
  formatFechaCuota,
  formatUsd,
  mensajeWhatsApp,
  parseMontoInput,
  toCents,
  type EleccionCashea,
} from "@/lib/cashea";
import { CasheaControles } from "@/components/cashea/cashea-controles";
import { CasheaResumen } from "@/components/cashea/cashea-resumen";
import { productPriceUsd } from "@/lib/sale-cart";
import type { Product } from "@/lib/types";

interface CasheaCalculadoraProps {
  product: Product;
  bcvRate: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

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
 *
 * Nivel, cuotas, bajada y el resumen (inicial, cada cuota, financiado) son las
 * piezas de `components/cashea/`, las mismas que usa el carrito (T7 del plan
 * "Carrito de cotización en el Inventario, con Cashea"): salieron de este
 * modal sin cambiar lo que hace ni lo que se ve.
 */
export function CasheaCalculadora({ product, bcvRate, isOpen, onOpenChange }: CasheaCalculadoraProps) {
  const ids = useId();
  const cantidadId = `${ids}-cantidad`;
  const manualId = `${ids}-manual`;

  const [cantidadDraft, setCantidadDraft] = useState("1");
  const [montoManualDraft, setMontoManualDraft] = useState("");
  const [eleccion, setEleccion] = useState<EleccionCashea>(ELECCION_CASHEA_INICIAL);

  function reset() {
    setCantidadDraft("1");
    setMontoManualDraft("");
    setEleccion(ELECCION_CASHEA_INICIAL);
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

  const plan = calcularCashea({ montoCents, ...eleccion });

  // Si el monto baja a $100 o menos con 6 elegidas, el plan ya se calcula con
  // 3; aquí además se registra, para que subir el monto de nuevo NO reviva el
  // 6 por su cuenta (el asesor no lo volvió a pedir). Se hace durante el
  // render y no en un efecto: `react-hooks/set-state-in-effect` lo prohíbe.
  if (plan.ajustado && eleccion.cuotas !== ELECCION_CASHEA_INICIAL.cuotas) {
    setEleccion({ ...eleccion, cuotas: ELECCION_CASHEA_INICIAL.cuotas });
  }

  const cronograma = cronogramaCashea(plan, new Date());
  const comparativa = comparativaNiveles(montoCents, plan.cuotas, eleccion.bajada);
  const mensaje = mensajeWhatsApp(plan, product.name);

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

              <CasheaControles montoCents={montoCents} eleccion={eleccion} onChange={setEleccion} />

              <CasheaResumen plan={plan} mostrarBs={false}>
                <div>
                  <dt>Monto total</dt>
                  <dd className="lm-num">{formatUsd(montoCents)}</dd>
                </div>
              </CasheaResumen>

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
                        <tr key={fila.nivel} aria-current={fila.nivel === eleccion.nivel ? "true" : undefined}>
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
