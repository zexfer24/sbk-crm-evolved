"use client";

import { useCallback, useState } from "react";
import { toast } from "@heroui/react";
import type { ConversationQuote, Product } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { fetchConversationQuotes } from "@/lib/data";
import { addQuotesToCart, addToCart, removeFromCart, setCartQuantity } from "@/lib/mutations";
import { productPriceUsd } from "@/lib/sale-cart";

/**
 * Escrituras del carrito persistente de la conversación, compartidas por el
 * panel derecho y el modal de cierre de venta (T8, plan "Seba encuentra, no
 * insiste, y el mostrador no deja a nadie esperando", 28/9/2026).
 *
 * Cada acción hace lo mismo: escribe en la tabla (`mutations.ts`), avisa con
 * un toast si falla —con el mensaje del error cuando es legible— y SIEMPRE
 * refresca al terminar, también tras un fallo: la pantalla tiene que mostrar
 * lo que de verdad quedó en la base, no lo que el asesor cree haber dejado.
 * El refresco explícito no reemplaza al canal de Realtime `cart-<id>` de
 * `crm-shell.tsx` (que trae los cambios de OTROS asesores): es lo que hace
 * que la propia acción se vea al instante aunque el canal tarde o caiga.
 */

export interface CartActions {
  /** Hay una escritura en curso: los botones de agregar/cambiar se deshabilitan. */
  busy: boolean;
  addProduct: (product: Product) => Promise<void>;
  addQuote: (quote: ConversationQuote) => Promise<void>;
  addAllQuotes: () => Promise<void>;
  setQuantity: (itemId: string, quantity: number) => Promise<void>;
  remove: (itemId: string) => Promise<void>;
}

interface UseCartActionsInput {
  conversationId: string;
  /** Tasa BCV para pasar a dólares un repuesto en bolívares; 0 si no hay. */
  bcvRate: number;
  /** Refresca el carrito que muestra la pantalla. */
  onCartChanged: () => void;
}

export function useCartActions({ conversationId, bcvRate, onCartChanged }: UseCartActionsInput): CartActions {
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (fallbackMessage: string, action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
      } catch (error) {
        // Un error de mutación propio trae un mensaje pensado para el asesor;
        // un PostgrestError es un objeto plano sin `Error`, y su texto técnico
        // no le sirve a nadie en un toast.
        toast.danger(error instanceof Error && error.message ? error.message : fallbackMessage);
      } finally {
        setBusy(false);
        onCartChanged();
      }
    },
    [onCartChanged]
  );

  const addProduct = useCallback(
    async (product: Product) => {
      // Un repuesto en bolívares sin tasa no se puede pasar a dólares: meterlo
      // dejaría un renglón sin precio que después bloquea el cierre.
      if (productPriceUsd(product, bcvRate) === null) {
        toast.danger("Este repuesto tiene el precio en bolívares y todavía no hay tasa del BCV para convertirlo.");
        return;
      }
      await run("No se pudo agregar al carrito.", () =>
        addToCart(createClient(), { conversationId, productId: product.id, quantity: 1, origin: "inventory" })
      );
    },
    [bcvRate, conversationId, run]
  );

  const addQuote = useCallback(
    async (quote: ConversationQuote) => {
      if (!quote.productId) {
        toast.danger("Ese producto ya no existe en el catálogo: no se puede agregar.");
        return;
      }
      const productId = quote.productId;
      await run("No se pudo agregar al carrito.", () =>
        addToCart(createClient(), { conversationId, productId, quantity: 1, origin: "quote", quoteId: quote.id })
      );
    },
    [conversationId, run]
  );

  const addAllQuotes = useCallback(async () => {
    await run("No se pudieron agregar las cotizaciones.", async () => {
      const supabase = createClient();
      const quotes = await fetchConversationQuotes(supabase, conversationId);
      const added = await addQuotesToCart(supabase, conversationId, quotes);
      if (added > 0) {
        toast.success(added === 1 ? "Se agregó 1 cotización de Seba." : `Se agregaron ${added} cotizaciones de Seba.`);
      } else {
        toast.warning("No hay nada nuevo que agregar: Seba no cotizó otros productos, o ya están en el carrito.");
      }
    });
  }, [conversationId, run]);

  const setQuantity = useCallback(
    async (itemId: string, quantity: number) => {
      await run("No se pudo cambiar la cantidad.", () => setCartQuantity(createClient(), itemId, quantity));
    },
    [run]
  );

  const remove = useCallback(
    async (itemId: string) => {
      await run("No se pudo quitar el renglón.", () => removeFromCart(createClient(), itemId));
    },
    [run]
  );

  return { busy, addProduct, addQuote, addAllQuotes, setQuantity, remove };
}
