"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpDown, Check, ChevronDown } from "lucide-react";
import {
  INVENTORY_FILTER_LABELS,
  INVENTORY_SORT_LABELS,
  inventoryFilterHref,
  inventoryHref,
  ordenPorDefecto,
  type InventoryFilter,
  type InventoryParams,
  type InventorySort,
} from "@/lib/inventory";

/** Los filtros que ofrece «Mostrar», en el orden de la barra de antes más «Sin foto» al final. */
const FILTROS: InventoryFilter[] = ["todos", "agotados", "bajo-stock", "inactivos", "sin-peso", "sin-foto"];

/**
 * «existencia» no es una opción: es el orden por defecto de «Sin peso» (ver
 * `ordenPorDefecto`), igual que cuando eran píldoras.
 */
const ORDENES: InventorySort[] = ["nombre", "stock", "precio"];

/**
 * Caja «Ordenar por» (30/10/2026, plan «Cada repuesto con su foto», T5a;
 * referencia: `menuOrden()` de `mockups/inventario-fotos`).
 *
 * Reemplaza a las DOS tiras de píldoras de la barra (filtros y orden): con seis
 * filtros más tres órdenes la barra ya no cabía en una línea y empujaba al
 * buscador. Es un disclosure —un botón con `aria-expanded` que despliega un
 * panel—, no un `role="menu"`: las opciones son ENLACES, no comandos, y la URL
 * sigue mandando (`q`, `filtro`, `orden`, `page`), así que este componente no
 * guarda estado de filtro ni de orden: lo único que recuerda es si está
 * abierto. Los hrefs son los mismos que armaban las píldoras
 * (`inventoryFilterHref` / `inventoryHref`): el filtro reinicia la página y no
 * arrastra el orden por defecto del anterior, el orden conserva `q` y filtro.
 *
 * El panel NO está montado mientras está cerrado (la barra es sticky y cargaría
 * nueve enlaces ocultos por cada pantalla). Se cierra al elegir —la navegación
 * no desmonta el componente, que vive en la vista—, al tocar fuera y con Esc,
 * que devuelve el foco al botón (quien navega con teclado estaba parado en una
 * opción que desaparece).
 *
 * Un punto azul en el botón avisa que hay un filtro o un orden distinto del
 * que rige por defecto: con el panel cerrado, nada más dice que la lista está
 * filtrada.
 */
export function OrdenMenu({ params }: { params: InventoryParams }) {
  const [abierto, setAbierto] = useState(false);
  const raizRef = useRef<HTMLDivElement>(null);
  const botonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!abierto) return;

    function alPulsarFuera(event: PointerEvent) {
      if (!raizRef.current?.contains(event.target as Node)) setAbierto(false);
    }
    function alTeclear(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setAbierto(false);
      botonRef.current?.focus();
    }

    document.addEventListener("pointerdown", alPulsarFuera);
    document.addEventListener("keydown", alTeclear);
    return () => {
      document.removeEventListener("pointerdown", alPulsarFuera);
      document.removeEventListener("keydown", alTeclear);
    };
  }, [abierto]);

  const hayAlgoActivo = params.filter !== "todos" || params.sort !== ordenPorDefecto(params.filter);

  return (
    <div className="inv-orden" ref={raizRef}>
      <button
        ref={botonRef}
        type="button"
        className="inv-orden-btn"
        aria-expanded={abierto}
        aria-controls={panelId}
        onClick={() => setAbierto((actual) => !actual)}
      >
        <ArrowUpDown size={15} aria-hidden="true" />
        <span>Ordenar por</span>
        {hayAlgoActivo && <span className="inv-orden-punto" aria-hidden="true" />}
        <ChevronDown className="inv-orden-chevron" size={15} aria-hidden="true" />
      </button>

      {abierto && (
        <div id={panelId} className="inv-orden-menu">
          <div className="inv-orden-grupo" role="group" aria-label="Mostrar">
            <p className="inv-orden-titulo" aria-hidden="true">
              Mostrar
            </p>
            {FILTROS.map((filtro) => (
              <Link
                key={filtro}
                href={inventoryFilterHref(params, filtro)}
                onClick={() => setAbierto(false)}
                {...(params.filter === filtro ? { "aria-current": "true" as const } : {})}
              >
                <Check className="inv-orden-check" size={14} aria-hidden="true" />
                <span>{INVENTORY_FILTER_LABELS[filtro]}</span>
                {filtro === "sin-foto" && (
                  // Marca de novedad: decorativa, no forma parte del nombre del enlace.
                  <span className="inv-orden-nuevo" aria-hidden="true">
                    nuevo
                  </span>
                )}
              </Link>
            ))}
          </div>

          <div className="inv-orden-grupo" role="group" aria-label="Ordenar">
            <p className="inv-orden-titulo" aria-hidden="true">
              Ordenar
            </p>
            {ORDENES.map((orden) => (
              <Link
                key={orden}
                href={inventoryHref({ ...params, sort: orden, page: 1 })}
                onClick={() => setAbierto(false)}
                {...(params.sort === orden ? { "aria-current": "true" as const } : {})}
              >
                <Check className="inv-orden-check" size={14} aria-hidden="true" />
                <span>{INVENTORY_SORT_LABELS[orden]}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
