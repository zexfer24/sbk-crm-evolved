"use client";

import { useEffect, useState } from "react";

/**
 * Reloj único de Asesores (plan "Paneles", 13/11/2026). La pantalla tiene
 * varios contadores en vivo (el aviso del mensaje más viejo y la espera de cada
 * conversación de la cola): todos leen ESTE reloj, así que hay un solo
 * `setInterval` de 1 s en toda la página en vez de uno por fila.
 *
 * Se detiene con la pestaña oculta (`document.hidden`): un contador que nadie
 * mira no justifica despertar la CPU cada segundo. Al volver se pone al día de
 * inmediato (con la hora real, no sumando ticks perdidos) y reanuda.
 *
 * Arranca en `inicial` (el instante del servidor) para que el HTML del servidor
 * y la hidratación pinten lo mismo; el primer tick lo reemplaza por la hora del
 * navegador. `activo = false` (sin pendientes que medir) no crea ningún
 * intervalo.
 */
export function useReloj(inicial: Date, activo = true): Date {
  const [ahora, setAhora] = useState(inicial);

  useEffect(() => {
    if (!activo) return;

    let id: ReturnType<typeof setInterval> | null = null;
    const arrancar = () => {
      if (id === null) id = setInterval(() => setAhora(new Date()), 1000);
    };
    const parar = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const alCambiarVisibilidad = () => {
      if (document.hidden) {
        parar();
      } else {
        setAhora(new Date());
        arrancar();
      }
    };

    if (!document.hidden) arrancar();
    document.addEventListener("visibilitychange", alCambiarVisibilidad);
    return () => {
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
      parar();
    };
  }, [activo]);

  return ahora;
}
