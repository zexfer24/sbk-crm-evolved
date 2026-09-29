"use client";

import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Label, toast } from "@heroui/react";
import type { ConversationCartItem, ConversationQuote, Product } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { fetchConversationQuotes } from "@/lib/data";
import { searchActiveProducts } from "@/lib/inventory-data";
import { productPriceUsd } from "@/lib/sale-cart";
import { CartLines } from "@/components/context-panel/cart-lines";
import { StockPill } from "@/components/context-panel/stock-pill";
import { useCartActions } from "@/components/context-panel/use-cart-actions";

/**
 * Qué lleva el cliente, editable por el asesor, dentro del modal «Cerrar
 * venta».
 *
 * T8 (28/9/2026, plan "Seba encuentra, no insiste, y el mostrador no deja a
 * nadie esperando"): esto ya NO es un carrito propio del modal. Muestra el
 * carrito persistente de la conversación —el mismo de «Lo que lleva el
 * cliente» en el panel derecho— y cada cambio (agregar, quitar, cantidad)
 * se escribe en `conversation_cart_items` por `useCartActions`; el modal
 * arranca con lo que el asesor ya fue juntando mientras conversaba. Antes el
 * estado vivía en `useState` del modal y cerrarlo perdía todo.
 *
 * El precio lo sigue poniendo el catálogo, y desde D6 es el VIGENTE al
 * facturar (no el cotizado): un renglón que vino de una cotización con otro
 * precio avisa «cotizado $X · hoy $Y».
 */
const SEARCH_DEBOUNCE_MS = 300;

interface SaleItemsEditorProps {
  conversationId: string;
  /** El carrito persistente de la conversación (lo lee y mantiene vivo `crm-shell.tsx`). */
  cart: ConversationCartItem[];
  /** Hace falta para pasar a dólares un repuesto con el precio en bolívares. */
  bcvRate: number;
  /** Pide releer el carrito tras una escritura. */
  onCartChanged: () => void;
}

export function SaleItemsEditor({ conversationId, cart, bcvRate, onCartChanged }: SaleItemsEditorProps) {
  const actions = useCartActions({ conversationId, bcvRate, onCartChanged });

  const [quotes, setQuotes] = useState<ConversationQuote[]>([]);
  const [isLoadingQuotes, setIsLoadingQuotes] = useState(true);

  const [search, setSearch] = useState("");
  const [isSearching, setIsSearching] = useState(false);

  // Los resultados viajan junto al término que los produjo. Así, mientras
  // corre el debounce de una búsqueda nueva, no se muestran los resultados
  // de la anterior — y vaciar el cuadro no necesita tocar el estado.
  const [results, setResults] = useState<{ term: string; items: Product[] }>({ term: "", items: [] });

  useEffect(() => {
    let cancelled = false;

    fetchConversationQuotes(createClient(), conversationId)
      .then((data) => {
        if (!cancelled) setQuotes(data);
      })
      .catch(() => {
        if (!cancelled) toast.danger("No se pudieron cargar las cotizaciones de este chat.");
      })
      .finally(() => {
        if (!cancelled) setIsLoadingQuotes(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Búsqueda en el inventario, con una pausa para no consultar por tecla.
  useEffect(() => {
    const text = search.trim();
    if (!text) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      setIsSearching(true);
      searchActiveProducts(createClient(), text)
        .then((data) => {
          if (!cancelled) setResults({ term: text, items: data });
        })
        .catch(() => {
          if (!cancelled) toast.danger("No se pudo buscar en el inventario.");
        })
        .finally(() => {
          if (!cancelled) setIsSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search]);

  const term = search.trim();
  // Solo valen los resultados de lo que está escrito ahora mismo.
  const visibleResults = results.term === term ? results.items : [];

  const inCart = new Set(cart.map((item) => item.productId));

  // Solo se ofrecen las cotizaciones que todavía no están en el carrito, y una
  // sola vez por producto: la IA cotiza lo mismo cada vez que el cliente
  // pregunta, y ver el mismo repuesto cinco veces no ayuda a nadie. Una
  // cotización de un producto que ya no existe (`productId: null`) no se
  // puede agregar: el carrito exige el producto.
  const pendingQuotes = quotes.filter((quote, index) => {
    if (!quote.productId) return false;
    if (inCart.has(quote.productId)) return false;
    return quotes.findIndex((q) => q.productId === quote.productId) === index;
  });

  async function handleAddProduct(product: Product) {
    await actions.addProduct(product);
    setSearch("");
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>¿Qué lleva el cliente?</Label>
      <p className="lm-hint">
        Es el mismo carrito del panel del chat: lo que agregues, quites o cambies aquí queda guardado. El precio
        siempre sale del catálogo y se factura el de hoy.
      </p>

      {cart.length === 0 ? (
        <p className="crm-quote-empty text-xs text-muted">
          Todavía no has agregado nada. Toma lo que Seba cotizó en el chat o busca el repuesto en el inventario.
        </p>
      ) : (
        <CartLines cart={cart} bcvRate={bcvRate} actions={actions} />
      )}

      {isLoadingQuotes && <p className="text-xs text-muted">Cargando lo que Seba cotizó…</p>}

      {!isLoadingQuotes && pendingQuotes.length > 0 && (
        <>
          <p className="lm-eyebrow crm-cart-section">Cotizado por Seba en este chat</p>
          <div className="crm-cart-suggestions">
            {pendingQuotes.map((quote) => (
              <button
                key={quote.id}
                type="button"
                className="crm-cart-suggestion"
                disabled={actions.busy}
                onClick={() => void actions.addQuote(quote)}
              >
                <Plus size={11} />
                <span>{quote.productName}</span>
                <span className="crm-quote-price">${quote.priceUsd.toFixed(2)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <p className="lm-eyebrow crm-cart-section">Agregar del inventario</p>
      <div className="crm-cart-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar repuesto por nombre o marca"
          aria-label="Buscar repuesto en el inventario"
        />
      </div>

      {isSearching && <p className="text-xs text-muted">Buscando…</p>}

      {!isSearching && term && results.term === term && visibleResults.length === 0 && (
        <p className="text-xs text-muted">Ningún repuesto activo coincide con «{term}».</p>
      )}

      {visibleResults.length > 0 && (
        <div className="crm-cart-results">
          {visibleResults.map((product) => {
            const price = productPriceUsd(product, bcvRate);
            const yaEsta = inCart.has(product.id);

            return (
              <button
                key={product.id}
                type="button"
                className="crm-cart-result"
                onClick={() => void handleAddProduct(product)}
                disabled={price === null || actions.busy}
              >
                <span className="crm-cart-result-main">
                  <span className="crm-quote-name">{product.name}</span>
                  <span className="crm-cart-result-meta">
                    {product.brand && <span>{product.brand}</span>}
                    <StockPill quantity={product.stockQuantity} />
                    {yaEsta && <span>Ya está en la venta: suma una unidad</span>}
                  </span>
                </span>
                <span className="crm-quote-price">{price === null ? "Sin tasa" : `$${price.toFixed(2)}`}</span>
                <Plus size={13} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
