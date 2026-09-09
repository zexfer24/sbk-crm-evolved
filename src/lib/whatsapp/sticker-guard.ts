import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { MEDIA_BUCKET, storagePathFromUrl } from "@/lib/storage";
import { isAnimatedWebp, isWithinStickerLimit, stickerRejectionMessage } from "@/lib/sticker-image";
import { log, errorText } from "@/lib/log";

// ---------------------------------------------------------------------------
// Guarda de servidor sobre un sticker saliente (T3, 8/9/2026).
//
// El camino de envío de `route.ts` guarda la fila en `messages`, responde
// 200 al asesor y recién en `after()` habla con Meta: si el sticker no entra
// en el límite de peso, Meta lo acepta igual con un 200 y wamid — el rechazo
// (131053, "Sticker file has size ... but must be atmost ...") llega 3 s
// después por el webhook de status, y la fila queda en `failed` en silencio.
//
// Caso real de producción: un sticker animado de 973.668 bytes guardado en
// la biblioteca CON `animated = false` (mal marcado). Por eso esta guarda
// NO confía en la columna `animated` de `stickers` — mide los bytes de
// verdad del archivo en el bucket antes de dejar pasar el envío.
// ---------------------------------------------------------------------------

export interface StickerGuardResult {
  ok: boolean;
  /** Motivo para el 422 cuando `ok` es `false`; ausente cuando `ok` es `true`. */
  reason?: string;
}

/**
 * Descarga el sticker del bucket privado y lo mide (peso + animación real,
 * leyendo bytes) contra el límite de Meta. Se usa ANTES de insertar la fila
 * en `messages`, igual que `isDeliverablePhoneNumber` en `route.ts`.
 *
 * Dos decisiones de diseño:
 *
 * 1. Se descarga el archivo completo con el cliente admin de Storage en vez
 *    de pedir un enlace firmado y hacer un `fetch`: son los mismos ~1 MB
 *    como mucho, un viaje de red menos, y no depende de que el enlace
 *    firmado ya exista (`signedUrlForSending` se llama recién en `after()`,
 *    más adelante en el camino de envío real).
 * 2. Si el archivo no se puede leer (storage caído, la fila apunta a un
 *    archivo que ya no está), la guarda DEJA PASAR el envío y solo registra
 *    un aviso. No convertir una falla de lectura en un bloqueo total: un
 *    problema de disponibilidad de Storage no es evidencia de que el
 *    sticker esté roto, y `signedUrlForSending` ya es la red de seguridad
 *    real más adelante en el camino de envío si el archivo de verdad no
 *    está disponible (ahí si falla, corta con un error claro en el estado
 *    de la fila). Bloquear acá todos los envíos de sticker por un hipo de
 *    lectura sería peor que el problema que esta guarda vino a resolver.
 */
export async function checkStickerBeforeSend(mediaUrl: string): Promise<StickerGuardResult> {
  const path = storagePathFromUrl(mediaUrl);
  if (!path) {
    // Un sticker de la biblioteca siempre viaja con la ruta propia del CRM
    // (`mediaUrlFor`, `storage.ts`). Si no se pudo resolver un path dentro
    // del bucket no hay bytes que medir acá: se deja pasar y que el resto
    // del camino de envío decida (Meta rechaza una URL de verdad inválida
    // igual, solo que más tarde).
    return { ok: true };
  }

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from(MEDIA_BUCKET).download(path);
    if (error || !data) {
      log.warn("send.sticker_no_se_pudo_leer", {
        path,
        detail: error ? errorText(error) : "descarga sin datos",
      });
      return { ok: true };
    }

    const bytes = new Uint8Array(await data.arrayBuffer());
    const animated = isAnimatedWebp(bytes);
    if (isWithinStickerLimit(bytes.length, animated)) return { ok: true };

    return { ok: false, reason: stickerRejectionMessage(bytes.length, animated) };
  } catch (err) {
    log.warn("send.sticker_no_se_pudo_leer", { path, detail: errorText(err) });
    return { ok: true };
  }
}
