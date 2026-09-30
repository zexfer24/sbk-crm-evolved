"use client";

import { useRef, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import type { Product } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { searchProductsForLookup } from "@/lib/inventory-data";
import { priceDisplay } from "@/lib/inventory";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";
import { StockPill } from "@/components/context-panel/stock-pill";
import type { BcvRateSummary } from "@/components/inbox/bcv-rate-chip";

/**
 * Búsqueda de inventario dentro del panel derecho del chat (T6, plan "El
 * mostrador busca sin salir del chat", 27/9/2026, D5). Hasta esta corrida el
 * único lugar donde un asesor podía chequear precio o existencia era la
 * sección Inventario, aparte — obligaba a salir del chat para responder algo
 * que el cliente ya estaba preguntando ahí mismo.
 *
 * Solo lectura en esta ola (D5): sin botón "insertar en el mensaje", eso
 * queda para otra corrida. T8 (28/9/2026, plan "Seba encuentra, no insiste, y
 * el mostrador no deja a nadie esperando"): cada resultado ACTIVO gana un
 * botón «Agregar» al carrito de la conversación (`onAdd`); sin `onAdd` el
 * componente sigue siendo la búsqueda de solo lectura de siempre, y un
 * repuesto retirado nunca se puede agregar. Usa `searchProductsForLookup` (`inventory-data.ts`,
 * T3) — la misma regla de palabras/código Saint que Inventario, pero SIN
 * filtrar por `is_active`: un repuesto retirado también aparece, marcado
 * "Retirado", para que el asesor no lo ofrezca sin saberlo.
 *
 * T9 (29/9/2026, plan "Seba encuentra, no insiste, y el mostrador no deja a
 * nadie esperando", 3.3 + 3.5): hasta esa fecha la búsqueda traía 8 y se
 * cortaba ahí sin avisar —"cascos" tiene decenas de coincidencias y el asesor
 * no tenía forma de ver más allá de las ocho primeras ni de saber que las
 * había—. Ahora trae páginas de 20 y el botón «Ver más» pide la siguiente
 * (`range()` en `searchProductsForLookup`); la lista scrollea dentro de sí
 * misma (`.crm-lookup-results`, `max-height`) para que 30 o 60 resultados no
 * empujen «Lo que lleva el cliente» ni Notas fuera de la pantalla. La
 * existencia es una pastilla (`StockPill`).
 *
 * T3 (30/9/2026, plan "Ronda del cliente"): los resultados salen de mayor a
 * menor existencia (el orden va en SQL, ver `searchProductsForLookup`) y el
 * cuadro gana un botón ✕ que borra solo el texto: el asesor no tiene que
 * seleccionar y suprimir a mano entre un cliente y el siguiente. La X nativa
 * del `type="search"` está oculta en `crm.css` (se veía distinta en cada
 * navegador), así que este botón es el único.
 */
const LOOKUP_DEBOUNCE_MS = 300;
const LOOKUP_LIMIT = 20;

type LookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ok";
      term: string;
      products: Product[];
      /** La última página vino completa: puede haber más detrás. */
      hasMore: boolean;
      loadingMore: boolean;
      /** «Ver más» falló: se conserva lo que ya se veía y se puede reintentar. */
      moreError: boolean;
    };

interface InventoryLookupProps {
  bcvRate: BcvRateSummary | null;
  /** Agrega el repuesto al carrito de la conversación. Sin esto no hay botón. */
  onAdd?: (product: Product) => void;
  /** Hay una escritura del carrito en curso: el botón «Agregar» se deshabilita. */
  addDisabled?: boolean;
}

