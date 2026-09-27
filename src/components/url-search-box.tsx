"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";

/**
 * Cuadro de búsqueda que escribe en la URL.
 *
 * Lo usan Clientes e Inventario: en las dos, la búsqueda la resuelve el
 * servidor, así que esta es la única parte de la lista que necesita
 * JavaScript. No guarda resultados ni conoce el dominio — recibe a dónde
 * navegar y qué parámetros conservar.
 *
 * `keep` viene ya depurado desde el componente de servidor (solo lo que no
 * es el valor por defecto), y nunca incluye la página: al cambiar la
 * búsqueda se vuelve a la primera, porque la página 7 de la lista anterior
 * no significa nada en la nueva.
 */
const SEARCH_DEBOUNCE_MS = 350;

// Tope de empujes propios sin reconocer que se recuerdan a la vez. Con un
// servidor lento el asesor puede disparar más de dos navegaciones antes de
// que vuelva la primera respuesta; 20 es de sobra para esa ráfaga sin dejar
// crecer la lista sin límite si algo quedara sin reconciliar nunca.
const MAX_PENDING_PUSHES = 20;

interface UrlSearchBoxProps {
  basePath: string;
  query: string;
  keep: Record<string, string>;
  placeholder: string;
  label: string;
}

export function UrlSearchBox({ basePath, query, keep, placeholder, label }: UrlSearchBoxProps) {
  const router = useRouter();
  const [draft, setDraft] = useState(query);

  // Los empujes que ESTE cuadro mandó a la URL (ya recortados, tal cual los
  // manda `router.replace`) y todavía no se reconciliaron contra un
  // re-render con esa `query`. Reporte del dueño y los asesores, 27/9/2026:
  // "el cuadro me devuelve letras que ya borré". Dos caminos pisaban el
  // borrador con una `query` que ya no representaba lo que el asesor tenía
  // escrito: (a) una navegación ATRASADA — se empujó "tubo esc", el asesor
  // siguió borrando hasta "tub", y la respuesta del servidor para "tubo
  // esc" llegaba después y resucitaba el texto ya borrado; (b)
  // `parseInventoryParams` (y el de Clientes) hacen `trim()`, así que
  // escribir "tubo " con espacio final empuja "tubo" — la URL, sin el
  // espacio, se lo comía al volver. Es una LISTA, no un solo valor: con un
  // servidor lento el asesor puede disparar dos navegaciones antes de que
  // vuelva la primera respuesta ("tubo esc" y, encima, "tub"), y las dos
  // pueden llegar después de que el asesor ya escribió otra cosa —
  // recordar solo la última dejaba viva la carrera con la anteúltima
  // (hallazgo del orquestador en la revisión de esta misma tarea). Va en
  // estado, no en una `ref`: el lint de este repo (`react-hooks/refs`)
  // prohíbe leer `ref.current` durante el render, y esta comparación tiene
  // que correr justo ahí, junto con la resincronización de abajo.
  const [pendingPushes, setPendingPushes] = useState<string[]>([]);

  // Si la URL cambia por fuera —atrás/adelante del navegador, o al tocar un
  // filtro— el cuadro tiene que reflejar lo que realmente se está buscando.
  // Se ajusta durante el render, no en un efecto: así no hay un primer
  // pintado con el valor viejo ni una cascada de renders. La `query`
  // entrante NO pisa el borrador cuando es el eco de un empuje propio
  // pendiente —tal cual (a) o porque el borrador recortado ya coincide con
  // el más reciente (b)—; solo una `query` que este cuadro nunca produjo
  // (atrás/adelante, un filtro que cambia la búsqueda, un "limpiar"
  // externo) lo reemplaza. Al reconocer un eco se descarta ese valor y
  // todos los anteriores de la lista: una respuesta más nueva ya dejó
  // atrás a cualquier empuje previo, así que no hace falta seguir
  // recordándolo. Límite aceptado: si una navegación externa cae
  // EXACTAMENTE en un valor que ya se reconoció como eco propio, no se
  // distingue de un eco — caso raro (mismo texto exacto, dos orígenes
  // distintos) frente al bug real, que era sistemático.
  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    const idx = pendingPushes.indexOf(query);
    const esEcoPropio = idx !== -1 || draft.trim() === query;
    setLastQuery(query);
    if (idx !== -1) {
      setPendingPushes(pendingPushes.slice(idx + 1));
    }
    if (!esEcoPropio) {
      setDraft(query);
    }
  }

  // `useDebouncedCallback` guarda el callback más reciente en cada render, y
  // el timer solo dispara después de que React repintó con la última tecla:
  // para cuando corre, este closure ya ve el `draft` actualizado.
  const push = useDebouncedCallback(() => {
    const params = new URLSearchParams();
    const text = draft.trim();
    setPendingPushes((prev) => [...prev, text].slice(-MAX_PENDING_PUSHES));
    if (text) params.set("q", text);
    for (const [key, value] of Object.entries(keep)) {
      if (value) params.set(key, value);
    }

    const qs = params.toString();
    router.replace(qs ? `${basePath}?${qs}` : basePath);
  }, SEARCH_DEBOUNCE_MS);

  function onChange(value: string) {
    setDraft(value);
    push();
  }

  return (
    <div className="cli-search">
      <Search size={15} aria-hidden="true" />
      <input
        type="search"
        value={draft}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
      {draft && (
        <button type="button" onClick={() => onChange("")} aria-label="Limpiar búsqueda">
          <X size={14} />
        </button>
      )}
    </div>
  );
}
