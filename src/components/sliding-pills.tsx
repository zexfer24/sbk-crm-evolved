"use client";

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "@/components/sliding-pills.css";

// ---------------------------------------------------------------------------
// Selector de píldoras donde la píldora activa se DESLIZA de una opción a
// otra en vez de saltar.
//
// La técnica no es mover un fondo: es duplicar la fila entera, pintar la
// copia con el estilo activo (fondo oscuro, texto blanco) y recortarla con
// clip-path para que solo se vea la opción seleccionada. Animar ese recorte
// hace que fondo y texto cambien exactamente al mismo tiempo — con dos
// transiciones de color separadas nunca terminan de coincidir, y se nota.
//
// Como es una sola propiedad animable, corre fuera del hilo principal: no se
// entrecorta aunque la bandeja esté cargando conversaciones al mismo tiempo.
// ---------------------------------------------------------------------------

export interface PillItem<T extends string> {
  value: T;
  label: string;
  /** Ícono a la izquierda de la etiqueta. */
  icon?: ReactNode;
  /** Contador a la derecha. Se pinta con el estilo de `lm-pill-count`. */
  count?: number;
}

interface SlidingPillsProps<T extends string> {
  items: PillItem<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** `tablist` para pestañas que cambian el contenido de la página; `group` para filtros. */
  variant?: "group" | "tablist";
  /** `solid`: píldora oscura suelta. `segmented`: control segmentado sobre fondo hundido. */
  tone?: "solid" | "segmented";
  className?: string;
}

const CORNER_RADIUS: Record<"solid" | "segmented", number> = { solid: 999, segmented: 9 };

/** Recorte que deja ver solo el botón activo dentro de la fila. */
function insetAround(button: HTMLElement | null, container: HTMLElement | null, radius: number): string {
  if (!button || !container) return "inset(0 100% 0 0)";

  // offsetLeft/offsetWidth ya vienen medidos contra el contenedor, así que el
  // padding del control segmentado queda contemplado sin cuentas aparte.
  const left = button.offsetLeft;
  const right = container.offsetWidth - (button.offsetLeft + button.offsetWidth);
  return `inset(0 ${Math.max(right, 0)}px 0 ${Math.max(left, 0)}px round ${radius}px)`;
}

export function SlidingPills<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  variant = "group",
  tone = "solid",
  className,
}: SlidingPillsProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [clipPath, setClipPath] = useState("inset(0 100% 0 0)");

  const measure = useCallback(() => {
    setClipPath(insetAround(buttonRefs.current.get(value) ?? null, containerRef.current, CORNER_RADIUS[tone]));
  }, [value, tone]);

  // useLayoutEffect y no useEffect: el recorte tiene que estar puesto antes
  // del primer pintado, si no la píldora arranca en el borde y se desliza
  // sola al entrar a la página.
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // El ancho de las opciones cambia con el contenedor (y con los contadores,
  // que se actualizan en vivo): sin esto el recorte queda desfasado.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure]);

  // El contenedor es `width: fit-content`, con tope en el espacio disponible
  // del panel: en cuanto la fila ya desborda (el carril scrollea, ver
  // crm-inbox-pills-scroll), ese ancho queda fijo y agrandar la píldora
  // activa —el conteo de "Pendientes" pasando de un dígito a dos, o de dos a
  // tres— no lo mueve. El observer de arriba no se entera y el recorte queda
  // corrido respecto del botón real. Se observa también el botón activo, que
  // sí cambia de ancho con su propio contenido.
  useLayoutEffect(() => {
    const button = buttonRefs.current.get(value) ?? null;
    if (!button || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);
    observer.observe(button);
    return () => observer.disconnect();
  }, [measure, value]);

  const isTablist = variant === "tablist";

  function renderRow(active: boolean) {
    return items.map((item) => {
      const selected = item.value === value;
      return (
        <button
          key={item.value}
          type="button"
          className="lm-pill"
          // Solo la fila de abajo es la real; la copia es decorativa.
          ref={active ? undefined : (node) => {
            if (node) buttonRefs.current.set(item.value, node);
            else buttonRefs.current.delete(item.value);
          }}
          tabIndex={active ? -1 : undefined}
          role={isTablist && !active ? "tab" : undefined}
          aria-selected={isTablist && !active ? selected : undefined}
          aria-pressed={!isTablist && !active ? selected : undefined}
          onClick={active ? undefined : () => onChange(item.value)}
        >
          {item.icon}
          {item.label}
          {item.count !== undefined && <span className="lm-pill-count">{item.count}</span>}
        </button>
      );
    });
  }

  return (
    <div
      ref={containerRef}
      className={className ? `lm-pills ${className}` : "lm-pills"}
      data-tone={tone}
      role={isTablist ? "tablist" : "group"}
      aria-label={ariaLabel}
    >
      {renderRow(false)}
      <div className="lm-pills-active" style={{ clipPath }} aria-hidden="true">
        {renderRow(true)}
      </div>
    </div>
  );
}
