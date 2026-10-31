"use client";

import { useState } from "react";
import { Camera, ImagePlus, Sparkles, TriangleAlert, Weight } from "lucide-react";
import type { Product } from "@/lib/types";
import { fotoPrincipal } from "@/lib/product-photos";
import {
  formatWeightInput,
  isNewFromSaint,
  MOTIVO_SIN_ESTANDAR,
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
import "@/components/inventario/inventario-cuadricula.css";

/** Qué dice y de qué color es la píldora que va sobre la foto. */
function estadoDe(product: Product): { tono: "good" | "wait" | "hot" | "muted"; texto: string } {
  if (!product.isActive) return { tono: "muted", texto: "Oculto a la IA" };
  const nivel = stockLevel(product);
  if (nivel === "agotado") return { tono: "hot", texto: "Agotado" };
  if (nivel === "bajo") return { tono: "wait", texto: "Bajo stock" };
  return { tono: "good", texto: "En stock" };
}

/**
 * Una tarjeta de la vista cuadrícula de /inventario (30/10/2026, plan «Cada
 * repuesto con su foto», T5b; referencia: `mockups/inventario-fotos`).
 *
 * Es la misma información que `ProductoFila` pero pensada para MIRAR: la foto
 * manda y las cifras quedan debajo. Por eso reutiliza los helpers de
 * `lib/inventory.ts` tal cual los usa la fila (`priceDisplay`,
 * `standardPriceDisplay`, `precioDivisaDisplay`, `stockLevel`): una tarjeta que
 * calculara distinto a la fila mostraría dos precios para el mismo repuesto.
 *
 * No edita nada: el peso y las fotos se cargan en la ficha, así que «Falta el
 * peso →» y la foto solo llaman a `onAbrirFicha`. La caja (`soloLectura`) no ve
 * el precio estándar (mismo criterio que la fila, 14/10/2026): en su lugar ve
 * el precio divisa, y no ve la divisa del pie.
 */
export function ProductoTarjeta({
  product,
  bcvRate,
  soloLectura = false,
  puedeEditarFotos = false,
  onAbrirFicha,
}: {
  product: Product;
  bcvRate: number;
  soloLectura?: boolean;
  /** Supervisor y admin: sin foto, el hueco ofrece «Agregar foto». */
  puedeEditarFotos?: boolean;
  onAbrirFicha: (productId: string) => void;
}) {
  const [casheaAbierta, setCasheaAbierta] = useState(false);
  // `null` fuera del provider (tests y pantallas viejas): sin carrito no hay botón.
  const carrito = useInventarioCarrito();

  const principal = fotoPrincipal(product);
  const estado = estadoDe(product);
  const nivel = stockLevel(product);
  const promocion = priceDisplay(product, bcvRate);
  const estandar = standardPriceDisplay(product, bcvRate);
  const divisa = precioDivisaDisplay(product);
  const nuevoDesdeSaint = isNewFromSaint(product);
  const enCarrito = carrito?.cantidadDe(product.id) ?? 0;
  const pildora = (
    <span className="inv-estado" data-tone={estado.tono}>
      {estado.texto}
    </span>
  );

  const insigniaNuevo = (
    <span className="ac-badge" data-tone="link">
      <Sparkles size={11} aria-hidden="true" />
      Nuevo desde Saint
    </span>
  );

  return (
    <li className="inv-card" data-inactive={product.isActive ? undefined : "true"}>
      {principal ? (
        <button
          type="button"
          className="inv-card-foto"
          aria-label={`Ver fotos de ${product.name}`}
          onClick={() => onAbrirFicha(product.id)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- URL pública de Storage ya dimensionada; no pasa por el optimizador de Next */}
          <img src={principal.url} alt={product.name} loading="lazy" />
          {pildora}
          {product.fotos.length > 1 && (
            <span className="inv-card-count">
              <Camera size={12} aria-hidden="true" />
              {product.fotos.length}
            </span>
          )}
        </button>
      ) : (
        <button
          type="button"
          className="inv-card-foto"
          data-vacia="true"
          aria-label={puedeEditarFotos ? `Agregar foto a ${product.name}` : `Ver ficha de ${product.name}`}
          onClick={() => onAbrirFicha(product.id)}
        >
          {pildora}
          <Camera className="vacia-ic" size={24} aria-hidden="true" />
          {puedeEditarFotos ? (
            <span className="agregar-foto">
              <ImagePlus size={14} aria-hidden="true" />
              Agregar foto
            </span>
          ) : (
            <span className="vacia-txt">Sin foto</span>
          )}
        </button>
      )}

      <div className="inv-card-titulo">
        <p className="inv-card-nombre" title={product.name}>
          {product.name}
        </p>
        <span className="inv-card-codigo">
          {product.saintCode ? (
            <span className="lm-num" aria-label={`Código ${product.saintCode}`}>
              {product.saintCode}
            </span>
          ) : (
            <span data-empty="true" aria-label="Sin código Saint">
              Sin código
            </span>
          )}
          {product.brand && <span className="inv-brand">{product.brand}</span>}
          {/* La caja lo ve en el pie (como en el mockup): su título queda más limpio. */}
          {!soloLectura && nuevoDesdeSaint && insigniaNuevo}
        </span>
      </div>

      <div className="inv-card-cifras">
        <div className="inv-cifra">
          <span className="etq">Stock</span>
          <span className="inv-stock-caja" data-level={nivel} aria-label={`Stock de ${product.name}`}>
            {product.stockQuantity}
          </span>
        </div>

        <div className="inv-cifra">
          <span className="etq">Precio promoción</span>
          <span className="val">{promocion.principal}</span>
          {promocion.pie !== null && <span className="sub">{promocion.pie}</span>}
        </div>

        {soloLectura ? (
          <div className="inv-cifra">
            <span className="etq">Precio divisa</span>
            {divisa.estado === "ok" ? (
              <>
                <span className="val">{divisa.principal}</span>
                <span className="sub">De SAINT</span>
              </>
            ) : (
              <span className="sub motivo">{TEXTO_SIN_PRECIO_SAINT}</span>
            )}
          </div>
        ) : (
          <div className="inv-cifra">
            <span className="etq">Precio estándar</span>
            {estandar.estado === "ok" ? (
              <>
                <span className="val">{estandar.principal}</span>
                {estandar.pie !== null && <span className="sub">{estandar.pie}</span>}
              </>
            ) : estandar.estado === "sin_peso" ? (
              // Acción pendiente, no un texto atenuado (mismo criterio que la fila, 13/10/2026):
              // el peso se carga en la ficha, así que el botón la abre.
              <button type="button" className="falta" onClick={() => onAbrirFicha(product.id)}>
                Falta el peso →
              </button>
            ) : (
              <span className="sub motivo">{MOTIVO_SIN_ESTANDAR[estandar.estado]}</span>
            )}
          </div>
        )}
      </div>

      <div className="inv-card-pie">
        {sinPeso(product.weightKg) ? (
          <span className="sin-peso">
            <TriangleAlert size={14} aria-hidden="true" />
            Sin peso
          </span>
        ) : (
          <span>
            <Weight size={14} aria-hidden="true" />
            Peso <strong>{formatWeightInput(product.weightKg)} kg</strong>
          </span>
        )}
        {soloLectura ? (
          nuevoDesdeSaint ? insigniaNuevo : null
        ) : (
          <span>
            Divisa <strong>{divisa.estado === "ok" ? divisa.principal : "—"}</strong>
          </span>
        )}
      </div>

      {/*
       * Dos botones de ícono, a lo ancho en dos columnas iguales. Carrito: no se
       * ofrece sin provider, queda deshabilitado si Saint dio de baja el
       * producto y se deja agregar sin stock (el asesor puede cotizar algo que
       * está por llegar, igual que en la fila). Cashea es una cuenta, no una
       * venta: sale también sin stock o inactivo. Sin carrito el bloque queda
       * con un solo botón, que ocupa la primera columna (`grid-auto-flow`).
       */}
      <div className="inv-card-acciones">
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
            onClick={() => carrito.agregar(product)}
          >
            <CarritoMasIcon />
          </button>
        )}
        <button
          type="button"
          className="inv-icon-btn"
          data-tipo="cashea"
          title="Calcular Cashea"
          aria-label={`Calcular Cashea de ${product.name}`}
          onClick={() => setCasheaAbierta(true)}
        >
          <CasheaLogo />
        </button>
      </div>
      <CasheaCalculadora product={product} bcvRate={bcvRate} isOpen={casheaAbierta} onOpenChange={setCasheaAbierta} />
    </li>
  );
}
