"use client";

import { useState, type FocusEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, EyeOff, TriangleAlert } from "lucide-react";
import { toast } from "@heroui/react";
import type { Product } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { setProductActive, updateProductStock, updateProductWeight } from "@/lib/mutations";
import {
  aiVisibility,
  formatWeightInput,
  parseStockInput,
  parseWeightInput,
  priceDisplay,
  stockLevel,
} from "@/lib/inventory";

/**
 * Una fila del inventario, editable en el sitio.
 *
 * Lo que se guarda acá es exactamente lo que la herramienta de catálogo del
 * agente lee en el próximo turno: no hay copia intermedia. Por eso cada fila
 * dice explícitamente si la IA la está ofreciendo o no.
 *
 * Se guarda al salir del campo (o con Enter), no en cada tecla: escribir
 * "12" no debe pasar por un guardado intermedio en "1".
 */
export function ProductoFila({ product, bcvRate }: { product: Product; bcvRate: number }) {
  const router = useRouter();

  const [stockDraft, setStockDraft] = useState(String(product.stockQuantity));
  const [weightDraft, setWeightDraft] = useState(formatWeightInput(product.weightKg));
  const [busy, setBusy] = useState(false);
  const [savedField, setSavedField] = useState<"stock" | "peso" | null>(null);

  const level = stockLevel(product);
  const visibility = aiVisibility(product);
  const price = priceDisplay(product, bcvRate);

  async function save(field: "stock" | "peso", action: () => Promise<void>, revert: () => void) {
    setBusy(true);
    try {
      await action();
      setSavedField(field);
      // La marca de guardado es un acuse momentáneo, no un estado del dato.
      setTimeout(() => setSavedField(null), 1500);
      router.refresh();
    } catch {
      revert();
      toast.danger("No se pudo guardar el cambio.");
    } finally {
      setBusy(false);
    }
  }

  async function commitStock() {
    const parsed = parseStockInput(stockDraft);
    if (!parsed.ok) {
      setStockDraft(String(product.stockQuantity));
      toast.danger(parsed.error);
      return;
    }
    if (parsed.value === product.stockQuantity) return;

    await save(
      "stock",
      () => updateProductStock(createClient(), product.id, parsed.value),
      () => setStockDraft(String(product.stockQuantity))
    );
  }

  async function commitWeight() {
    const parsed = parseWeightInput(weightDraft);
    if (!parsed.ok) {
      setWeightDraft(formatWeightInput(product.weightKg));
      toast.danger(parsed.error);
      return;
    }
    if (parsed.value === product.weightKg) {
      setWeightDraft(formatWeightInput(parsed.value));
      return;
    }

    await save(
      "peso",
      () => updateProductWeight(createClient(), product.id, parsed.value),
      () => setWeightDraft(formatWeightInput(product.weightKg))
    );
  }

  async function toggleActive() {
    setBusy(true);
    try {
      await setProductActive(createClient(), product.id, !product.isActive);
      router.refresh();
    } catch {
      toast.danger("No se pudo cambiar la visibilidad del repuesto.");
    } finally {
      setBusy(false);
    }
  }

  function onEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") event.currentTarget.blur();
  }

  function selectAll(event: FocusEvent<HTMLInputElement>) {
    event.currentTarget.select();
  }

  return (
    <li className="inv-row" data-inactive={product.isActive ? undefined : "true"}>
      <div className="inv-identity">
        <span className="inv-name">{product.name}</span>
        <span className="inv-facts">
          {product.brand && <span className="inv-brand">{product.brand}</span>}
          {product.compatibility.length > 0 ? (
            <span className="inv-compat" title={product.compatibility.map((c) => `${c.motoBrand} ${c.motoModel}`).join(", ")}>
              {product.compatibility
                .slice(0, 2)
                .map((c) => `${c.motoBrand} ${c.motoModel}`)
                .join(" · ")}
              {product.compatibility.length > 2 && ` +${product.compatibility.length - 2}`}
            </span>
          ) : (
            <span className="inv-compat inv-compat-any">Sin compatibilidad declarada</span>
          )}
        </span>
      </div>

      <label className="inv-field">
        <span className="lm-eyebrow">Stock</span>
        <span className="inv-input-wrap" data-level={level}>
          <input
            className="lm-num"
            value={stockDraft}
            onChange={(e) => setStockDraft(e.target.value)}
            onBlur={commitStock}
            onKeyDown={onEnter}
            onFocus={selectAll}
            disabled={busy}
            inputMode="numeric"
            aria-label={`Stock de ${product.name}`}
          />
          {savedField === "stock" && <Check size={13} className="inv-saved" aria-label="Guardado" />}
        </span>
        {/* Pie vacío: Stock mide lo mismo que Precio cuando hay tasa (T7, 10/9/2026). */}
        <span className="inv-bs" aria-hidden="true" />
      </label>

      <label className="inv-field">
        <span className="lm-eyebrow">Precio</span>
        {/*
         * El precio deja de editarse desde acá el 19/9/2026 ("El precio se
         * lee en bolívares"): llega de `products`, que se carga por fuera —
         * ver D2 del plan. Ya no es un `<input>`, es texto de solo lectura
         * (`lm-num` para la tipografía, `inv-readonly` para que comparta el
         * `font-size` del input en `inventario.css` — sin esa clase la caja
         * quedaba 4px más alta que Stock/Peso, corrección tras la
         * verificación visual del 19/9/2026).
         */}
        <span className="inv-input-wrap">
          <span className="lm-num inv-readonly" aria-label={`Precio de ${product.name}`}>
            {price.principal}
          </span>
        </span>
        {/*
         * El pie SIEMPRE se renderiza (con o sin texto): si solo aparece
         * cuando hay tasa, ese campo queda más alto que Stock/Peso y, aunque
         * la fila ya sea grid con `align-items: start`, los tres campos
         * dejan de medir lo mismo entre sí de un producto a otro (T7,
         * 10/9/2026 — la grilla de `.inv-row` no se toca en esta corrida).
         */}
        {price.pie !== null ? (
          <span className="inv-bs lm-num">{price.pie}</span>
        ) : (
          <span className="inv-bs" aria-hidden="true" />
        )}
      </label>

      <label className="inv-field">
        <span className="lm-eyebrow">Peso (kg)</span>
        <span className="inv-input-wrap">
          <input
            className="lm-num"
            value={weightDraft}
            onChange={(e) => setWeightDraft(e.target.value)}
            onBlur={commitWeight}
            onKeyDown={onEnter}
            onFocus={selectAll}
            disabled={busy}
            inputMode="decimal"
            aria-label={`Peso de ${product.name}`}
          />
          {savedField === "peso" && <Check size={13} className="inv-saved" aria-label="Guardado" />}
        </span>
        <span className="inv-bs" aria-hidden="true" />
      </label>

      <div className="inv-status">
        {visibility.visible ? (
          <span className="ac-badge" data-tone={visibility.warning ? "wait" : "good"} title={visibility.warning ?? undefined}>
            {visibility.warning ? <TriangleAlert size={11} /> : null}
            {visibility.warning ? "Sin stock" : "La IA lo ofrece"}
          </span>
        ) : (
          <span className="ac-badge" data-tone="muted" title={visibility.warning ?? undefined}>
            <EyeOff size={11} />
            Oculto a la IA
          </span>
        )}

        {product.weightKg === null && (
          <span className="ac-badge" data-tone="wait" title="Cashea exige el peso para calcular el envío gratis">
            <TriangleAlert size={11} />
            Sin peso
          </span>
        )}

        <button type="button" className="crm-pill" onClick={toggleActive} disabled={busy}>
          {product.isActive ? "Desactivar" : "Activar"}
        </button>
      </div>
    </li>
  );
}
