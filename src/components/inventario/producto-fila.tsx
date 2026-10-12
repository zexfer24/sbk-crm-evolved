"use client";

import { useState, type FocusEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, EyeOff, Sparkles, TriangleAlert } from "lucide-react";
import { toast } from "@heroui/react";
import type { Product } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { updateProductWeight } from "@/lib/mutations";
import { fetchProduct } from "@/lib/inventory-data";
import {
  aiVisibility,
  formatWeightInput,
  isNewFromSaint,
  parseWeightInput,
  priceDisplay,
  standardPriceDisplay,
  stockLevel,
} from "@/lib/inventory";

/** Por qué no hay precio estándar (12/10/2026): nunca un número incompleto. */
const MOTIVO_SIN_ESTANDAR = {
  sin_peso: "Cargá el peso",
  fuera_de_tabla: "Más de 80 kg: fuera de la tabla MRW",
  sin_tarifa: "Sin tarifa MRW para este peso",
} as const;

/**
 * Una fila del inventario.
 *
 * Desde el 25/9/2026 ("El inventario llega de Saint y no se toca a mano",
 * migración 20260925010000) Saint es el único dueño de nombre, precio,
 * existencia y `is_active`: los copia `saint.sync_products()` cada minuto y
 * la base tiene un candado (grants + trigger `security invoker`) que impide
 * que la app los escriba — el mismo candado que ya sacó a Precio de esta
 * fila el 19/9/2026 ("El precio se lee en bolívares") ahora también saca a
 * Stock y al botón Activar/Desactivar. Lo único que sigue siendo editable
 * desde acá es el peso, y queda auditado en `product_weight_audit`.
 *
 * Se guarda al salir del campo (o con Enter), no en cada tecla: escribir
 * "12" no debe pasar por un guardado intermedio en "1".
 *
 * 12/10/2026 (plan "Precio promoción y precio estándar (envío MRW)"): el
 * precio de hoy pasa a llamarse "Precio promoción" y al lado va el "Precio
 * estándar" = promoción + envío MRW según el peso. La tarifa la calcula la
 * base (`shippingFeeUsd`); acá solo se pinta. Como guardar el peso cambia esa
 * tarifa, la fila lleva su propia copia del producto (`vivo`) y la relee tras
 * guardar: `router.refresh()` también lo corrige, pero no es inmediato y el
 * asesor acaba de teclear el peso esperando ver el precio ya.
 */
