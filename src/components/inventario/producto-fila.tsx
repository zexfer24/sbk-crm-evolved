"use client";

import { useState, type FocusEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, EyeOff, TriangleAlert } from "lucide-react";
import { toast } from "@heroui/react";
import type { Product } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { setProductActive, updateProductPrice, updateProductStock } from "@/lib/mutations";
import { aiVisibility, parsePriceInput, parseStockInput, priceInBs, stockLevel } from "@/lib/inventory";

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
  const [priceDraft, setPriceDraft] = useState(product.price.toFixed(2));
  const [busy, setBusy] = useState(false);
  const [savedField, setSavedField] = useState<"stock" | "precio" | null>(null);

  const level = stockLevel(product);
  const visibility = aiVisibility(product);
  const bs = priceInBs(product, bcvRate);

  async function save(field: "stock" | "precio", action: () => Promise<void>, revert: () => void) {
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

  async function commitPrice() {
    const parsed = parsePriceInput(priceDraft);
    if (!parsed.ok) {
      setPriceDraft(product.price.toFixed(2));
      toast.danger(parsed.error);
      return;
    }
    if (parsed.value === product.price) {
      setPriceDraft(parsed.value.toFixed(2));
      return;
    }

    await save(
      "precio",
      () => updateProductPrice(createClient(), product.id, parsed.value),
      () => setPriceDraft(product.price.toFixed(2))
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
      </label>

      <label className="inv-field">
        <span className="lm-eyebrow">Precio {product.currency === "VES" ? "(Bs)" : "(USD)"}</span>
        <span className="inv-input-wrap">
          <input
            className="lm-num"
            value={priceDraft}
            onChange={(e) => setPriceDraft(e.target.value)}
            onBlur={commitPrice}
            onKeyDown={onEnter}
            onFocus={selectAll}
            disabled={busy}
            inputMode="decimal"
            aria-label={`Precio de ${product.name}`}
          />
          {savedField === "precio" && <Check size={13} className="inv-saved" aria-label="Guardado" />}
        </span>
        {bs !== null && product.currency === "USD" && (
          <span className="inv-bs lm-num">Bs. {bs.toFixed(2)}</span>
        )}
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

        <button type="button" className="crm-pill" onClick={toggleActive} disabled={busy}>
          {product.isActive ? "Desactivar" : "Activar"}
        </button>
      </div>
    </li>
  );
}