export function InventoryLookup({ bcvRate, onAdd, addDisabled = false }: InventoryLookupProps) {
  const [text, setText] = useState("");
  const [state, setState] = useState<LookupState>({ status: "idle" });

  // Número de secuencia de la búsqueda en vuelo: una respuesta que llega
  // DESPUÉS de que ya se lanzó una búsqueda más nueva no puede pisar lo que
  // el asesor está viendo. Mismo riesgo que resolvió `url-search-box.tsx`
  // (T4, esta misma corrida), pero acá no hay URL de por medio — solo dos
  // promesas de red compitiendo. Se lee y escribe SOLO dentro del callback ya
  // debounced (nunca durante el render), así que no dispara
  // `react-hooks/refs`.
  const requestSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = useDebouncedCallback(() => {
    const term = text.trim();
    if (!term) {
      setState({ status: "idle" });
      return;
    }

    const mine = ++requestSeq.current;
    setState({ status: "loading" });
    searchProductsForLookup(createClient(), term, LOOKUP_LIMIT, 0)
      .then((products) => {
        if (requestSeq.current !== mine) return; // una búsqueda más nueva ya está en vuelo
        setState({
          status: "ok",
          term,
          products,
          hasMore: products.length >= LOOKUP_LIMIT,
          loadingMore: false,
          moreError: false,
        });
      })
      .catch(() => {
        if (requestSeq.current !== mine) return;
        setState({ status: "error" });
      });
  }, LOOKUP_DEBOUNCE_MS);

  // «Ver más»: pide la página siguiente y la agrega DEBAJO de lo que ya se ve.
  // No incrementa `requestSeq` (no es una búsqueda nueva) pero sí lo compara:
  // si mientras la página viaja el asesor cambia el texto o lo borra, esa
  // respuesta es de una búsqueda vieja y no se pega a la lista nueva.
  function loadMore() {
    if (state.status !== "ok" || !state.hasMore || state.loadingMore) return;
    const { term, products: current } = state;
    const mine = requestSeq.current;

    setState({ ...state, loadingMore: true, moreError: false });
    searchProductsForLookup(createClient(), term, LOOKUP_LIMIT, current.length)
      .then((page) => {
        if (requestSeq.current !== mine) return;
        // Si la base cambió entre las dos páginas, un repuesto puede aparecer
        // en ambas: la key de React se repetiría. Se descarta el repetido.
        const seen = new Set(current.map((p) => p.id));
        const fresh = page.filter((p) => !seen.has(p.id));
        setState({
          status: "ok",
          term,
          products: [...current, ...fresh],
          hasMore: page.length >= LOOKUP_LIMIT,
          loadingMore: false,
          moreError: false,
        });
      })
      .catch(() => {
        if (requestSeq.current !== mine) return;
        setState({ status: "ok", term, products: current, hasMore: true, loadingMore: false, moreError: true });
      });
  }

  function onChange(value: string) {
    setText(value);
    if (!value.trim()) {
      // Vaciar el cuadro no necesita esperar el debounce: es un cambio de
      // pantalla, no una consulta a la base. Invalida cualquier búsqueda que
      // siguiera en vuelo para que su respuesta no reviva resultados viejos.
      requestSeq.current += 1;
      setState({ status: "idle" });
      return;
    }
    runSearch();
  }

  // El ✕ pasa por `onChange("")`: el MISMO camino que vaciar el cuadro a mano
  // (idle sin esperar el debounce e invalidación de la búsqueda en vuelo). El
  // foco vuelve al input para que el asesor siga escribiendo sin un clic más.
  function clearSearch() {
    onChange("");
    inputRef.current?.focus();
  }

  const rate = bcvRate?.rate ?? 0;

  return (
    <section className="crm-context-section">
      <p className="lm-eyebrow">Inventario</p>
      <div className="crm-lookup-search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          value={text}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Buscar por nombre, marca o código"
          aria-label="Buscar en el inventario"
        />
        {text !== "" && (
          <button type="button" className="crm-lookup-clear" onClick={clearSearch} aria-label="Borrar búsqueda">
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {state.status === "idle" && (
        <p className="crm-lookup-hint">
          Escribe un nombre, una marca o un código Saint para ver existencia y precio.
        </p>
      )}

      {state.status === "loading" && <p className="crm-lookup-hint">Buscando…</p>}

      {state.status === "error" && (
        <p className="crm-lookup-hint" role="alert">
          No se pudo buscar en el inventario.
        </p>
      )}

      {state.status === "ok" && state.products.length === 0 && (
        <p className="crm-lookup-hint">Ningún repuesto coincide con «{state.term}».</p>
      )}

      {state.status === "ok" && state.products.length > 0 && (
        <>
          <ul className="crm-lookup-results">
            {state.products.map((product) => {
              const price = priceDisplay(product, rate);
              return (
                <li className="crm-lookup-item" key={product.id} data-retired={product.isActive ? undefined : "true"}>
                  <div className="crm-lookup-item-head">
                    <span className="crm-lookup-name">{product.name}</span>
                    {!product.isActive && (
                      <span className="crm-lookup-retired">
                        Retirado
                      </span>
                    )}
                  </div>
                  <div className="crm-lookup-item-meta">
                    {product.saintCode ? (
                      <span className="lm-num crm-lookup-code" aria-label={`Código ${product.saintCode}`}>
                        {product.saintCode}
                      </span>
                    ) : (
                      <span className="crm-lookup-code" data-empty="true" aria-label="Sin código Saint">
                        Sin código
                      </span>
                    )}
                    <StockPill quantity={product.stockQuantity} />
                  </div>
                  <div className="crm-lookup-item-actions">
                    <div className="crm-lookup-item-price">
                      <span className="lm-num">{price.principal}</span>
                      {price.pie !== null && <span className="lm-num crm-lookup-price-alt">{price.pie}</span>}
                    </div>
                    {onAdd && product.isActive && (
                      <button
                        type="button"
                        className="crm-lookup-add"
                        onClick={() => onAdd(product)}
                        disabled={addDisabled}
                        aria-label={`Agregar ${product.name} al carrito`}
                      >
                        <Plus size={12} />
                        Agregar
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Fuera de la lista que scrollea: el botón siempre está a la vista,
              no hay que llegar al fondo de la lista para descubrirlo. */}
          {state.moreError && (
            <p className="crm-lookup-hint" role="alert">
              No se pudo cargar más resultados.
            </p>
          )}
          {state.hasMore && (
            <button type="button" className="crm-lookup-more" onClick={loadMore} disabled={state.loadingMore}>
              {state.loadingMore ? "Cargando…" : "Ver más"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
