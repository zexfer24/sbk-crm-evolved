"use client";

import { useState } from "react";
import { Minus, Plus, Sparkles, Trash2, UserPen } from "lucide-react";
import type { CartPriceKind, ConversationCartItem } from "@/lib/types";
import { cartTotals, priceCartLines, quoteComparisonLabel, type PricedCartLine } from "@/lib/conversation-cart";
import { motivoSinEstandar, standardPriceDisplay } from "@/lib/inventory";
import type { CartActions } from "@/components/context-panel/use-cart-actions";
import { StockPill } from "@/components/context-panel/stock-pill";

/**
 * Los renglones del carrito persistente y su total (T8, plan "Seba encuentra,
 * no insiste, y el mostrador no deja a nadie esperando", 28/9/2026). Lo usan
 * el bloque «Lo que lleva el cliente» del panel derecho (columna angosta,
 * 300 px) y el editor del modal «Cerrar venta»: por eso el renglón se apila
 * —nombre arriba, cantidad y subtotal abajo— en vez de una sola fila ancha.
 *
 * Presentacional: los precios son los VIGENTES (`priceCartLines`, D6) y cada
 * acción se delega en `CartActions`.
 *
 * 14/10/2026: cada renglón trae un selector «Promoción» / «Estándar»
 * (promoción + envío MRW). «Estándar» se deshabilita sin tarifa MRW, con el
 * motivo en el `title`; un renglón estándar que perdió su tarifa (el peso se
 * borró en Inventario después de agregarlo) queda sin precio y lo dice, porque
 * bloquea el cierre de la venta.
 */

interface CartLinesProps {
  cart: ConversationCartItem[];
  bcvRate: number;
  actions: CartActions;
}

/**
 * Cantidad editable. Guarda el borrador localmente y escribe en la base al
 * SALIR del campo (o con Enter), no en cada tecla: cada escritura es un
 * viaje a la base y un aviso a los demás asesores. La cantidad del renglón
 * cambia por Realtime → el padre remonta este campo con `key` y el borrador
 * se reinicia solo.
 */
function QuantityField({ line, actions }: { line: PricedCartLine; actions: CartActions }) {
  const name = line.item.product.name;
  const [draft, setDraft] = useState(String(line.item.quantity));

  function commit() {
    const parsed = Number(draft.replace(/\D/g, ""));
    if (!Number.isInteger(parsed) || parsed < 1) {
      setDraft(String(line.item.quantity));
      return;
    }
    if (parsed === line.item.quantity) {
      setDraft(String(parsed));
      return;
    }
    void actions.setQuantity(line.item.id, parsed);
  }

  return (
    <input
      className="crm-cart-qty-input lm-num"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      inputMode="numeric"
      disabled={actions.busy}
      aria-label={`Cantidad de ${name}`}
    />
  );
}

/**
 * Control segmentado de dos opciones (patrón radiogroup). Elegir la que ya
 * está marcada no escribe nada.
 */
function PriceKindToggle({ line, bcvRate, actions }: { line: PricedCartLine; bcvRate: number; actions: CartActions }) {
  const { item } = line;
  const estandar = standardPriceDisplay(item.product, bcvRate);
  const motivo = estandar.estado === "ok" ? undefined : motivoSinEstandar(estandar.estado);

  function choose(kind: CartPriceKind) {
    if (kind === item.priceKind) return;
    void actions.setPriceKind(item.id, kind);
  }

  return (
    <div className="crm-pcart-kind" role="radiogroup" aria-label={`Precio de ${item.product.name}`}>
      <button
        type="button"
        role="radio"
        aria-checked={item.priceKind === "promocion"}
        className="crm-pcart-kind-btn"
        disabled={actions.busy}
        onClick={() => choose("promocion")}
      >
        Promoción
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={item.priceKind === "estandar"}
        className="crm-pcart-kind-btn"
        disabled={actions.busy || estandar.estado !== "ok"}
        title={motivo}
        onClick={() => choose("estandar")}
      >
        Estándar
      </button>
    </div>
  );
}

