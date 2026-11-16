// ---------------------------------------------------------------------------
// De una fila de `message_readings` a la `MessageReading` de la interfaz
// (plan "Seba lee fotos y audios", 16/11/2026).
//
// Vive aparte de `data.ts` porque `crm-shell.tsx` la necesita para aplicar la
// fila cruda de un evento Realtime, y los tests de ese componente mockean
// `@/lib/data` entero: importarla de ahí obligaría a duplicarla en el mock.
// `data.ts` la reexporta, y su test (`data-messages-window.test.ts`) la prueba.
// ---------------------------------------------------------------------------

import { parseImageFields, type StoredReadingStatus } from "@/lib/media-reading-fields";
import type { Message, MessageReading } from "@/lib/types";

const ESTADOS: readonly StoredReadingStatus[] = ["pendiente", "ok", "vacio", "alucinacion", "fallo"];

/**
 * Tolerante a propósito: la fila llega embebida por PostgREST (objeto o
 * `null`, y por defensa un arreglo) o cruda de un evento Realtime. Algo que
 * no se entiende no puede tumbar la pantalla de una conversación: `null`.
 */
export function mapMessageReading(raw: unknown): MessageReading | null {
  const fila = Array.isArray(raw) ? raw[0] : raw;
  if (typeof fila !== "object" || fila === null || Array.isArray(fila)) return null;
  const r = fila as Record<string, unknown>;

  if (r.kind !== "audio" && r.kind !== "image") return null;
  const status = ESTADOS.find((estado) => estado === r.status);
  if (!status) return null;

  return {
    kind: r.kind,
    status,
    text: typeof r.text === "string" ? r.text : null,
    fields: r.kind === "image" ? parseImageFields(r.fields) : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
  };
}

const estaResuelta = (lectura: MessageReading | null | undefined): lectura is MessageReading =>
  Boolean(lectura) && lectura?.status !== "pendiente";

/**
 * Un refresco de mensajes puede pedirse ANTES de que el webhook complete una
 * lectura y responder DESPUÉS de que el evento Realtime ya la aplicó (la
 * transcripción tarda ~1 s y el refresco se pide ~0,75 s después del cambio
 * del adjunto): traería la fila todavía `pendiente` y la burbuja volvería a
 * "Leyendo…". Una lectura ya resuelta nunca retrocede a pendiente ni a vacía:
 * si el mensaje nuevo no trae una resuelta y el previo sí, se conserva la del
 * previo. No cambia el orden ni la cantidad; sin cambios devuelve los mismos
 * objetos.
 */
export function conservarLecturasResueltas(previos: readonly Message[], nuevos: Message[]): Message[] {
  const resueltas = new Map<string, MessageReading>();
  for (const previo of previos) {
    if (estaResuelta(previo.reading)) resueltas.set(previo.id, previo.reading);
  }
  if (resueltas.size === 0) return nuevos;

  return nuevos.map((nuevo) => {
    if (estaResuelta(nuevo.reading)) return nuevo;
    const previa = resueltas.get(nuevo.id);
    return previa ? { ...nuevo, reading: previa } : nuevo;
  });
}
