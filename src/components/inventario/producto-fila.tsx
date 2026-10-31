"use client";

import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Camera, Check, EyeOff, ImagePlus, Sparkles, TriangleAlert } from "lucide-react";
import { toast } from "@heroui/react";
import type { Product } from "@/lib/types";
import { fotoPrincipal } from "@/lib/product-photos";
import { createClient } from "@/lib/supabase/client";
import { updateProductWeight } from "@/lib/mutations";
import { fetchProduct } from "@/lib/inventory-data";
import {
  MOTIVO_SIN_ESTANDAR,
  aiVisibility,
  formatWeightInput,
  isNewFromSaint,
  parseWeightInput,
  precioDivisaDisplay,
  priceDisplay,
  sinPeso,
  standardPriceDisplay,
  stockLevel,
  TEXTO_SIN_PRECIO_SAINT,
} from "@/lib/inventory";
import { CasheaCalculadora } from "@/components/inventario/cashea-calculadora";
import { CasheaLogo } from "@/components/inventario/cashea-logo";
import { CarritoMasIcon } from "@/components/inventario/iconos";
import { useInventarioCarrito } from "@/components/inventario/inventario-carrito-context";

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
export function ProductoFila({
  product,
  bcvRate,
  soloLectura = false,
  puedeEditarFotos = false,
  onAbrirFicha,
}: {
  product: Product;
  bcvRate: number;
  /**
   * Rol `caja` (13/10/2026): la base solo le deja leer el inventario, así que
   * el peso se muestra como texto —sin input, sin guardado ni botón «Falta el
   * peso»—. Cashea y el carrito siguen: son consulta, no escritura. Desde el
   * 14/10/2026 tampoco ve el Precio estándar (la columna no se renderiza).
   */
  soloLectura?: boolean;
  /** Supervisor y admin (D1): sin foto, la miniatura ofrece «Agregar foto». */
  puedeEditarFotos?: boolean;
  /** Abre la ficha del repuesto (foto y nombre); la vista monta UNA sola ficha. */
  onAbrirFicha?: (productId: string) => void;
}) {
  const router = useRouter();
  const pesoRef = useRef<HTMLInputElement>(null);

  const [vivo, setVivo] = useState(product);
  const [propPrevio, setPropPrevio] = useState(product);
  const [weightDraft, setWeightDraft] = useState(formatWeightInput(product.weightKg));
  const [busy, setBusy] = useState(false);
  const [savedField, setSavedField] = useState<"peso" | null>(null);
  const [casheaAbierta, setCasheaAbierta] = useState(false);
  // `null` fuera del provider (tests y pantallas viejas): sin carrito no hay «Agregar».
  const carrito = useInventarioCarrito();

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
  const divisa = precioDivisaDisplay(vivo);
  const nuevoDesdeSaint = isNewFromSaint(vivo);
  const enCarrito = carrito?.cantidadDe(vivo.id) ?? 0;
  const principal = fotoPrincipal(vivo);
  const faltaPeso = sinPeso(vivo.weightKg);
  // Sin ninguna insignia no se pinta ni el contenedor: una fila normal queda limpia.
  const hayInsignias = !visibility.visible || visibility.warning !== null || faltaPeso || nuevoDesdeSaint;

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

  /** «Falta el peso: cargalo →»: lleva el cursor al campo de ESTA fila, con el contenido seleccionado. */
  function irAlPeso() {
    pesoRef.current?.focus();
    pesoRef.current?.select();
  }

  return (
    <li
      className="inv-row"
      data-inactive={product.isActive ? undefined : "true"}
      data-solo-lectura={soloLectura ? "true" : undefined}
    >
      {/*
        * Identidad (30/10/2026, plan «Cada repuesto con su foto», T5a): la
        * miniatura de 72 px y el nombre abren la ficha; el código, la marca y
        * las insignias van bajo el nombre. Se fue la columna `.inv-status` —
        * el color del stock ya dice «agotado», y «La IA lo ofrece» era ruido
        * en el 99 % de las filas— y el texto de compatibilidad (decisión del
        * operador: casi todas decían «Sin compatibilidad declarada»).
        */}
      <div className="inv-identity">
        {principal ? (
          <button
            type="button"
            className="foto-thumb"
            aria-label={`Ver fotos de ${product.name}`}
            onClick={() => onAbrirFicha?.(product.id)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- URL pública de Storage ya dimensionada; no pasa por el optimizador de Next */}
            <img src={principal.url} alt="" loading="lazy" />
            {vivo.fotos.length > 1 && <span className="foto-count">{vivo.fotos.length}</span>}
          </button>
        ) : (
          <button
            type="button"
            className="foto-thumb"
            data-vacia="true"
            aria-label={puedeEditarFotos ? `Agregar foto a ${product.name}` : `Ver ficha de ${product.name}`}
            title={puedeEditarFotos ? "Agregar foto" : "Sin foto"}
            onClick={() => onAbrirFicha?.(product.id)}
          >
            {puedeEditarFotos ? <ImagePlus size={20} aria-hidden="true" /> : <Camera size={20} aria-hidden="true" />}
          </button>
        )}

        <div className="inv-identity-text">
          <button type="button" className="inv-name" onClick={() => onAbrirFicha?.(product.id)}>
            {product.name}
          </button>
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
          {product.brand && (
            <span className="inv-facts">
              <span className="inv-brand">{product.brand}</span>
            </span>
          )}
          {hayInsignias && (
            <span className="inv-badges">
              {visibility.visible ? (
                visibility.warning ? (
                  <span className="ac-badge" data-tone="wait" title={visibility.warning}>
                    <TriangleAlert size={11} />
                    Sin stock
                  </span>
                ) : null
              ) : (
                <span className="ac-badge" data-tone="muted" title={visibility.warning ?? undefined}>
                  <EyeOff size={11} />
                  Oculto a la IA
                </span>
              )}

              {faltaPeso && (
                <span
                  className="ac-badge"
                  data-tone="wait"
                  title={
                    soloLectura
                      ? "Cashea exige el peso para el envío gratis"
                      : "Cashea exige el peso para el envío gratis, y sin peso no hay precio estándar"
                  }
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
                  })}${soloLectura ? "." : "; cargale el peso."}`}
                >
                  <Sparkles size={11} />
                  Nuevo desde Saint
                </span>
              )}
            </span>
          )}
        </div>
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
       * Precio divisa (30/10/2026, plan "Precio divisa desde SAINT"): el
       * `Precio1` de SAINT, ya en USD, entre promoción y estándar. Solo
       * informativo: sin botón ni conversión con la tasa. Lo ve también la caja
       * (decisión del operador), por eso va FUERA del `!soloLectura` — y por eso
       * cada plantilla de `.inv-row` en `inventario.css` suma su columna fija de
       * 110px (un hijo de más sin columna correría Peso, estado y acciones,
       * trampa del 10/9/2026). `<div>`, no `<label>`: no hay input al que
       * atarlo. El pie `.inv-bs` va SIEMPRE, vacío, para que mida lo mismo que
       * los demás campos.
       */}
      <div className="inv-field">
        <span className="lm-eyebrow">Precio divisa</span>
        <span className="inv-input-wrap">
          {divisa.estado === "ok" ? (
            <span className="lm-num inv-readonly" aria-label={`Precio divisa de ${product.name}`}>
              {divisa.principal}
            </span>
          ) : (
            <span className="inv-readonly" data-empty="true">
              {TEXTO_SIN_PRECIO_SAINT}
            </span>
          )}
        </span>
        <span className="inv-bs" aria-hidden="true" />
      </div>

      {/*
       * Precio estándar (12/10/2026): promoción + envío MRW por peso. Es un
       * `<div>` y no un `<label>` porque no hay un input al que atarlo.
       * Nunca un número incompleto: sin tarifa, un texto que dice por qué
       * (y qué hacer). El pie `.inv-bs` se renderiza SIEMPRE, igual que en
       * los demás campos, para que todos midan lo mismo (T7, 10/9/2026).
       *
       * 14/10/2026 (plan "La caja no ve el precio estándar"): la caja NO
       * recibe este campo — ni el monto, ni «incluye envío MRW», ni el
       * motivo — y la columna desaparece de verdad, no se vacía: la fila de
       * caja lleva su propia plantilla de seis columnas (`data-solo-lectura`
       * en `inventario.css`). Sacar el hijo con la plantilla de siete
       * correría Peso, estado y acciones una columna (trampa del 10/9/2026).
       */}
      {!soloLectura && (
        <div className="inv-field">
          <span className="lm-eyebrow">Precio estándar</span>
          <span className="inv-input-wrap">
            {estandar.estado === "ok" ? (
              <span className="lm-num inv-readonly" aria-label={`Precio estándar de ${product.name}`}>
                {estandar.principal}
              </span>
            ) : estandar.estado === "sin_peso" ? (
              // Acción pendiente, no un texto atenuado (13/10/2026): el asesor
              // que ve el hueco llega al campo de peso con un clic.
              <button type="button" className="inv-falta-peso" onClick={irAlPeso}>
                {/* Espacio duro antes de la flecha: en la caja de 150px la flecha
                    quedaba sola en la segunda línea (visto con Playwright, 13/10/2026). */}
                Falta el peso: {"cargalo →"}
              </button>
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
          {estandar.estado === "ok" && (
            // «incluye envío», nunca «MRW» (pedido del cliente, 30/10/2026): el monto va aparte, en `lm-num`.
            <span className="inv-fee">
              incluye envío <span className="lm-num">{estandar.tarifa}</span>
            </span>
          )}
        </div>
      )}

      {soloLectura ? (
        // Misma caja y mismo pie vacío que el campo editable: la fila no
        // cambia de alto ni de columnas (trampa del 10/9/2026).
        <div className="inv-field">
          <span className="lm-eyebrow">Peso (kg)</span>
          <span className="inv-input-wrap">
            <span className="lm-num inv-readonly" aria-label={`Peso de ${product.name}`}>
              {vivo.weightKg === null ? "—" : formatWeightInput(vivo.weightKg)}
            </span>
          </span>
          <span className="inv-bs" aria-hidden="true" />
        </div>
      ) : (
        <label className="inv-field">
          <span className="lm-eyebrow">Peso (kg)</span>
          <span className="inv-input-wrap">
            <input
              ref={pesoRef}
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
      )}

      {/*
       * Acciones de la fila (13/10/2026, plan "Inventario y caja", T2): antes
       * «Agregar» y «Cashea» eran insignias `.ac-badge` mezcladas con los
       * estados y no se leían como botones. Ahora son botones de verdad en un
       * bloque propio, ÚLTIMO hijo de la fila y con columna de ancho FIJO en
       * `.inv-row` (trampa del 10/9/2026: una columna `auto` repartiría
       * distinto en cada fila según "En carrito ×99" o "Agregar al carrito").
       *
       * 30/10/2026 (plan «Cada repuesto con su foto», T5a): pasan a ser dos
       * botones de ÍCONO de 38x38 (`.inv-icon-btn`, carrito con «+» y logo de
       * Cashea) lado a lado. Sin texto, el conteo ya no se ve en el botón: lo
       * dice su `aria-label` ("hay N en el carrito") y el globo del carrito
       * flotante. Deuda conocida: quien mira la lista no ve de un vistazo qué
       * repuestos ya agregó.
       *
       * Carrito (12/10/2026, plan "Carrito de cotización en el Inventario,
       * con Cashea", T5): no se ofrece sin provider, está deshabilitado si
       * Saint dio de baja el producto y se deja agregar sin stock: el asesor
       * puede cotizar algo que está por llegar. Cashea (12/10/2026) es una
       * cuenta, no una venta: sale también sin stock o inactivo.
       */}
      <div className="inv-acciones">
        {carrito && (
          <button
            type="button"
            className="inv-icon-btn"
            data-tipo="carrito"
            disabled={!product.isActive}
            title={product.isActive ? "Agregar al carrito" : "Saint lo dio de baja"}
            aria-label={
              enCarrito > 0
                ? `Sumar otra unidad de ${product.name} (hay ${enCarrito} en el carrito)`
                : `Agregar ${product.name} al carrito`
            }
            onClick={() => carrito.agregar(vivo)}
          >
            <CarritoMasIcon />
          </button>
        )}

        <button
          type="button"
          className="inv-icon-btn"
          data-tipo="cashea"
          title="Calcular Cashea"
          aria-label={`Calcular Cashea de ${vivo.name}`}
          onClick={() => setCasheaAbierta(true)}
        >
          <CasheaLogo />
        </button>
        <CasheaCalculadora product={vivo} bcvRate={bcvRate} isOpen={casheaAbierta} onOpenChange={setCasheaAbierta} />
      </div>
    </li>
  );
}
