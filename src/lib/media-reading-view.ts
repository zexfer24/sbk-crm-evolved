// ---------------------------------------------------------------------------
// Qué se pinta de la lectura automática de un adjunto del cliente (plan
// "Seba lee fotos y audios", 16/11/2026).
//
// Módulo PURO: decide la vista a partir de la lectura guardada y de la hora
// actual (que entra como parámetro para poder probarlo). El componente
// (`chat/media-reading.tsx`) solo la dibuja.
//
// La regla de fondo: una lectura que no aporta nada al asesor (vacía, que el
// filtro marcó como alucinación o que falló) no se pinta. Mostrar "no se pudo
// leer" en cada audio ruidoso sería ruido, no información.
// ---------------------------------------------------------------------------

import {
  esComprobante,
  esOrdenCashea,
  partesDeComprobante,
  partesDeOrdenCashea,
  type ImageFields,
} from "@/lib/media-reading-fields";
import type { MessageReading } from "@/lib/types";

/**
 * Cuánto tiempo una lectura `pendiente` se sigue mostrando como "Leyendo…".
 * El webhook la completa en 1-4 s; si pasaron dos minutos, un deploy cortó la
 * lectura y la fila se quedó `pendiente` para siempre: un "Leyendo…" eterno
 * en la burbuja le mentiría al asesor.
 */
export const LECTURA_PENDIENTE_VIGENTE_MS = 120_000;

export type VistaDeLectura =
  | { tipo: "nada" }
  | { tipo: "leyendo" }
  | { tipo: "audio"; texto: string }
  | {
      tipo: "imagen";
      descripcion: string;
      textoVisible: string | null;
      pastilla: string | null;
      detalle: string | null;
    };

// El formato de lo leído vive en `media-reading-fields.ts` (C5, revisión de
// código del 16/11/2026): la misma lista de partes que usa la nota al asesor.
function detalleDeComprobante(fields: ImageFields): string | null {
  const partes = fields.comprobante ? partesDeComprobante(fields.comprobante) : [];
  return partes.length > 0 ? partes.join(" · ") : null;
}

function detalleDeOrdenCashea(fields: ImageFields): string | null {
  const partes = fields.orden_cashea ? partesDeOrdenCashea(fields.orden_cashea) : [];
  return partes.length > 0 ? partes.join(" · ") : null;
}

export function vistaDeLectura(
  reading: MessageReading | null | undefined,
  ahoraMs: number
): VistaDeLectura {
  if (!reading) return { tipo: "nada" };

  if (reading.status === "pendiente") {
    const desde = Date.parse(reading.createdAt);
    if (Number.isNaN(desde)) return { tipo: "nada" };
    return ahoraMs - desde < LECTURA_PENDIENTE_VIGENTE_MS ? { tipo: "leyendo" } : { tipo: "nada" };
  }

  if (reading.status !== "ok") return { tipo: "nada" };

  const texto = reading.text?.trim() ?? "";
  const fields = reading.fields;
  const comprobante = esComprobante(fields);
  const orden = !comprobante && esOrdenCashea(fields);

  // Una descripción vacía solo tapa la burbuja si la imagen no es nada que el
  // asesor deba ver. Revisión de código del 16/11/2026 (C4): antes esto
  // devolvía `nada` ANTES de mirar los campos, pero el turno sí trata esa
  // imagen como comprobante (u orden de Cashea) y escala — el asesor recibía el
  // traspaso y en la burbuja no veía ni la pastilla ni lo leído. Un audio sin
  // texto sigue sin mostrar nada.
  if (texto === "" && (reading.kind === "audio" || (!comprobante && !orden))) return { tipo: "nada" };

  if (reading.kind === "audio") return { tipo: "audio", texto };

  const textoVisible = fields?.texto_visible.trim() ? fields.texto_visible.trim() : null;

  return {
    tipo: "imagen",
    descripcion: texto !== "" ? texto : comprobante ? "Comprobante de pago" : "Orden de Cashea",
    textoVisible,
    pastilla: comprobante ? "Posible comprobante" : orden ? "Posible orden de Cashea" : null,
    detalle: !fields
      ? null
      : comprobante
        ? detalleDeComprobante(fields)
        : orden
          ? detalleDeOrdenCashea(fields)
          : null,
  };
}
