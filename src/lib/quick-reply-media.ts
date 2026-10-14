// Fotos de las respuestas rápidas (14/10/2026, rama "Respuestas rápidas con
// fotos"). Módulo puro: los topes y las rutas viven acá para que el modal, la
// mutación y los tests hablen de lo mismo.
//
// Los topes no son capricho: las fotos salen como mensajes `image` por la
// Cloud API, y Meta acepta para `image` solo JPEG/PNG de hasta 5 MB. Rechazar
// en el cliente evita descubrirlo recién cuando un cliente real no recibe la
// foto (un `failed` silencioso que llega por el webhook de estados).
//
// Decisión: las fotos NUNCA se borran del bucket. Ni al quitarlas de la
// respuesta ni al borrar la respuesta: un mensaje ya enviado a un cliente
// guarda `media_url` apuntando a esa misma ruta, y borrar el objeto dejaría la
// burbuja con una imagen rota para siempre. Es un costo de almacenamiento
// aceptado (≤ 5 MB por foto) a cambio de no romper el historial.

export const QUICK_REPLY_MAX_PHOTOS = 10;
export const QUICK_REPLY_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const QUICK_REPLY_PHOTO_TYPES = ["image/jpeg", "image/png"] as const;

/** Prefijo bajo el que viven en el bucket `whatsapp-media` (el CHECK de la base lo exige igual). */
const QUICK_REPLY_PREFIX = "quick-replies/";

const MSG_TYPE = "Solo fotos JPG o PNG.";
const MSG_MAX = `Máximo ${QUICK_REPLY_MAX_PHOTOS} fotos por respuesta rápida.`;

interface PhotoLike {
  name: string;
  type: string;
  size: number;
}

/**
 * Primer error que impide sumar `files` a una respuesta que ya lleva
 * `existingCount` fotos, o `null` si entran todas. Todo el lote se acepta o
 * se rechaza junto: subir la mitad de lo que el asesor eligió sería confuso.
 */
export function validateQuickReplyPhotos(existingCount: number, files: PhotoLike[]): string | null {
  if (existingCount + files.length > QUICK_REPLY_MAX_PHOTOS) return MSG_MAX;
  for (const file of files) {
    if (!(QUICK_REPLY_PHOTO_TYPES as readonly string[]).includes(file.type)) return MSG_TYPE;
    if (file.size > QUICK_REPLY_MAX_PHOTO_BYTES) {
      return `La foto «${file.name}» pesa más de ${QUICK_REPLY_MAX_PHOTO_BYTES / (1024 * 1024)} MB.`;
    }
  }
  return null;
}

/**
 * Ruta nueva dentro del bucket. Id aleatorio y no el nombre del archivo: el
 * bucket es privado, pero una ruta adivinable seguiría siendo una pista de más.
 */
export function quickReplyPhotoPath(type: string): string {
  const extension = type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : null;
  if (!extension) throw new Error(MSG_TYPE);
  return `${QUICK_REPLY_PREFIX}${crypto.randomUUID()}.${extension}`;
}

/** Espeja el CHECK de la base: prefijo propio, algo detrás de él y ningún `..`. */
export function isQuickReplyPath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.startsWith(QUICK_REPLY_PREFIX) &&
    path.length > QUICK_REPLY_PREFIX.length &&
    !path.includes("..")
  );
}
