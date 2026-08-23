"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/use-theme";

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
 */
export function ThemeToggle({ variant = "dash" }: { variant?: "crm" | "dash" }) {
  const { resolved, setPreference } = useTheme();
  const isDark = resolved === "dark";
  const label = isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro";

  return (
    <button
      className={`${variant}-rail-btn`}
      type="button"
      onClick={() => setPreference(isDark ? "light" : "dark")}
      aria-label={label}
      title={label}
      aria-pressed={isDark}
    >
      {isDark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
