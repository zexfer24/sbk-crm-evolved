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

import { esComprobante, esOrdenCashea, type ImageFields } from "@/lib/media-reading-fields";
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

/** 1234.5 → "1.234,50". A mano: el agrupado de `Intl` en español varía según el ICU. */
function formatoEsVE(valor: number): string {
  const [entera, decimales] = Math.abs(valor).toFixed(2).split(".");
  const conMiles = entera.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${valor < 0 ? "-" : ""}${conMiles},${decimales}`;
}

function detalleDeComprobante(fields: ImageFields): string | null {
  const c = fields.comprobante;
  if (!c) return null;
  const partes: string[] = [];
  if (c.monto !== null) {
    const simbolo = c.moneda === "VES" ? "Bs " : c.moneda === "USD" ? "$ " : "";
    partes.push(`${simbolo}${formatoEsVE(c.monto)}`);
  }
  if (c.referencia) partes.push(`ref. …${c.referencia}`);
  if (c.banco) partes.push(c.banco);
  if (c.fecha) partes.push(c.fecha);
  return partes.length > 0 ? partes.join(" · ") : null;
}

function detalleDeOrdenCashea(fields: ImageFields): string | null {
  const o = fields.orden_cashea;
  if (!o) return null;
  const partes: string[] = [];
  if (o.modalidad === "envio") partes.push("Envío");
  if (o.modalidad === "retiro") partes.push("Retiro en tienda");
  if (o.total_usd !== null) partes.push(`total $${formatoEsVE(o.total_usd)}`);
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
  if (texto === "") return { tipo: "nada" };

  if (reading.kind === "audio") return { tipo: "audio", texto };

  const fields = reading.fields;
  const textoVisible = fields?.texto_visible.trim() ? fields.texto_visible.trim() : null;
  const comprobante = esComprobante(fields);
  const orden = !comprobante && esOrdenCashea(fields);

  return {
    tipo: "imagen",
    descripcion: texto,
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
