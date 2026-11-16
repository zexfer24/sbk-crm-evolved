"use client";

import { useEffect, useState } from "react";
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
        <p className="crm-reading-text" title={vista.texto}>
          {vista.texto}
        </p>
      </div>
    );
  }

  return (
    <div className="crm-reading" data-kind="image">
      {encabezado}
      <p className="crm-reading-text" title={vista.descripcion}>
        <span className="crm-reading-label">Lectura automática:</span> {vista.descripcion}
      </p>
      {vista.textoVisible && (
        <p className="crm-reading-text" title={vista.textoVisible}>
          Texto visible: &quot;{vista.textoVisible}&quot;
        </p>
      )}
      {vista.pastilla && <span className="crm-reading-pill">{vista.pastilla}</span>}
      {vista.detalle && <span className="crm-reading-detail">{vista.detalle}</span>}
    </div>
  );
}
