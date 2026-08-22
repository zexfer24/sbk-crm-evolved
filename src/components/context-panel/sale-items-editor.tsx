"use client";

import { useEffect, useState } from "react";
import { Minus, Plus, Search, Sparkles, Trash2, UserPen } from "lucide-react";
import { Label, toast } from "@heroui/react";
import type { ConversationQuote, Product, SaleCartItem } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { fetchConversationQuotes } from "@/lib/data";
import { searchActiveProducts } from "@/lib/inventory-data";
import {
  addProductToCart,
  addQuoteToCart,
  cartTotalUsd,
  productPriceUsd,
  removeFromCart,
  setCartQuantity,
} from "@/lib/sale-cart";

/**
 * Qué lleva el cliente, editable por el asesor.
 *
 * Antes esta parte solo dejaba marcar lo que la IA hubiera cotizado en el
 * chat: si el cliente agregaba algo al final, o si nunca preguntó por el
 * catálogo, la venta no se podía cerrar. Ahora el asesor arma la lista —
 * agrega, quita y ajusta cantidades— pero el precio lo sigue poniendo el
 * catálogo, que es lo que hace que el monto de la venta sea auditable.
 */
const SEARCH_DEBOUNCE_MS = 300;

interface SaleItemsEditorProps {
  conversationId: string;
  cart: SaleCartItem[];
  onChange: (cart: SaleCartItem[]) => void;
  /** Hace falta para pasar a dólares un repuesto con el precio en bolívares. */
  bcvRate: number;
}

export function SaleItemsEditor({ conversationId, cart, onChange, bcvRate }: SaleItemsEditorProps) {
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

  const total = cartTotalUsd(cart);
  const inCart = new Set(cart.map((item) => item.productId).filter((id): id is string => id !== null));

  // Solo se ofrecen las cotizaciones que todavía no están en la lista, y una
  // sola vez por producto: la IA cotiza lo mismo cada vez que el cliente
  // pregunta, y ver el mismo repuesto cinco veces no ayuda a nadie.
  const pendingQuotes = quotes.filter((quote, index) => {
    if (quote.productId && inCart.has(quote.productId)) return false;
    if (cart.some((item) => item.id === quote.id)) return false;
    if (!quote.productId) return true;
    return quotes.findIndex((q) => q.productId === quote.productId) === index;
  });

  function handleAddProduct(product: Product) {
    const price = productPriceUsd(product, bcvRate);
    if (price === null) {
      toast.danger("Este repuesto tiene el precio en bolívares y todavía no hay tasa del BCV para convertirlo.");
      return;
    }
    onChange(addProductToCart(cart, product, bcvRate));
    setSearch("");
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>¿Qué lleva el cliente?</Label>
      <p className="lm-hint">
        Agrega, quita y ajusta cantidades libremente. El precio siempre sale del catálogo — así el monto de la venta
        queda cuadrado con lo que se le cotizó al cliente.
      </p>

      {cart.length === 0 ? (
        <p className="crm-quote-empty text-xs text-muted">
          Todavía no has agregado nada. Toma lo que la IA cotizó en el chat o busca el repuesto en el inventario.
        </p>
      ) : (
        <div className="crm-quote-list">
          {cart.map((item) => (
            <div className="crm-quote-row is-selected" key={item.id}>
              <span className="crm-cart-main">
                <span className="crm-quote-name">{item.description}</span>
                <span
                  className="crm-cart-origin"
                  title={
                    item.origin === "quote"
                      ? "La IA le cotizó este repuesto al cliente en el chat"
                      : "Lo agregaste tú desde el inventario"
                  }
                >
                  {item.origin === "quote" ? <Sparkles size={10} /> : <UserPen size={10} />}
                  {item.origin === "quote" ? "Cotizado por la IA" : "Agregado por ti"}
                </span>
              </span>

              <span className="crm-quote-price">${item.unitPriceUsd.toFixed(2)} c/u</span>

              <div className="crm-quote-qty">
                <button
                  type="button"
                  onClick={() => onChange(setCartQuantity(cart, item.id, item.quantity - 1))}
                  aria-label={`Restar una unidad de ${item.description}`}
                >
                  <Minus size={12} />
                </button>
                <input
                  className="crm-cart-qty-input lm-num"
                  value={item.quantity}
                  onChange={(e) => {
                    const parsed = Number(e.target.value.replace(/\D/g, ""));
                    onChange(setCartQuantity(cart, item.id, Number.isFinite(parsed) && parsed > 0 ? parsed : 1));
                  }}
                  inputMode="numeric"
                  aria-label={`Cantidad de ${item.description}`}
                />
                <button
                  type="button"
                  onClick={() => onChange(setCartQuantity(cart, item.id, item.quantity + 1))}
                  aria-label={`Agregar una unidad de ${item.description}`}
                >
                  <Plus size={12} />
                </button>
              </div>

              <span className="crm-cart-subtotal lm-num">${(item.unitPriceUsd * item.quantity).toFixed(2)}</span>

              <button
                type="button"
                className="crm-cart-remove"
                onClick={() => onChange(removeFromCart(cart, item.id))}
                aria-label={`Quitar ${item.description} de la venta`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}

          <div className="crm-quote-total">
            <span>Total</span>
            <span className="lm-num">${total.toFixed(2)}</span>
          </div>
        </div>
      )}

      {isLoadingQuotes && <p className="text-xs text-muted">Cargando lo que la IA cotizó…</p>}

      {!isLoadingQuotes && pendingQuotes.length > 0 && (
        <>
          <p className="lm-eyebrow crm-cart-section">Cotizado por la IA en este chat</p>
          <div className="crm-cart-suggestions">
            {pendingQuotes.map((quote) => (
              <button
                key={quote.id}
                type="button"
                className="crm-cart-suggestion"
                onClick={() => onChange(addQuoteToCart(cart, quote))}
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
                onClick={() => handleAddProduct(product)}
                disabled={price === null}
              >
                <span className="crm-cart-result-main">
                  <span className="crm-quote-name">{product.name}</span>
                  <span className="crm-cart-result-meta">
                    {product.brand && <span>{product.brand}</span>}
                    <span data-empty={product.stockQuantity <= 0 ? "true" : undefined}>
                      {product.stockQuantity <= 0 ? "Sin stock" : `${product.stockQuantity} en stock`}
                    </span>
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
