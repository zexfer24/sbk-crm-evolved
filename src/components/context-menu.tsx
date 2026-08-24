"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Margen mínimo con el borde de la pantalla al reacomodar el menú. */
const VIEWPORT_MARGIN = 8;

interface ContextMenuProps {
  /** Dónde se pidió: el cursor en escritorio, el dedo en el teléfono. */
  position: { x: number; y: number };
  onClose: () => void;
  label: string;
  children: ReactNode;
}

/**
 * Un menú anclado a un punto de la pantalla, con lo que todos necesitan:
 * entrar entero aunque se pida junto a un borde, y cerrarse con Escape, al
 * tocar fuera, al desplazar o al cambiar el tamaño de la ventana.
 *
 * Vive aparte porque ya son dos —el de la conversación en la bandeja y el del
 * mensaje en el chat— y esta parte no tiene nada que ver con lo que cada uno
 * ofrece: solo con dónde se pinta y cuándo desaparece.
 */
export function ContextMenu({ position, onClose, label, children }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState(position);

  // Se pide en el punto del cursor, que cerca del borde derecho o de abajo lo
  // dejaría medio fuera. Se mide ya montado y se corre lo justo para que
  // entre entero — antes de pintar, para que no se vea saltar.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPlacement({
      x: Math.max(VIEWPORT_MARGIN, Math.min(position.x, window.innerWidth - width - VIEWPORT_MARGIN)),
      y: Math.max(VIEWPORT_MARGIN, Math.min(position.y, window.innerHeight - height - VIEWPORT_MARGIN)),
    });
  }, [position]);

  useEffect(() => {
    // El menú queda anclado a un punto de la pantalla: si lo que hay debajo se
    // desplaza, deja de señalar aquello que lo abrió. Cerrar es más honesto
    // que seguir al elemento.
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function closeOnOutside(event: Event) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);

    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="crm-context-menu"
      role="menu"
      aria-label={label}
      style={{ left: placement.x, top: placement.y }}
    >
      {children}
    </div>
  );
}
