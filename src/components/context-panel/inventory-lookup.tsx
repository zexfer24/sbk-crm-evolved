"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { flushSync } from "react-dom";
import { toast } from "@heroui/react";
import type { CartPriceKind, Product } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { fetchProduct, searchProductsForLookup } from "@/lib/inventory-data";
import { updateProductWeight } from "@/lib/mutations";
import { configErrorMessage } from "@/lib/config-write";
import {
  formatWeightInput,
  motivoSinEstandar,
  parseWeightInput,
  precioDivisaDisplay,
  priceDisplay,
  sinPeso,
  standardPriceDisplay,
  TEXTO_SIN_PRECIO_SAINT,
} from "@/lib/inventory";
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
 *
 * 14/10/2026: cada resultado pinta también el PRECIO ESTÁNDAR (promoción +
 * envío MRW por peso, `standardPriceDisplay`), etiquetado «Promoción» /
 * «Estándar» igual que la fila de Inventario. Hasta esa fecha el asesor
 * cotizaba desde el chat solo con el precio de promoción y tenía que ir a
 * Inventario a buscar el estándar. Sin tarifa se dice el motivo en texto,
 * nunca un número incompleto.
 *
 * Más tarde el mismo día: el asesor elige a qué precio se cobra. Cada resultado
 * activo ofrece dos botones, «+ Promoción» y «+ Estándar» (`onAdd` recibe el
 * `CartPriceKind`); «+ Estándar» se deshabilita sin tarifa MRW, con el motivo
 * en el `title`, para que no entre al carrito un renglón sin precio.
 *
 * 21/10/2026 (plan "Presupuestos y mensajes rápidos", T6): cada resultado
 * muestra su PESO y deja cargarlo o corregirlo ahí mismo (`PesoDelResultado`).
 * Sin peso no hay precio estándar, y el asesor que lo ve faltar no tiene por
 * qué salir a Inventario: al guardar se relee el producto (la tarifa MRW la
 * calcula la base) y el resultado se reemplaza en la lista, así que el
 * estándar y «+ Estándar» se actualizan solos. `products` es de solo lectura
 * salvo `weight_kg`; `puedeEditarPeso` esconde los botones a quien no debe
 * (la caja), y la barrera real sigue siendo la base.
 */
const LOOKUP_DEBOUNCE_MS = 300;
const LOOKUP_LIMIT = 20;

/** Preferencia por visor de «Inventario» plegable (26/10/2026): "1" abierto, "0" cerrado. */
const OPEN_KEY = "sbk.panel.inventario.abierto";

/** Lee la preferencia; ante cualquier fallo de `localStorage` (o sin valor) arranca cerrado. */
function readOpenPreference(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

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
  /** Agrega el repuesto al carrito de la conversación, al precio elegido. Sin esto no hay botones. */
  onAdd?: (product: Product, priceKind: CartPriceKind) => void;
  /** Hay una escritura del carrito en curso: los botones de agregar se deshabilitan. */
  addDisabled?: boolean;
  /** Muestra «Cargar peso»/«Editar». Default `true`; el panel lo apaga para la caja. */
  puedeEditarPeso?: boolean;
  /**
   * 26/10/2026: el título pasa a ser un botón que pliega el buscador; arranca
   * cerrado y recuerda la preferencia. Default `false`: sin el prop todo se ve
   * como siempre (el panel del chat lo enciende).
   */
  desplegable?: boolean;
}

/** «3,2»: el peso para leer, con coma y sin ceros de relleno (el campo editable usa `formatWeightInput`). */
function pesoLegible(weightKg: number): string {
  return String(weightKg).replace(".", ",");
}

interface PesoDelResultadoProps {
  product: Product;
  puedeEditar: boolean;
  /** El producto releído tras guardar: reemplaza al de la lista. */
  onGuardado: (product: Product) => void;
}

/**
 * La línea «Peso» de un resultado, con su edición en línea (21/10/2026). Guarda
 * con Enter o con «Guardar»; Escape cancela. Un valor inválido muestra el
 * error bajo el campo sin llamar a la base; si la base falla, el campo queda
 * abierto con lo escrito y el toast dice por qué.
 */
