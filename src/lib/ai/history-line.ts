// ---------------------------------------------------------------------------
// Qué línea de historial arma el CRM para el modelo a partir de una fila de
// `messages` (7/9/2026, medido en producción): `loadHistory` (agent.ts)
// descartaba toda fila con `content` vacío, y el webhook guarda imagen,
// audio, video, documento y sticker con `content = caption ?? null`. Sin pie,
// esas filas eran invisibles para el modelo. Dos casos reales:
//
//   - `cea69118-5d17-4f08-84c6-925755672b87`: un cliente arrancó el chat con
//     un audio y nada más. Sin texto que leer, `loadHistory` devolvía un
//     historial vacío y el turno salía sin rastro (T4 cierra ese hueco por
//     separado).
//   - `7631718e-52bc-4448-99f2-586789c073ff`: el cliente mandó dos fotos y
//     después "Cualquiera de estos en talla L". El "estos" señalaba las
//     fotos, que el modelo nunca vio: las dos filas de foto se descartaban
//     antes de llegar al contexto.
//
// Restricción de diseño (declarada en el brief): `messages.content` NO se
// toca. Es la burbuja del chat (`media-group.tsx`, `quoted-content.tsx`,
// `close-sale-modal.tsx` dependen de que sea SOLO lo que el cliente escribió
// o el pie que mandó). El texto que necesita el modelo para "ver" que algo
// llegó se arma acá, en memoria, como una línea entre corchetes que el
// prompt (sección 7, `MEDIA_RULES` en prompt.ts) le explica al modelo cómo
// leer: nunca la cite, nunca la trate como algo que el cliente escribió. Los
// textos de este archivo tienen que coincidir EXACTAMENTE con lo que
// `MEDIA_RULES` describe.
//
// Módulo PURO a propósito, igual que identity-guard.ts: sin `server-only` y
// sin más import que tipos, para que lo puedan usar tanto agent.ts (servidor)
// como cualquier test sin arrastrar el mundo del SDK de IA.
// ---------------------------------------------------------------------------

/** Las columnas de `messages` que hacen falta para decidir la línea de historial. */
export interface HistoryRow {
  sender_type: string;
  content: string | null;
  is_internal_note: boolean | null;
  message_type: string | null;
}

export interface HistoryLine {
  role: "user" | "assistant";
  content: string;
  /** true solo en las líneas entre corchetes que arma este archivo. */
  marcador: boolean;
}

/** Tipos de multimedia que hoy llegan sin `content` cuando no traen pie. */
type MediaType = "image" | "video" | "audio" | "document" | "sticker";

const MEDIA_TYPES = new Set<string>(["image", "video", "audio", "document", "sticker"]);

/** `content` recortado, o null si queda vacío tras el recorte (equivale a "sin pie"). */
function pie(content: string | null): string | null {
  const recortado = content?.trim();
  return recortado ? recortado : null;
}

function clienteMarker(messageType: MediaType, caption: string | null): string {
  switch (messageType) {
    case "image":
      return caption ? `[El cliente envió una foto. Pie: ${caption}]` : "[El cliente envió una foto sin texto; no puedes verla]";
    case "video":
      return caption ? `[El cliente envió un video. Pie: ${caption}]` : "[El cliente envió un video sin texto; no puedes verlo]";
    case "audio":
      return caption ? `[El cliente envió una nota de voz. Pie: ${caption}]` : "[El cliente envió una nota de voz; no puedes escucharla]";
    case "document":
      // El webhook NO guarda el nombre del archivo (`payload` llega vacío
      // para 'document' en producción, medido 7/9/2026) — el marcador sale
      // sin nombre. Guardar `filename` en `payload` queda fuera de alcance.
      return caption ? `[El cliente envió un documento. Pie: ${caption}]` : "[El cliente envió un documento; no puedes abrirlo]";
    case "sticker":
      return "[El cliente envió un sticker]";
  }
}

const ASESOR_LABEL: Record<MediaType, string> = {
  image: "una foto",
  video: "un video",
  audio: "una nota de voz",
  document: "un documento",
  sticker: "un sticker",
};

function asesorMarker(messageType: MediaType, caption: string | null): string {
  const base = `[El asesor envió ${ASESOR_LABEL[messageType]}`;
  return caption ? `${base}. Pie: ${caption}]` : `${base}]`;
}

/**
 * Convierte una fila de `messages` en la línea que ve el modelo, o `null` si
 * la fila se salta (comportamiento igual al `loadHistory` de antes para las
 * filas que ya se saltaban).
 */
export function historyLine(row: HistoryRow): HistoryLine | null {
  // Reglas ya vigentes antes de este archivo (ver el comentario de
  // loadHistory en agent.ts): notas internas, eventos de sistema y
  // 'unsupported' nunca entran al contexto del modelo.
  if (row.is_internal_note || row.sender_type === "system" || row.message_type === "unsupported") return null;

  const role: HistoryLine["role"] = row.sender_type === "customer" ? "user" : "assistant";
  const messageType = row.message_type;

  if (messageType && MEDIA_TYPES.has(messageType)) {
    const caption = pie(row.content);
    const content = role === "user" ? clienteMarker(messageType as MediaType, caption) : asesorMarker(messageType as MediaType, caption);
    return { role, content, marcador: true };
  }

  // text, location, contacts, interactive, order, template, system_event,
  // null o cualquier tipo desconocido: `content` tal cual, como siempre.
  return row.content && row.content.trim() ? { role, content: row.content, marcador: false } : null;
}

/** true si `text` es uno de los marcadores que arma `historyLine`, no algo que el cliente o el asesor escribieron. */
export function isHistoryMarker(text: string): boolean {
  return /^\[(El cliente|El asesor) envió /.test(text);
}
