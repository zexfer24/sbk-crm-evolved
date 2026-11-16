"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MessageReading } from "@/lib/types";
import { LECTURA_PENDIENTE_VIGENTE_MS, vistaDeLectura } from "@/lib/media-reading-view";

interface MediaReadingProps {
  reading: MessageReading | null | undefined;
  /** La hora contra la que se juzga si una lectura pendiente sigue vigente. Por defecto, la de montaje. */
  ahoraMs?: number;
  /** "Foto 2": en la galería, qué foto es la que se lee. */
  prefijo?: string;
}

/**
 * Un párrafo de lectura recortado a 6 líneas por CSS. Si el texto no cabe, un
 * botón "Ver más" lo abre completo (antes solo se veía en el `title`, un
 * tooltip: una transcripción larga de una nota de voz no se podía leer).
 * Se mide después de pintar (jsdom no calcula layout: los tests definen las
 * medidas a mano) y se vuelve a medir si cambia el texto.
 */
function TextoRecortable({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [recortado, setRecortado] = useState(false);
  const [abierto, setAbierto] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || abierto) return;
    setRecortado(el.scrollHeight > el.clientHeight + 1);
  }, [title, abierto]);

  return (
    <>
      <p
        ref={ref}
        className="crm-reading-text"
        title={title}
        data-abierto={abierto ? "true" : undefined}
      >
        {children}
      </p>
      {(recortado || abierto) && (
        <button
          type="button"
          className="crm-reading-more"
          aria-expanded={abierto}
          onClick={(event) => {
            // Un clic aquí no debe llegar a la burbuja (menú, selección, etc.).
            event.stopPropagation();
            setAbierto((valor) => !valor);
          }}
          onContextMenu={(event) => event.stopPropagation()}
        >
          {abierto ? "Ver menos" : "Ver más"}
        </button>
      )}
    </>
  );
}

/**
 * La lectura automática que va debajo de un audio o una imagen del cliente
 * (plan "Seba lee fotos y audios", 16/11/2026): la transcripción o la
 * descripción que Seba también tiene delante, para que el asesor sepa lo que
 * Seba entendió sin tener que oír ni abrir cada adjunto.
 *
 * Devuelve `null` cuando no hay nada útil que decir (lectura vacía, descartada
 * por el filtro de alucinaciones, fallida, o pendiente desde hace demasiado):
 * la regla vive en `vistaDeLectura`, esto solo la dibuja.
 */
export function MediaReading({ reading, ahoraMs, prefijo }: MediaReadingProps) {
  // `Date.now()` en el cuerpo del render no es puro: se toma al montar y se renueva al vencer.
  const [ahoraEstado, setAhoraEstado] = useState(() => Date.now());
  const ahora = ahoraMs ?? ahoraEstado;
  const vista = vistaDeLectura(reading, ahora);

  // Un "Leyendo…" que nadie completa (un deploy cortó la lectura) tiene que
  // apagarse solo al vencer su vigencia, sin esperar a otro render.
  const leyendo = vista.tipo === "leyendo";
  const creada = reading?.createdAt;
  useEffect(() => {
    if (ahoraMs !== undefined || !leyendo || !creada) return;
    const falta = Math.max(0, Date.parse(creada) + LECTURA_PENDIENTE_VIGENTE_MS - Date.now());
    const timer = setTimeout(() => setAhoraEstado(Date.now()), falta);
    return () => clearTimeout(timer);
  }, [ahoraMs, leyendo, creada]);

  if (vista.tipo === "nada") return null;

  const encabezado = prefijo ? <span className="crm-reading-prefix">{prefijo}</span> : null;

  if (vista.tipo === "leyendo") {
    return (
      <div className="crm-reading" data-estado="leyendo">
        {encabezado}
        <span className="crm-reading-label">Leyendo…</span>
      </div>
    );
  }

  if (vista.tipo === "audio") {
    return (
      <div className="crm-reading" data-kind="audio">
        {encabezado}
        <span className="crm-reading-label">Transcripción automática</span>
        <TextoRecortable title={vista.texto}>{vista.texto}</TextoRecortable>
      </div>
    );
  }

  return (
    <div className="crm-reading" data-kind="image">
      {encabezado}
      <TextoRecortable title={vista.descripcion}>
        <span className="crm-reading-label">Lectura automática:</span> {vista.descripcion}
      </TextoRecortable>
      {vista.textoVisible && (
        <TextoRecortable title={vista.textoVisible}>
          Texto visible: &quot;{vista.textoVisible}&quot;
        </TextoRecortable>
      )}
      {vista.pastilla && <span className="crm-reading-pill">{vista.pastilla}</span>}
      {vista.detalle && <span className="crm-reading-detail">{vista.detalle}</span>}
    </div>
  );
}