function PesoDelResultado({ product, puedeEditar, onGuardado }: PesoDelResultadoProps) {
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const faltaPeso = sinPeso(product.weightKg);

  function abrir() {
    setBorrador(formatWeightInput(product.weightKg));
    setError(null);
    setEditando(true);
  }

  function cancelar() {
    setEditando(false);
    setError(null);
  }

  async function guardar() {
    if (guardando) return;
    const parsed = parseWeightInput(borrador);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    // Mismo peso: nada que escribir.
    if (parsed.value === product.weightKg) {
      cancelar();
      return;
    }

    setGuardando(true);
    try {
      const supabase = createClient();
      try {
        await updateProductWeight(supabase, product.id, parsed.value);
      } catch (err) {
        toast.danger(configErrorMessage(err, "No se pudo guardar el peso."));
        return;
      }
      // El peso ya quedó guardado. Releer trae la tarifa MRW nueva (la calcula
      // la base); si la relectura falla NO es un error de guardado: se toma el
      // peso nuevo y se descarta la tarifa vieja, que era la del peso anterior
      // (pintarla sería un precio estándar equivocado). Mismo criterio que
      // `commitWeight` de `producto-fila.tsx`.
      const sinTarifa: Product = { ...product, weightKg: parsed.value, shippingFeeUsd: null };
      let fresco: Product;
      try {
        fresco = (await fetchProduct(supabase, product.id)) ?? sinTarifa;
      } catch {
        fresco = sinTarifa;
      }
      onGuardado(fresco);
      toast.success("Peso guardado");
      setEditando(false);
      setError(null);
    } finally {
      setGuardando(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void guardar();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelar();
    }
  }

  if (editando) {
    return (
      <div className="crm-lookup-weight" data-editing="true">
        <div className="crm-lookup-weight-edit">
          <span className="crm-lookup-weight-field">
            <input
              className="lm-num"
              value={borrador}
              onChange={(event) => {
                setBorrador(event.target.value);
                setError(null);
              }}
              onKeyDown={onKeyDown}
              inputMode="decimal"
              autoFocus
              aria-label={`Peso en kg de ${product.name}`}
              aria-invalid={error ? true : undefined}
            />
            <span className="crm-lookup-weight-unit">kg</span>
          </span>
          <button
            type="button"
            className="crm-lookup-add"
            onClick={() => void guardar()}
            disabled={guardando}
            aria-label={`Guardar peso de ${product.name}`}
          >
            Guardar
          </button>
        </div>
        {error && (
          <p className="crm-lookup-weight-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="crm-lookup-weight">
      <span className="crm-lookup-weight-text" data-empty={faltaPeso ? "true" : undefined}>
        {faltaPeso ? "Sin peso" : `Peso ${pesoLegible(product.weightKg as number)} kg`}
      </span>
      {puedeEditar && (
        <button
          type="button"
          className="crm-lookup-weight-btn"
          onClick={abrir}
          aria-label={`${faltaPeso ? "Cargar" : "Editar"} peso de ${product.name}`}
        >
          {faltaPeso ? "Cargar peso" : "Editar"}
        </button>
      )}
    </div>
  );
}

export function InventoryLookup({ bcvRate, onAdd, addDisabled = false, puedeEditarPeso = true, desplegable = false }: InventoryLookupProps) {
  const bodyId = useId();
  // Sin `desplegable` siempre abierto; con él, la preferencia guardada (o cerrado).
  const [abierto, setAbierto] = useState<boolean>(() => (desplegable ? readOpenPreference() : true));
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

  // El producto releído tras guardar un peso reemplaza al de la lista (misma
  // posición): así el estándar y «+ Estándar» se recalculan sin buscar de nuevo.
  function reemplazarProducto(fresco: Product) {
    setState((actual) =>
      actual.status === "ok"
        ? { ...actual, products: actual.products.map((p) => (p.id === fresco.id ? fresco : p)) }
        : actual
    );
  }

  // Alternar guarda la preferencia (en try/catch: la UI funciona sin storage).
  // Al ABRIR el foco va al input; el cuerpo sigue montado (solo `hidden`), pero un
  // elemento `hidden` no admite foco hasta que el render lo muestra: `flushSync`
  // aplica el cambio antes de enfocar.
  function alternar() {
    const siguiente = !abierto;
    flushSync(() => setAbierto(siguiente));
    try {
      localStorage.setItem(OPEN_KEY, siguiente ? "1" : "0");
    } catch {
      /* sin storage: la preferencia no se recuerda, nada más */
    }
    if (siguiente) {
      inputRef.current?.focus();
    }
  }

  const rate = bcvRate?.rate ?? 0;

  return (
    <section className="crm-context-section">
      {desplegable ? (
        <button
          type="button"
          className="crm-lookup-toggle"
          aria-expanded={abierto}
          aria-controls={bodyId}
          onClick={alternar}
        >
          {abierto ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          Inventario
        </button>
      ) : (
        <p className="lm-eyebrow">Inventario</p>
      )}
      <div id={bodyId} className="crm-lookup-body" hidden={!abierto}>
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
                const estandar = standardPriceDisplay(product, rate);
                const divisa = precioDivisaDisplay(product);
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
                    <PesoDelResultado
                      product={product}
                      puedeEditar={puedeEditarPeso}
                      onGuardado={reemplazarProducto}
                    />
                    <div className="crm-lookup-item-actions">
                      <div className="crm-lookup-prices">
                        <div className="crm-lookup-item-price" data-kind="promo">
                          <span className="crm-lookup-price-label">Promoción</span>
                          <span className="lm-num" aria-label={`Precio promoción de ${product.name}`}>
                            {price.principal}
                          </span>
                          {price.pie !== null && <span className="lm-num crm-lookup-price-alt">{price.pie}</span>}
                        </div>
                        {/* Divisa (30/10/2026, plan "Precio divisa desde SAINT"): Precio1 de
                            SAINT en USD, solo informativo — sin botón de agregar. */}
                        <div className="crm-lookup-item-price" data-kind="divisa">
                          <span className="crm-lookup-price-label">Divisa</span>
                          {divisa.estado === "ok" ? (
                            <span className="lm-num" aria-label={`Precio divisa de ${product.name}`}>
                              {divisa.principal}
                            </span>
                          ) : (
                            <span className="crm-lookup-price-missing" data-empty="true">
                              {TEXTO_SIN_PRECIO_SAINT}
                            </span>
                          )}
                        </div>
                        <div className="crm-lookup-item-price" data-kind="estandar">
                          <span className="crm-lookup-price-label">Estándar</span>
                          {estandar.estado === "ok" ? (
                            <>
                              <span className="lm-num" aria-label={`Precio estándar de ${product.name}`}>
                                {estandar.principal}
                              </span>
                              {estandar.pie !== null && (
                                <span className="lm-num crm-lookup-price-alt">{estandar.pie}</span>
                              )}
                            </>
                          ) : (
                            <span className="crm-lookup-price-missing" data-empty="true">
                              {motivoSinEstandar(estandar.estado)}
                            </span>
                          )}
                        </div>
                        {estandar.estado === "ok" && (
                          <span className="crm-lookup-fee">incluye envío MRW {estandar.tarifa}</span>
                        )}
                      </div>
                      {onAdd && product.isActive && (
                        <div className="crm-lookup-add-group">
                          <button
                            type="button"
                            className="crm-lookup-add"
                            onClick={() => onAdd(product, "promocion")}
                            disabled={addDisabled}
                            aria-label={`Agregar ${product.name} a precio de promoción`}
                          >
                            + Promoción
                          </button>
                          <button
                            type="button"
                            className="crm-lookup-add"
                            onClick={() => onAdd(product, "estandar")}
                            disabled={addDisabled || estandar.estado !== "ok"}
                            title={estandar.estado === "ok" ? undefined : motivoSinEstandar(estandar.estado)}
                            aria-label={`Agregar ${product.name} a precio estándar`}
                          >
                            + Estándar
                          </button>
                        </div>
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
      </div>
    </section>
  );
}
