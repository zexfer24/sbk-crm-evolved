"use client";

import { Copy, MessageSquarePlus, Sparkles } from "lucide-react";
import { Button, toast } from "@heroui/react";
import type { ConversationCartItem } from "@/lib/types";
import { cartSummaryText, cartTotals, priceCartLines } from "@/lib/conversation-cart";
import { CartLines } from "@/components/context-panel/cart-lines";
import type { CartActions } from "@/components/context-panel/use-cart-actions";

/**
 * «Lo que lleva el cliente» en el panel derecho del chat (T8, plan "Seba
 * encuentra, no insiste, y el mostrador no deja a nadie esperando",
 * 28/9/2026). El carrito ya no nace al pulsar «Cerrar venta»: vive en la
 * conversación, el asesor lo va llenando desde la búsqueda de inventario de
 * arriba (botón «Agregar» en cada resultado) o con lo que Seba cotizó, otro
 * asesor lo ve en vivo, y «Cerrar venta» lo toma tal cual.
 *
 * Los precios son los VIGENTES al momento de mirar y de facturar (D6): una
 * cotización de hace tres días se factura al precio de hoy, y el renglón
 * avisa «cotizado $X · hoy $Y» cuando difieren.
 */

interface ConversationCartBlockProps {
  cart: ConversationCartItem[];
  bcvRate: number;
  actions: CartActions;
  /**
   * Deja el resumen del carrito en el cuadro de mensaje del composer, SIN
   * enviarlo (T4, plan "Ronda del cliente", 30/9/2026). Opcional: sin él,
   * «Enviar al chat» queda deshabilitado en vez de no hacer nada.
   */
  onSendToComposer?: (text: string) => void;
}

const SIN_PRECIO = "Hay productos sin precio (falta la tasa BCV)";

export function ConversationCartBlock({ cart, bcvRate, actions, onSendToComposer }: ConversationCartBlockProps) {
  // El mismo cálculo que pinta `CartLines`; `null` si el carrito está vacío o
  // algún renglón no tiene precio en dólares.
  const lines = priceCartLines(cart, bcvRate);
  const summary = cartSummaryText(lines, cartTotals(lines));

  // Deshabilitado por falta de precio: el `title` dice por qué.
  const motivo = summary === null ? SIN_PRECIO : undefined;

  async function handleCopy() {
    if (summary === null) return;
    try {
      await navigator.clipboard.writeText(summary);
      toast.success("Carrito copiado");
    } catch {
      toast.danger("No se pudo copiar");
    }
  }

  return (
    <section className="crm-context-section">
      <p className="lm-eyebrow">Lo que lleva el cliente</p>

      {cart.length === 0 ? (
        <p className="crm-lookup-hint">
          Todavía no hay nada. Agrega repuestos desde el inventario de arriba o trae lo que Seba cotizó.
        </p>
      ) : (
        <>
          <CartLines cart={cart} bcvRate={bcvRate} actions={actions} />
          <div className="crm-pcart-share">
            {/* El `title` va en el envoltorio: el Button de HeroUI no lo pasa al
                DOM, y un botón deshabilitado tampoco recibe el hover. */}
            <span className="crm-pcart-share-btn" title={motivo}>
              <Button
                size="sm"
                variant="secondary"
                fullWidth
                isDisabled={summary === null}
                onPress={() => void handleCopy()}
              >
                <Copy size={13} />
                Copiar
              </Button>
            </span>
            <span className="crm-pcart-share-btn" title={motivo}>
              <Button
                size="sm"
                variant="secondary"
                fullWidth
                isDisabled={summary === null || !onSendToComposer}
                onPress={() => {
                  if (summary !== null) onSendToComposer?.(summary);
                }}
              >
                <MessageSquarePlus size={13} />
                Enviar al chat
              </Button>
            </span>
          </div>
        </>
      )}

      <Button
        size="sm"
        variant="secondary"
        fullWidth
        isDisabled={actions.busy}
        onPress={() => void actions.addAllQuotes()}
      >
        <Sparkles size={13} />
        Agregar cotizaciones de Seba
      </Button>
    </section>
  );
}
