"use client";

import { Moon, Sun } from "lucide-react";
import type { MouseEvent } from "react";
import { useTheme } from "@/lib/use-theme";
import { prefiereMenosMovimiento } from "@/lib/theme-transition";

/**
 * `back.out(2)` de GSAP aproximado con un `cubic-bezier` (aquí no hay GSAP):
 * sale rápido, se pasa de 1 y vuelve. El control en y = 1.7 da un sobrepaso un
 * poco mayor que el `easeOutBack` por defecto (1.56), que es el de `back.out(1.7)`.
 */
export const EASING_ICONO_TEMA = "cubic-bezier(.34,1.7,.64,1)";
export const DURACION_ICONO_TEMA_MS = 600;

/** M22: el ícono entra girando, de {rotación -90°, escala .6} a {0°, 1} (WAAPI, sin GSAP). */
function girarIconos(boton: HTMLElement) {
  if (prefiereMenosMovimiento()) return;
  boton.querySelectorAll("svg").forEach((icono) => {
    if (typeof icono.animate !== "function") return;
    icono.animate(
      [{ transform: "rotate(-90deg) scale(0.6)" }, { transform: "rotate(0deg) scale(1)" }],
      { duration: DURACION_ICONO_TEMA_MS, easing: EASING_ICONO_TEMA }
    );
  });
}

/**
 * Interruptor de tema para la barra lateral.
 *
 * Un solo botón y no tres opciones: la elección real es "claro o oscuro", y
 * "seguir al sistema" es el estado de partida, no algo que la gente vaya a
 * buscar. Se conserva igual —quien nunca tocó el botón sigue al sistema— pero
 * no ocupa un control propio.
 *
 * El icono muestra a dónde lleva el botón, no dónde se está: en claro se ve
 * una luna porque tocarlo apaga la luz. Es la convención de casi todas las
 * apps y evita el "¿esto es el estado o la acción?".
 *
 * Desde el 15/11/2026 el cambio usa la animación M22 del «Laboratorio de
 * movimiento» de Liminal CRM V3 (`theme-transition.ts`): un círculo que crece
 * desde este botón, y el ícono que entra girando. Vale para todo `ThemeToggle`,
 * esté donde esté.
 */
export function ThemeToggle({ variant = "dash" }: { variant?: "crm" | "dash" }) {
  const { resolved, setPreference } = useTheme();
  const isDark = resolved === "dark";
  const label = isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro";

  // Los dos iconos van siempre en el DOM y el CSS muestra uno según
  // `data-theme`. Elegirlo acá con `isDark ? <Sun/> : <Moon/>` rompía la
  // hidratación: el servidor no conoce el tema (vive en localStorage) y
  // asumía claro, así que en oscuro React encontraba el icono equivocado y
  // regeneraba el árbol entero en cada carga. El CSS sí acierta desde el
  // primer pintado, porque el script del <head> ya dejó `data-theme` puesto.
  //
  // `suppressHydrationWarning`: la etiqueta y aria-pressed siguen calculados
  // en el cliente y difieren del HTML del servidor un instante; son atributos
  // (no estructura), así que basta con silenciar el aviso en este botón.
  return (
    <button
      className={`${variant}-rail-btn`}
      type="button"
      onClick={(evento: MouseEvent<HTMLButtonElement>) => {
        // El círculo de la transición nace en el centro del botón (M22).
        const boton = evento.currentTarget;
        const caja = boton.getBoundingClientRect();
        girarIconos(boton);
        setPreference(isDark ? "light" : "dark", { x: caja.left + caja.width / 2, y: caja.top + caja.height / 2 });
      }}
      aria-label={label}
      title={label}
      aria-pressed={isDark}
      suppressHydrationWarning
    >
      <Sun size={17} className="lm-icon-sun" aria-hidden="true" />
      <Moon size={17} className="lm-icon-moon" aria-hidden="true" />
    </button>
  );
}
