"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Tag as TagIcon } from "lucide-react";
import type { Tag } from "@/lib/types";

/**
 * Filtro por categoría, al lado del botón de orden.
 *
 * Antes las etiquetas eran una fila de píldoras debajo del buscador. Con pocas
 * funcionaba; pasadas cinco o seis la fila se parte en tres renglones y le come
 * a la lista de conversaciones el espacio que necesita. Metidas en un menú
 * ocupan siempre lo mismo —un botón— y la bandeja recupera esas líneas.
 *
 * Sigue siendo de selección única, como la barra que reemplaza: filtrar por dos
 * categorías a la vez no es algo que nadie haya pedido, y convertirlo en
 * múltiple obligaría a decidir si se cruzan con "y" o con "o".
 */
interface TagFilterMenuProps {
  tags: Tag[];
  value: string | null;
  onChange: (tagId: string | null) => void;
}

export function TagFilterMenu({ tags, value, onChange }: TagFilterMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Cerrar al tocar afuera o con Escape. Es un menú, no un diálogo: no atrapa
  // el foco ni bloquea la página detrás.
  useEffect(() => {
    if (!isOpen) return;

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  const active = tags.find((tag) => tag.id === value) ?? null;

  function pick(tagId: string | null) {
    onChange(tagId);
    setIsOpen(false);
  }

  return (
    <div className="crm-tag-menu" ref={rootRef}>
      <button
        type="button"
        className="lm-icon-btn crm-sort-btn"
        onClick={() => setIsOpen((open) => !open)}
        data-active={active !== null}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={active ? `Categoría: ${active.label}` : "Filtrar por categoría"}
        title={active ? `Categoría: ${active.label}` : "Filtrar por categoría"}
      >
        <TagIcon size={16} />
      </button>

      {isOpen && (
        <div className="crm-tag-menu-panel" role="menu" aria-label="Filtrar por categoría">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === null}
            className="crm-tag-menu-item"
            onClick={() => pick(null)}
          >
            <span className="crm-tag-menu-check">{value === null && <Check size={13} />}</span>
            Todas las categorías
          </button>

          {tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              role="menuitemradio"
              aria-checked={value === tag.id}
              className="crm-tag-menu-item"
              // Volver a tocar la categoría activa quita el filtro: es el gesto
              // que la gente prueba antes de buscar la opción "Todas".
              onClick={() => pick(value === tag.id ? null : tag.id)}
            >
              <span className="crm-tag-menu-check">{value === tag.id && <Check size={13} />}</span>
              <span className="crm-tag" data-color={tag.color}>
                {tag.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
