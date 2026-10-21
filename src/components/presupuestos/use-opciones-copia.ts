"use client";

import { useState } from "react";
import { guardarOpcionesCopia, leerOpcionesCopia, OPCIONES_COPIA_INICIALES, type OpcionesCopia } from "@/lib/copia-carrito";

/**
 * Las casillas de «qué incluir al copiar» de un asesor, recordadas en
 * `localStorage` (21/10/2026, plan "Presupuestos y mensajes rápidos", T3).
 *
 * El inicializador es perezoso y lee una sola vez; si cambia `agentId` (el
 * perfil llega después del primer render, o se cierra la sesión y entra otro
 * asesor) relee con el patrón "Adjusting state when a prop changes" de React,
 * durante el render, y NO con un efecto que haga `setState`
 * (`react-hooks/set-state-in-effect`). Con `typeof window` defensivo: en el
 * servidor no hay `localStorage` y se usan las casillas iniciales.
 */
function leerSeguro(agentId: string | null): OpcionesCopia {
  return typeof window === "undefined" ? { ...OPCIONES_COPIA_INICIALES } : leerOpcionesCopia(agentId);
}

export function useOpcionesCopia(agentId: string | null): [OpcionesCopia, (opciones: OpcionesCopia) => void] {
  const [opciones, setOpcionesEstado] = useState<OpcionesCopia>(() => leerSeguro(agentId));
  const [agenteLeido, setAgenteLeido] = useState<string | null>(agentId);

  if (agentId !== agenteLeido) {
    setAgenteLeido(agentId);
    setOpcionesEstado(leerSeguro(agentId));
  }

  function setOpciones(nuevas: OpcionesCopia) {
    setOpcionesEstado(nuevas);
    guardarOpcionesCopia(agentId, nuevas);
  }

  return [opciones, setOpciones];
}
