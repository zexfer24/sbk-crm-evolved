export const MEDIA_BUCKET = "whatsapp-media";

/** Prefijo de la ruta propia que sirve los archivos con sesión validada. */
const MEDIA_ROUTE = "/api/media/";

/**
 * URL que se guarda en `messages.media_url`.
 *
 * Apunta a una ruta del propio CRM, no al bucket: el archivo solo sale si
 * quien lo pide tiene sesión. Es relativa y estable, así que no vence como
 * vencería una URL firmada guardada en la base.
 */
export function mediaUrlFor(path: string): string {
  return `${MEDIA_ROUTE}${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Camino inverso: saca el path dentro del bucket de una URL guardada.
 *
 * Acepta las dos formas que existen en la base: la ruta propia y las URLs
 * públicas que se guardaron mientras el bucket lo era. Devuelve null si la
 * URL apunta a cualquier otro lado — un archivo ajeno no se firma.
 */
export function storagePathFromUrl(url: string): string | null {
  const decode = (raw: string) => raw.split("/").map(decodeURIComponent).join("/");

  const routeIndex = url.indexOf(MEDIA_ROUTE);
  if (routeIndex !== -1) return decode(url.slice(routeIndex + MEDIA_ROUTE.length));

  const publicMarker = `/storage/v1/object/public/${MEDIA_BUCKET}/`;
  const publicIndex = url.indexOf(publicMarker);
  if (publicIndex !== -1) return decode(url.slice(publicIndex + publicMarker.length));

  return null;
}
