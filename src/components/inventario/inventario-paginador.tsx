"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

interface InventarioPaginadorProps {
  params: InventoryParams;
  pages: number;
}

/**
 * Paginación del Inventario: Anterior/Siguiente (enlaces, funcionan sin
 * JavaScript) y un campo "Ir a la página".
 *
 * `aria-current="page"` va en el indicador "Página N de M" y no en el input:
 * el input es un control para CAMBIAR de página, no el marcador de la actual, y
 * el indicador es el único elemento que dice cuál es sin depender del valor
 * que el asesor esté tecleando.
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

  return (
    <nav className="cli-pager" aria-label="Paginación del inventario">
      <Link
        className="crm-pill"
        href={inventoryHref({ ...params, page: Math.max(1, params.page - 1) })}
        aria-disabled={params.page === 1}
        {...(params.page === 1 ? { "data-disabled": "true" } : {})}
      >
        Anterior
      </Link>

      {/* noValidate: el max/min del input solo orienta al teclado; sin esto el
          navegador bloquea el envío de un 999 con su globo nativo y nunca llega
          `paginaDestino`, que es quien acota el número a la última página. */}
      <form className="inv-paginador" onSubmit={irA} noValidate>
        <span className="cli-pager-note inv-paginador-nota" aria-current="page">
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

      <Link
        className="crm-pill"
        href={inventoryHref({ ...params, page: Math.min(pages, params.page + 1) })}
        aria-disabled={params.page === pages}
        {...(params.page === pages ? { "data-disabled": "true" } : {})}
      >
        Siguiente
      </Link>
    </nav>
  );
}
