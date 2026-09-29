"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@heroui/react";
import type { ConversationCartItem } from "@/lib/types";
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
}

export function ConversationCartBlock({ cart, bcvRate, actions }: ConversationCartBlockProps) {
  return (
    <section className="crm-context-section">
      <p className="lm-eyebrow">Lo que lleva el cliente</p>

      {cart.length === 0 ? (
        <p className="crm-lookup-hint">
          Todavía no hay nada. Agrega repuestos desde el inventario de arriba o trae lo que Seba cotizó.
        </p>
      ) : (
        <CartLines cart={cart} bcvRate={bcvRate} actions={actions} />
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