export function CartLines({ cart, bcvRate, actions }: CartLinesProps) {
  const lines = priceCartLines(cart, bcvRate);
  const totals = cartTotals(lines);
  // Un renglón estándar sin tarifa MRW no tiene precio por otra causa que la
  // tasa: tiene su propio aviso y no entra a la cuenta del aviso de tasa.
  const sinTarifa = (line: PricedCartLine) =>
    line.item.priceKind === "estandar" && line.item.product.shippingFeeUsd === null;
  const sinTasaCount = lines.filter((line) => line.unitPriceUsd === null && !sinTarifa(line)).length;

  return (
    <div className="crm-pcart">
      <ul className="crm-pcart-list">
        {lines.map((line) => {
          const { item } = line;
          const name = item.product.name;
          const comparison = quoteComparisonLabel(line);

          return (
            <li
              className="crm-pcart-item"
              key={item.id}
              // T9 (29/9/2026): el producto quedó en 0 desde que se agregó. Se
              // puede vender igual (puede haber existencia física sin cargar),
              // pero el renglón se marca para que el asesor no se entere en
              // el mostrador.
              data-agotado={item.product.stockQuantity <= 0 ? "true" : undefined}
            >
              <div className="crm-pcart-head">
                <span className="crm-pcart-name">{name}</span>
                <button
                  type="button"
                  className="crm-cart-remove"
                  onClick={() => void actions.remove(item.id)}
                  disabled={actions.busy}
                  aria-label={`Quitar ${name} del carrito`}
                >
                  <Trash2 size={13} />
                </button>
              </div>

              <div className="crm-pcart-meta">
                <span
                  className="crm-cart-origin"
                  title={
                    item.origin === "quote"
                      ? "Seba le cotizó este repuesto al cliente en el chat"
                      : "Lo agregó un asesor desde el inventario"
                  }
                >
                  {item.origin === "quote" ? <Sparkles size={10} /> : <UserPen size={10} />}
                  {item.origin === "quote" ? "Cotizado por Seba" : "Agregado por un asesor"}
                </span>
                <StockPill quantity={item.product.stockQuantity} />
                {comparison && (
                  <span className="crm-pcart-change" title="Se factura el precio de hoy">
                    {comparison}
                  </span>
                )}
              </div>

              <div className="crm-pcart-row">
                <div className="crm-quote-qty">
                  <button
                    type="button"
                    onClick={() => void actions.setQuantity(item.id, item.quantity - 1)}
                    disabled={actions.busy || item.quantity <= 1}
                    aria-label={`Restar una unidad de ${name}`}
                  >
                    <Minus size={12} />
                  </button>
                  {/* `key` con la cantidad: si cambia desde afuera (Realtime, otro
                      asesor) el campo se remonta y el borrador se reinicia. */}
                  <QuantityField key={`${item.id}-${item.quantity}`} line={line} actions={actions} />
                  <button
                    type="button"
                    onClick={() => void actions.setQuantity(item.id, item.quantity + 1)}
                    disabled={actions.busy}
                    aria-label={`Agregar una unidad de ${name}`}
                  >
                    <Plus size={12} />
                  </button>
                </div>

                <span className="crm-pcart-price lm-num">
                  {line.unitPriceUsd === null ? (sinTarifa(line) ? "Sin precio" : "Sin tasa") : `$${line.unitPriceUsd.toFixed(2)} c/u`}
                </span>
                <span className="crm-pcart-subtotal lm-num">
                  {line.subtotalUsd === null ? (sinTarifa(line) ? "Sin precio" : "Sin tasa") : `$${line.subtotalUsd.toFixed(2)}`}
                </span>
              </div>

              <PriceKindToggle line={line} bcvRate={bcvRate} actions={actions} />

              {sinTarifa(line) && (
                <p className="crm-pcart-warning" role="status">
                  Sin tarifa MRW: cámbialo a promoción para poder cerrar
                </p>
              )}

              {line.subtotalBs !== null && (
                <p className="crm-pcart-bs lm-num">Bs. {line.subtotalBs.toFixed(2)}</p>
              )}
            </li>
          );
        })}
      </ul>

      {sinTasaCount > 0 && (
        <p className="crm-pcart-warning" role="status">
          {sinTasaCount === 1
            ? "1 renglón sin precio (falta la tasa del BCV): no entra al total."
            : `${sinTasaCount} renglones sin precio (falta la tasa del BCV): no entran al total.`}
        </p>
      )}

      <div className="crm-quote-total" data-testid="cart-total">
        <span>Total</span>
        <span className="lm-num crm-pcart-total-values">
          <span>${totals.usd.toFixed(2)}</span>
          {totals.bs !== null && <span className="crm-pcart-total-bs">Bs. {totals.bs.toFixed(2)}</span>}
        </span>
      </div>
    </div>
  );
}
