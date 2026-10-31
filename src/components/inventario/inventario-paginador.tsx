"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { inventoryHref, type InventoryParams } from "@/lib/inventory";

/**
 * A qué página ir según lo que el asesor tecleó, o `null` si no hay destino.
 *
 * Con ~155 páginas de 40 repuestos, Anterior/Siguiente no alcanza (13/10/2026).
 * Vacío o no numérico no navega; un decimal se redondea hacia abajo; fuera de
 * rango se acota a la primera o a la última en vez de fallar.
 */
export function paginaDestino(texto: string, pages: number): number | null {
  const limpio = texto.trim();
  if (limpio === "") return null;

  const numero = Number(limpio);
  if (!Number.isFinite(numero)) return null;

  const entero = Math.floor(numero);
  if (entero < 1) return 1;
  if (entero > pages) return pages;
  return entero;
}

/**
 * Qué números de página se dibujan (30/10/2026, plan «Cada repuesto con su foto»,
 * T5a; `paginasVisibles()` del mockup): la primera, la última, la actual y sus
 * dos vecinas. Todo hueco entre dos números se marca con un «…», aunque falte una
 * sola página — con ~160 páginas el caso común es 1 … 86 87 88 … 161.
 */
export function paginasVisibles(actual: number, total: number): (number | "…")[] {
  const conservadas = [...new Set([1, total, actual - 1, actual, actual + 1].filter((n) => n >= 1 && n <= total))].sort(
    (a, b) => a - b
  );

  const salida: (number | "…")[] = [];
  conservadas.forEach((n, i) => {
    if (i > 0 && n - conservadas[i - 1] > 1) salida.push("…");
    salida.push(n);
  });
  return salida;
}

interface InventarioPaginadorProps {
  params: InventoryParams;
  pages: number;
}

/**
 * Paginación del Inventario: flechas y números de página (enlaces, funcionan
 * sin JavaScript y se abren en otra pestaña) y un campo "Ir a la página" para
 * los saltos largos.
 *
 * `aria-current="page"` va en el NÚMERO de la página actual. Antes iba en el
 * indicador "Página N de M" del formulario porque era lo único que decía cuál
 * era; con los números, ese indicador es solo el rótulo de un control para
 * CAMBIAR de página y no debe repetir la marca (dos `aria-current="page"` en el
 * mismo `nav` se anuncian como dos páginas actuales).
 */
export function InventarioPaginador({ params, pages }: InventarioPaginadorProps) {
  const router = useRouter();
  const [draft, setDraft] = useState(String(params.page));

  // Si la URL cambia por fuera (Anterior/Siguiente, atrás del navegador) el
  // campo refleja la página real. Se ajusta durante el render y no en un
  // efecto (patrón "ajustar estado cuando cambia una prop", regla
  // `react-hooks/set-state-in-effect`).
  const [lastPage, setLastPage] = useState(params.page);
  if (params.page !== lastPage) {
    setLastPage(params.page);
    setDraft(String(params.page));
  }

  function irA(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const destino = paginaDestino(draft, pages);
    if (destino === null) {
      // Nada usable: el campo vuelve a mostrar dónde está el asesor.
      setDraft(String(params.page));
      return;
    }

    setDraft(String(destino));
    if (destino === params.page) return;
    router.push(inventoryHref({ ...params, page: destino }));
  }

  const numeros = paginasVisibles(params.page, pages);

  return (
    <nav className="cli-pager inv-pag" aria-label="Paginación del inventario">
      <div className="inv-pag-pages">
        <Link
          href={inventoryHref({ ...params, page: Math.max(1, params.page - 1) })}
          aria-label="Anterior"
          aria-disabled={params.page === 1}
          {...(params.page === 1 ? { "data-disabled": "true" } : {})}
        >
          <ChevronLeft size={15} aria-hidden="true" />
        </Link>

        {numeros.map((numero, indice) =>
          numero === "…" ? (
            // Decorativo: ni se anuncia ni se puede pulsar (las páginas de en medio se alcanzan con el campo de al lado).
            <span key={`salto-${indice}`} className="salto" aria-hidden="true">
              …
            </span>
          ) : (
            <Link
              key={numero}
              href={inventoryHref({ ...params, page: numero })}
              aria-label={`Página ${numero}`}
              {...(numero === params.page ? { "aria-current": "page" as const } : {})}
            >
              {numero}
            </Link>
          )
        )}

        <Link
          href={inventoryHref({ ...params, page: Math.min(pages, params.page + 1) })}
          aria-label="Siguiente"
          aria-disabled={params.page === pages}
          {...(params.page === pages ? { "data-disabled": "true" } : {})}
        >
          <ChevronRight size={15} aria-hidden="true" />
        </Link>
      </div>

      {/* noValidate: el max/min del input solo orienta al teclado; sin esto el
          navegador bloquea el envío de un 999 con su globo nativo y nunca llega
          `paginaDestino`, que es quien acota el número a la última página. */}
      <form className="inv-paginador" onSubmit={irA} noValidate>
        <span className="cli-pager-note inv-paginador-nota">
          Página{" "}
          <input
            className="inv-paginador-input lm-num"
            type="number"
            inputMode="numeric"
            min={1}
            max={pages}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Ir a la página"
          />{" "}
          de <span className="lm-num">{pages}</span>
        </span>
        <button type="submit" className="crm-pill inv-paginador-ir">
          Ir
        </button>
      </form>
    </nav>
  );
}
