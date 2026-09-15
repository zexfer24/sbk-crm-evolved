// ---------------------------------------------------------------------------
// Extensión de archivo según el Content-Type que reporta Meta (Tarea 6,
// "La voz de mostrador con nombre propio", 15/9/2026).
//
// Meta manda notas de voz con `audio/ogg; codecs=opus` (parámetro incluido),
// no `audio/ogg` a secas. La tabla vivía en `route.ts` como un lookup exacto
// (`EXTENSION_BY_MIME[mimeType]`), así que ninguna nota de voz calzaba nunca
// y todas quedaban guardadas en Storage como `<conversationId>/<wamid>.bin`
// hasta este día. El `Content-Type` real del archivo (el que decide cómo se
// interpreta el contenido) nunca cambió: esto solo corrige el NOMBRE con el
// que se puede descargar el archivo desde la bandeja.
//
// Sin backfill: los archivos ya guardados como `.bin` se quedan así, el
// `Content-Type` del upload es lo que manda para reproducir/abrir el
// archivo, no la extensión del nombre.
//
// Módulo PURO a propósito, igual que `sticker-image.ts` e `identity-guard.ts`:
// sin DOM, sin `server-only`, para poder probarlo sin levantar nada.
// ---------------------------------------------------------------------------

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/amr": "amr",
  "application/pdf": "pdf",
};

/**
 * Extensión de archivo para un `Content-Type` de Meta. Corta cualquier
 * parámetro después de `;` (p. ej. `audio/ogg; codecs=opus`), normaliza
 * mayúsculas/espacios y busca en la tabla; sin match, ni MIME, devuelve
 * `"bin"` — el mismo default de siempre, ahora alcanzable de verdad para
 * el caso sin match en vez de para el caso común de las notas de voz.
 */
export function extensionForMime(mime: string | null | undefined): string {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  return EXTENSION_BY_MIME[base] ?? "bin";
}
