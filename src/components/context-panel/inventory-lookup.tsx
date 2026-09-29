"use client";

import { useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import type { Product } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { searchProductsForLookup } from "@/lib/inventory-data";
import { priceDisplay } from "@/lib/inventory";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";
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
 */
const LOOKUP_DEBOUNCE_MS = 300;
const LOOKUP_LIMIT = 8;

type LookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; term: string; products: Product[] };

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

  const runSearch = useDebouncedCallback(() => {
    const term = text.trim();
    if (!term) {
      setState({ status: "idle" });
      return;
    }

    const mine = ++requestSeq.current;
    setState({ status: "loading" });
    searchProductsForLookup(createClient(), term, LOOKUP_LIMIT)
      .then((products) => {
        if (requestSeq.current !== mine) return; // una búsqueda más nueva ya está en vuelo
        setState({ status: "ok", term, products });
      })
      .catch(() => {
        if (requestSeq.current !== mine) return;
        setState({ status: "error" });
      });
  }, LOOKUP_DEBOUNCE_MS);

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

  const rate = bcvRate?.rate ?? 0;

  return (
    <section className="crm-context-section">
      <p className="lm-eyebrow">Inventario</p>
      <div className="crm-lookup-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={text}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Buscar por nombre, marca o código"
          aria-label="Buscar en el inventario"
        />
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
        <ul className="crm-lookup-results">
          {state.products.map((product) => {
            const price = priceDisplay(product, rate);
            return (
              <li className="crm-lookup-item" key={product.id} data-retired={product.isActive ? undefined : "true"}>
                <div className="crm-lookup-item-head">
                  <span className="crm-lookup-name">{product.name}</span>
                  {!product.isActive && (
                    <span className="ac-badge" data-tone="muted">
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
                  <span className="lm-num">
                    {product.stockQuantity <= 0 ? "Sin stock" : `${product.stockQuantity} en stock`}
                  </span>
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
      )}
    </section>
  );
}
