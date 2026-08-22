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

  // Si la URL cambia por fuera —atrás/adelante del navegador, o al tocar un
  // filtro— el cuadro tiene que reflejar lo que realmente se está buscando.
  // Se ajusta durante el render, no en un efecto: así no hay un primer
  // pintado con el valor viejo ni una cascada de renders.
  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setDraft(query);
  }

  // `useDebouncedCallback` guarda el callback más reciente en cada render, y
  // el timer solo dispara después de que React repintó con la última tecla:
  // para cuando corre, este closure ya ve el `draft` actualizado.
  const push = useDebouncedCallback(() => {
    const params = new URLSearchParams();
    const text = draft.trim();
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