export function ProductoFila({ product, bcvRate }: { product: Product; bcvRate: number }) {
  const router = useRouter();

  const [vivo, setVivo] = useState(product);
  const [propPrevio, setPropPrevio] = useState(product);
  const [weightDraft, setWeightDraft] = useState(formatWeightInput(product.weightKg));
  const [busy, setBusy] = useState(false);
  const [savedField, setSavedField] = useState<"peso" | null>(null);

  // Patrón "adjusting state when a prop changes" de React: cuando llega un
  // producto nuevo del servidor (`router.refresh()`, otra página, otro
  // filtro) `vivo` se alinea con él durante el render, sin un `setState` en
  // un efecto (`react-hooks/set-state-in-effect`). El borrador del peso solo
  // se pisa si el peso cambió de verdad: un refresh disparado por OTRA fila
  // trae objetos nuevos para todas, y no debe borrarle al asesor lo que está
  // tecleando acá.
  if (product !== propPrevio) {
    setPropPrevio(product);
    setVivo(product);
    if (product.weightKg !== propPrevio.weightKg) setWeightDraft(formatWeightInput(product.weightKg));
  }

  const level = stockLevel(vivo);
  const visibility = aiVisibility(vivo);
  const price = priceDisplay(vivo, bcvRate);
  const estandar = standardPriceDisplay(vivo, bcvRate);
  const nuevoDesdeSaint = isNewFromSaint(vivo);

  async function save(field: "peso", action: () => Promise<void>, revert: () => void) {
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

  async function commitWeight() {
    const parsed = parseWeightInput(weightDraft);
    if (!parsed.ok) {
      setWeightDraft(formatWeightInput(vivo.weightKg));
      toast.danger(parsed.error);
      return;
    }
    if (parsed.value === vivo.weightKg) {
      setWeightDraft(formatWeightInput(parsed.value));
      return;
    }

    await save(
      "peso",
      async () => {
        const supabase = createClient();
        await updateProductWeight(supabase, product.id, parsed.value);
        // El peso ya quedó guardado. Releer el producto trae la tarifa MRW
        // nueva (la calcula la base) para pintar el precio estándar al
        // instante; si la relectura falla NO es un error de guardado —no se
        // revierte ni se avisa—: se toma el peso nuevo y se descarta la tarifa
        // vieja (era la del peso anterior: pintarla sería un precio estándar
        // equivocado); `router.refresh()` trae la buena en cuanto llegue.
        const sinTarifa = (actual: Product) => ({ ...actual, weightKg: parsed.value, shippingFeeUsd: null });
        try {
          const fresco = await fetchProduct(supabase, product.id);
          setVivo((actual) => fresco ?? sinTarifa(actual));
        } catch {
          setVivo(sinTarifa);
        }
      },
      () => setWeightDraft(formatWeightInput(vivo.weightKg))
    );
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
        {/*
         * T5, plan "El mostrador busca sin salir del chat" (27/9/2026):
         * `saintCode` ya viajaba en `Product` desde el 25/9 (`saint_code`)
         * pero la fila no lo pintaba, y los asesores y el dueño lo usan a
         * diario para ubicar el mismo repuesto en Saint. Va como LÍNEA
         * dentro de `.inv-identity` (columna 1 de `.inv-row`), no como
         * columna nueva — la fila es un grid de columnas fijas a propósito
         * (trampa del 10/9/2026: una columna de ancho variable desalinea
         * Stock/Precio/Peso entre filas), y con `align-items: start` que la
         * columna 1 crezca de alto no mueve a las demás. `lm-num` para que
         * los dígitos no salten de ancho; `aria-label` explícito porque el
         * texto visible es solo el número, y un lector de pantalla lo debe
         * anunciar como "Código <x>", no leer el dígito suelto sin
         * contexto. Sin código: texto "Sin código" (decisión: más claro
         * para un lector de pantalla que un "—" atenuado, que puede
         * leerse como "guion" o quedar mudo).
         */}
        {product.saintCode ? (
          <span className="inv-saint-code lm-num" aria-label={`Código ${product.saintCode}`}>
            {product.saintCode}
          </span>
        ) : (
          <span className="inv-saint-code" data-empty="true" aria-label="Sin código Saint">
            Sin código
          </span>
        )}
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
        {/*
         * Stock deja de editarse desde acá el 25/9/2026 ("El inventario
         * llega de Saint y no se toca a mano"): llega de `products`, que
         * `saint.sync_products()` sincroniza cada minuto. Mismo patrón que
         * Precio (19/9/2026) — texto de solo lectura, `data-level` sigue en
         * el `<span className="inv-input-wrap">` (no en el texto) para que
         * el semáforo de `stockLevel` se siga pintando igual.
         */}
        <span className="inv-input-wrap" data-level={level}>
          <span className="lm-num inv-readonly" aria-label={`Stock de ${product.name}`}>
            {product.stockQuantity}
          </span>
        </span>
        {/* Pie vacío: Stock mide lo mismo que Precio/Peso (T7, 10/9/2026). */}
        <span className="inv-bs" aria-hidden="true" />
      </label>

      <label className="inv-field">
        <span className="lm-eyebrow">Precio promoción</span>
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
          <span className="lm-num inv-readonly" aria-label={`Precio promoción de ${product.name}`}>
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

      {/*
       * Precio estándar (12/10/2026): promoción + envío MRW por peso. Es un
       * `<div>` y no un `<label>` porque no hay un input al que atarlo.
       * Nunca un número incompleto: sin tarifa, un texto que dice por qué
       * (y qué hacer). El pie `.inv-bs` se renderiza SIEMPRE, igual que en
       * los demás campos, para que todos midan lo mismo (T7, 10/9/2026).
       */}
      <div className="inv-field">
        <span className="lm-eyebrow">Precio estándar</span>
        <span className="inv-input-wrap">
          {estandar.estado === "ok" ? (
            <span className="lm-num inv-readonly" aria-label={`Precio estándar de ${product.name}`}>
              {estandar.principal}
            </span>
          ) : (
            <span className="inv-readonly" data-empty="true">
              {MOTIVO_SIN_ESTANDAR[estandar.estado]}
            </span>
          )}
        </span>
        {estandar.estado === "ok" && estandar.pie !== null ? (
          <span className="inv-bs lm-num">{estandar.pie}</span>
        ) : (
          <span className="inv-bs" aria-hidden="true" />
        )}
        {estandar.estado === "ok" && <span className="inv-fee">incluye envío MRW {estandar.tarifa}</span>}
      </div>

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

        {vivo.weightKg === null && (
          <span
            className="ac-badge"
            data-tone="wait"
            title="Cashea exige el peso para el envío gratis, y sin peso no hay precio estándar"
          >
            <TriangleAlert size={11} />
            Sin peso
          </span>
        )}

        {nuevoDesdeSaint && (
          <span
            className="ac-badge"
            data-tone="link"
            title={`Entró desde Saint el ${new Date(product.saintAddedAt as string).toLocaleDateString("es-VE", {
              day: "numeric",
              month: "short",
            })}; cargale el peso.`}
          >
            <Sparkles size={11} />
            Nuevo desde Saint
          </span>
        )}
      </div>
    </li>
  );
}
