"use client";

import { useCallback, useEffect, useState } from "react";
import { SlidingPills } from "@/components/sliding-pills";

/**
 * Menú fijo de secciones de Analíticas (plan "Paneles", C5, 13/11/2026). El
 * orden de `SECCIONES` es el orden de la página: el indicador sigue a la
 * sección que cruza una franja de la pantalla y pulsar una baja hasta ella.
 *
 * La URL guarda la sección (`#embudo`): al cargar con `#id` se baja a ella y se
 * resalta un instante (el navegador ya baja solo, pero sin el desfase del menú
 * fijo ni el resaltado). Escribir el hash va por `history.replaceState`, que
 * Next integra con su router, en vez de `location.hash =`, que apilaría una
 * entrada nueva del historial por cada clic.
 */

export const SECCIONES = [
  { id: "ingresos", etiqueta: "Ingresos" },
  { id: "embudo", etiqueta: "Embudo" },
  { id: "ventas-activas", etiqueta: "Ventas activas" },
  { id: "unidades", etiqueta: "Unidades" },
  { id: "conversion", etiqueta: "Conversión" },
  { id: "rendimiento", etiqueta: "Rendimiento" },
  { id: "mensual", etiqueta: "Mensual" },
] as const;

export type SeccionId = (typeof SECCIONES)[number]["id"];

const ES_SECCION = (id: string): id is SeccionId => SECCIONES.some((s) => s.id === id);

function prefiereMovimientoReducido(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Resalta un instante la sección (la clase corre su propia animación y se quita sola). */
function resaltar(elemento: HTMLElement) {
  elemento.classList.remove("an-flash");
  void elemento.offsetWidth; // reinicia la animación si ya estaba puesta
  elemento.classList.add("an-flash");
  window.setTimeout(() => elemento.classList.remove("an-flash"), 1800);
}

export function useNavegacionDeSecciones() {
  const [activa, setActiva] = useState<SeccionId>(SECCIONES[0].id);

  // Baja, deja el hash y resalta, SIN tocar el estado: la carga con `#id` la
  // llama desde un efecto, y ahí el indicador lo mueve el observador de abajo
  // (un setState síncrono en el efecto lo marca `react-hooks/set-state-in-effect`).
  const bajarA = useCallback((id: SeccionId) => {
    const elemento = document.getElementById(id);
    if (!elemento) return;
    elemento.scrollIntoView({ behavior: prefiereMovimientoReducido() ? "auto" : "smooth", block: "start" });
    window.history.replaceState(null, "", `#${id}`);
    resaltar(elemento);
  }, []);

  const irA = useCallback(
    (id: SeccionId) => {
      bajarA(id);
      setActiva(id);
    },
    [bajarA]
  );

  // Al cargar con `#id`: baja a esa sección y la resalta. Un id que no es una
  // sección (o no está) se ignora.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id && ES_SECCION(id)) bajarA(id);
  }, [bajarA]);

  // El indicador sigue a la sección que cruza una franja entre el 25 % y el 40 %
  // de la pantalla; si cruzan dos, gana la primera de la página.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visibles = new Set<string>();
    const observador = new IntersectionObserver(
      (entradas) => {
        for (const entrada of entradas) {
          if (entrada.isIntersecting) visibles.add(entrada.target.id);
          else visibles.delete(entrada.target.id);
        }
        const primera = SECCIONES.find((s) => visibles.has(s.id));
        if (primera) setActiva(primera.id);
      },
      { rootMargin: "-25% 0px -60% 0px" }
    );
    for (const { id } of SECCIONES) {
      const elemento = document.getElementById(id);
      if (elemento) observador.observe(elemento);
    }
    return () => observador.disconnect();
  }, []);

  return { activa, irA };
}

export function NavSecciones({ activa, onIr }: { activa: SeccionId; onIr: (id: SeccionId) => void }) {
  return (
    <nav className="an-nav" aria-label="Secciones de Analíticas">
      <div className="pn-scroll">
        <SlidingPills
          ariaLabel="Ir a una sección"
          tone="segmented"
          value={activa}
          onChange={onIr}
          items={SECCIONES.map((s) => ({ value: s.id, label: s.etiqueta }))}
        />
      </div>
    </nav>
  );
}
