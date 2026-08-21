"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ImageOff, RefreshCw, X } from "lucide-react";
import { FormattedText } from "@/components/chat/formatted-text";

export interface MediaItem {
  url: string;
  type: "image" | "video";
  caption?: string | null;
}

/**
 * Miniatura con caída controlada: si la URL nunca cargó (expiró, se borró,
 * red caída) muestra un placeholder con botón de reintento en vez del ícono
 * roto nativo del navegador o un hueco vacío.
 */
function ThumbMedia({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  if (failed) {
    return (
      <div className="crm-thumb-error" role="img" aria-label="No se pudo cargar el archivo">
        <ImageOff size={18} />
        <button
          type="button"
          className="crm-thumb-retry"
          onClick={(e) => {
            e.stopPropagation();
            setFailed(false);
            setAttempt((a) => a + 1);
          }}
          aria-label="Reintentar carga"
        >
          <RefreshCw size={12} />
          Reintentar
        </button>
      </div>
    );
  }

  return item.type === "video" ? (
    <video key={attempt} src={item.url} preload="metadata" muted playsInline onError={() => setFailed(true)} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={attempt}
      src={item.url}
      alt={item.caption ?? "Foto del cliente"}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Miniatura que abre el archivo a tamaño completo. Recibe la lista entera del
 * mensaje —no solo su propio archivo— para poder pasar de una foto a otra sin
 * cerrar el visor.
 */
export function MediaThumb({
  items,
  index,
  className,
}: {
  items: MediaItem[];
  index: number;
  className?: string;
}) {
  const [openAt, setOpenAt] = useState<number | null>(null);
  const item = items[index];

  return (
    <>
      {/* div en vez de button: adentro va otro button (reintentar) cuando falla la
          carga, y HTML no permite anidar <button>. role="button" mantiene la semántica. */}
      <div
        className={`crm-thumb ${className ?? ""}`}
        role="button"
        tabIndex={0}
        onClick={() => setOpenAt(index)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpenAt(index);
          }
        }}
        aria-label={item.type === "video" ? "Ver el video" : "Ver la foto"}
      >
        <ThumbMedia item={item} />
      </div>

      {openAt !== null && (
        <MediaViewer items={items} startIndex={openAt} onClose={() => setOpenAt(null)} />
      )}
    </>
  );
}

function ViewerMedia({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="crm-viewer-error" role="img" aria-label="No se pudo cargar el archivo">
        <ImageOff size={32} />
        <p>No se pudo cargar este archivo.</p>
        <button type="button" className="crm-viewer-btn" onClick={() => setFailed(false)}>
          <RefreshCw size={14} />
          Reintentar
        </button>
      </div>
    );
  }

  return item.type === "video" ? (
    <video src={item.url} controls autoPlay onError={() => setFailed(true)} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={item.url} alt={item.caption ?? "Foto del cliente"} onError={() => setFailed(true)} />
  );
}

function MediaViewer({
  items,
  startIndex,
  onClose,
}: {
  items: MediaItem[];
  startIndex: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const current = items[index];
  const many = items.length > 1;

  const go = useCallback(
    (step: number) => setIndex((i) => (i + step + items.length) % items.length),
    [items.length]
  );

  // Escape cierra y las flechas navegan: con el visor abierto el teclado
  // manda sobre la conversación de detrás.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (many && event.key === "ArrowRight") go(1);
      if (many && event.key === "ArrowLeft") go(-1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, many, onClose]);

  // Mientras el visor está abierto, el fondo no se desplaza.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      className="crm-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Ver archivo a tamaño completo"
      onClick={onClose}
    >
      <div className="crm-viewer-bar" onClick={(e) => e.stopPropagation()}>
        {many && (
          <span className="crm-viewer-count lm-num">
            {index + 1} / {items.length}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <a
          className="crm-viewer-btn"
          href={current.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Abrir el archivo original"
        >
          <Download size={18} />
        </a>
        <button className="crm-viewer-btn" type="button" onClick={onClose} aria-label="Cerrar">
          <X size={18} />
        </button>
      </div>

      {many && (
        <button
          className="crm-viewer-nav"
          data-side="left"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            go(-1);
          }}
          aria-label="Anterior"
        >
          <ChevronLeft size={22} />
        </button>
      )}

      <div className="crm-viewer-stage" onClick={(e) => e.stopPropagation()}>
        <ViewerMedia key={current.url} item={current} />
        {current.caption && (
          <p className="crm-viewer-caption">
            <FormattedText text={current.caption} />
          </p>
        )}
      </div>

      {many && (
        <button
          className="crm-viewer-nav"
          data-side="right"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            go(1);
          }}
          aria-label="Siguiente"
        >
          <ChevronRight size={22} />
        </button>
      )}
    </div>
  );
}
