"use client";

import { useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { Drawer, toast } from "@heroui/react";
import type { PricedCartLine } from "@/lib/conversation-cart";
import { formatBs, formatUsd, toCents } from "@/lib/cashea";
import {
  avisosRenglon,
  textoCarritoParaCliente,
  totalesCarrito,
  type LineaCarritoInventario,
} from "@/lib/inventario-carrito";
import { CasheaControles } from "@/components/cashea/cashea-controles";
import { CasheaResumen } from "@/components/cashea/cashea-resumen";
import { useInventarioCarrito } from "@/components/inventario/inventario-carrito-context";
import "@/components/agent-control/agent-control.css";
import "@/components/inventario/inventario.css";

/**
 * Panel lateral del carrito de cotización del Inventario (12/10/2026, plan
 * "Carrito de cotización en el Inventario, con Cashea", T4).
 *
 * Presentacional sobre el contexto: todo número sale de `totalesCarrito` y de
 * los formateadores es-VE de `cashea.ts`; aquí no se calcula ni se redondea
 * nada. El bloque de totales va en el pie del Drawer para que se vea siempre,
 * sin importar cuánto crezca la lista; el cuerpo es lo único que desplaza.
 *
 * Es un `Drawer` de HeroUI (placement derecha): corre en jsdom, así que el
 * test lo ejerce de verdad y no hizo falta caer al `Modal`.
 */

const SIN_MONTO = "—";

function usdOSinPrecio(usd: number | null): string {
  return usd === null ? SIN_MONTO : formatUsd(toCents(usd));
}

function bsOSinPrecio(bs: number | null): string {
  return bs === null ? SIN_MONTO : formatBs(bs);
}

/**
 * Cantidad editable. Guarda el borrador localmente y cambia el carrito al
 * SALIR del campo (o con Enter), no en cada tecla: así escribir "12" no pasa
 * por un 1 intermedio que recalcule todo. Inválido (vacío, 0, decimal) revierte.
 * El padre lo remonta con `key` cuando la cantidad cambia desde otro lado.
 */
function CampoCantidad({
  nombre,
  cantidad,
  onCambiar,
}: {
  nombre: string;
  cantidad: number;
  onCambiar: (cantidad: number) => void;
}) {
  const [borrador, setBorrador] = useState(String(cantidad));

  function confirmar() {
    const n = Number(borrador.replace(/\D/g, ""));
    if (!Number.isInteger(n) || n < 1) {
      setBorrador(String(cantidad));
      return;
    }
    setBorrador(String(n));
    if (n !== cantidad) onCambiar(n);
  }

  return (
    <input
      className="inv-carrito-cantidad lm-num"
      value={borrador}
      onChange={(event) => setBorrador(event.target.value)}
      onBlur={confirmar}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      inputMode="numeric"
      aria-label={`Cantidad de ${nombre}`}
    />
  );
}

function Renglon({
  linea,
  onCantidad,
  onQuitar,
}: {
  linea: PricedCartLine<LineaCarritoInventario>;
  onCantidad: (cantidad: number) => void;
  onQuitar: () => void;
}) {
  const { product, quantity } = linea.item;
  const avisos = avisosRenglon(linea);

  return (
    <li className="inv-carrito-renglon">
      <div className="inv-carrito-renglon-cabeza">
        <div className="inv-carrito-renglon-id">
          <span className="inv-carrito-nombre">{product.name}</span>
          <span className="inv-carrito-codigo lm-num">{product.saintCode ?? "Sin código"}</span>
        </div>
        <button
          type="button"
          className="inv-carrito-quitar"
          onClick={onQuitar}
          aria-label={`Quitar ${product.name}`}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="inv-carrito-renglon-cuerpo">
        <CampoCantidad
          key={`${product.id}-${quantity}`}
          nombre={product.name}
          cantidad={quantity}
          onCambiar={onCantidad}
        />
        <span className="inv-carrito-unitario lm-num">
          c/u {bsOSinPrecio(linea.unitPriceBs)} · {usdOSinPrecio(linea.unitPriceUsd)}
        </span>
        <span className="inv-carrito-subtotal lm-num">
          <span>{bsOSinPrecio(linea.subtotalBs)}</span>
          <span>{usdOSinPrecio(linea.subtotalUsd)}</span>
        </span>
      </div>

      {avisos.length > 0 && (
        <div className="inv-carrito-avisos">
          {avisos.map((aviso) => (
            <span key={aviso} className="ac-badge" data-tone="wait">
              {aviso}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

export function CarritoPanel({ bcvRate }: { bcvRate: number }) {
  const carrito = useInventarioCarrito();
  const [confirmandoVaciar, setConfirmandoVaciar] = useState(false);

  // Fuera del provider no hay carrito que mostrar.
  if (!carrito) return null;

  const { lineas, abierto, cerrar, cashea, setCashea } = carrito;
  const totales = totalesCarrito(lineas, bcvRate, cashea);
  const texto = textoCarritoParaCliente(totales);
  const vacio = lineas.length === 0;

  async function copiar() {
    if (texto === null) return;
    try {
      await navigator.clipboard.writeText(texto);
      toast.success("Carrito copiado");
    } catch {
      toast.danger("No se pudo copiar");
    }
  }

  return (
    <Drawer.Root
      isOpen={abierto}
      onOpenChange={(open) => {
        if (!open) {
          setConfirmandoVaciar(false);
          cerrar();
        } else {
          carrito.abrir();
        }
      }}
    >
      <Drawer.Backdrop>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="inv-carrito-dialogo">
            <Drawer.Header className="inv-carrito-cabecera">
              <Drawer.Heading>Carrito de cotización</Drawer.Heading>
              <Drawer.CloseTrigger aria-label="Cerrar" />
            </Drawer.Header>

            <Drawer.Body className="inv-carrito-cuerpo">
              {vacio ? (
                <p className="inv-carrito-vacio">Agregá repuestos desde la lista con «Agregar».</p>
              ) : (
                <>
                  <ul className="inv-carrito-lista" aria-label="Productos del carrito">
                    {totales.lineas.map((linea) => (
                      <Renglon
                        key={linea.item.product.id}
                        linea={linea}
                        onCantidad={(cantidad) => carrito.cambiarCantidad(linea.item.product.id, cantidad)}
                        onQuitar={() => carrito.quitar(linea.item.product.id)}
                      />
                    ))}
                  </ul>

                  <div className="inv-carrito-cashea">
                    <div className="inv-carrito-cashea-cabeza">
                      <span>Financiar con Cashea</span>
                      <button
                        type="button"
                        role="switch"
                        className="ac-switch"
                        aria-checked={cashea.activo}
                        aria-label="Financiar con Cashea"
                        data-on={cashea.activo}
                        onClick={() => setCashea({ ...cashea, activo: !cashea.activo })}
                      />
                    </div>
                    {cashea.activo &&
                      (totales.unpricedCount > 0 ? (
                        <p className="inv-carrito-nota" role="status">
                          Falta la tasa BCV para un producto: no se puede financiar un total incompleto.
                        </p>
                      ) : (
                        <CasheaControles
                          montoCents={toCents(totales.usd)}
                          eleccion={cashea}
                          onChange={(eleccion) => setCashea({ ...cashea, ...eleccion })}
                        />
                      ))}
                  </div>
                </>
              )}
            </Drawer.Body>

            {!vacio && (
              <Drawer.Footer className="inv-carrito-pie">
                <div className="inv-carrito-totales" aria-label="Totales" role="group">
                  <div className="inv-carrito-total-fila">
                    <span>Total en bolívares</span>
                    <span className="lm-num">{totales.bs === null ? "Sin tasa" : formatBs(totales.bs)}</span>
                  </div>
                  <div className="inv-carrito-total-fila">
                    <span>Total en dólares</span>
                    <span className="lm-num">
                      {totales.unpricedCount > 0 ? "Sin tasa" : formatUsd(toCents(totales.usd))}
                    </span>
                  </div>
                  {totales.cashea && <CasheaResumen plan={totales.cashea} bcvRate={bcvRate} notaCadencia />}
                </div>

                <div className="inv-carrito-acciones">
                  <button
                    type="button"
                    className="crm-pill"
                    onClick={() => void copiar()}
                    disabled={texto === null}
                  >
                    <Copy size={13} aria-hidden="true" />
                    Copiar para WhatsApp
                  </button>
                  {confirmandoVaciar ? (
                    <span className="inv-carrito-confirmar">
                      <span>¿Vaciar el carrito?</span>
                      <button
                        type="button"
                        className="crm-pill"
                        onClick={() => {
                          carrito.vaciar();
                          setConfirmandoVaciar(false);
                        }}
                      >
                        Sí, vaciar
                      </button>
                      <button type="button" className="crm-pill" onClick={() => setConfirmandoVaciar(false)}>
                        No
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="crm-pill" onClick={() => setConfirmandoVaciar(true)}>
                      Vaciar
                    </button>
                  )}
                </div>
              </Drawer.Footer>
            )}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer.Root>
  );
}
