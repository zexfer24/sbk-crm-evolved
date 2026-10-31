import type { SupabaseClient } from "@supabase/supabase-js";
import { ConfigWriteDeniedError, PRODUCT_PHOTO_DENIED_MESSAGE, assertRowsAffected } from "@/lib/config-write";
import { renderProductPhotoJpeg } from "@/lib/product-photo-image";
import { PRODUCT_PHOTOS_BUCKET, productPhotoUrl } from "@/lib/product-photos";
import type { ProductPhoto } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mutaciones de las fotos de un repuesto (T3, plan «Cada repuesto con su
// foto», 30/10/2026). Viven aparte de `mutations.ts` para no engordarlo.
//
// Regla de fondo: el bucket `product-photos` NO tiene políticas de UPDATE ni
// DELETE, y los objetos no se borran nunca — un mensaje ya enviado a un
// cliente referencia la URL pública de la foto. Por eso borrar o reemplazar
// una foto solo toca la FILA de `product_photos`, y un insert fallido no
// intenta limpiar el objeto que acaba de subir (no podría): queda un archivo
// huérfano e inofensivo.
// ---------------------------------------------------------------------------

interface PhotoRow {
  id: string;
  storage_path: string;
  is_primary: boolean;
  position: number;
}

/** El bucket rechazó la subida por permisos: Storage responde 403 con "row-level security". */
function isStorageDenied(error: { message?: string; statusCode?: string | number; status?: number }): boolean {
  const status = Number(error.statusCode ?? error.status);
  return status === 403 || /row-level security|not authorized|unauthorized/i.test(error.message ?? "");
}

/**
 * Comprime `file` a JPEG y lo sube al bucket bajo `<productId>/<uuid>.jpg`.
 * Compartido por la subida y el reemplazo: mismo bucket, mismos errores.
 */
async function comprimirYSubir(
  supabase: SupabaseClient,
  productId: string,
  file: Blob,
  antesDeSubir?: () => Promise<void>
): Promise<{ path: string; blob: Blob; width: number; height: number }> {
  const compressed = await renderProductPhotoJpeg(file);
  if (!compressed) throw new Error("No se pudo reducir la foto a menos de 1 MB.");

  await antesDeSubir?.();
  const path = `${productId}/${crypto.randomUUID()}.jpg`;

  const { error: uploadError } = await supabase.storage
    .from(PRODUCT_PHOTOS_BUCKET)
    .upload(path, compressed.blob, { contentType: "image/jpeg", upsert: false });
  if (uploadError) {
    if (isStorageDenied(uploadError)) throw new ConfigWriteDeniedError(PRODUCT_PHOTO_DENIED_MESSAGE);
    throw new Error(`No se pudo subir la foto: ${uploadError.message}`);
  }
  return { path, ...compressed };
}

/**
 * Sube una foto nueva al final de las del repuesto (`position` = cuántas tenía
 * antes). Si era la primera, el trigger la hace principal.
 */
export async function uploadProductPhoto(supabase: SupabaseClient, productId: string, file: Blob): Promise<ProductPhoto> {
  let position = 0;
  const subida = await comprimirYSubir(supabase, productId, file, async () => {
    const { count, error } = await supabase
      .from("product_photos")
      .select("id", { count: "exact", head: true })
      .eq("product_id", productId);
    if (error) throw error;
    position = count ?? 0;
  });

  const { data, error } = await supabase
    .from("product_photos")
    .insert({
      product_id: productId,
      storage_path: subida.path,
      width: subida.width,
      height: subida.height,
      bytes: subida.blob.size,
      position,
    })
    .select("id, storage_path, is_primary, position")
    .single();
  if (error) {
    if (error.code === "42501") throw new ConfigWriteDeniedError(PRODUCT_PHOTO_DENIED_MESSAGE);
    // El trigger del tope dice «Este repuesto ya tiene 6 fotos.»: ya está en español y listo para el toast.
    if (error.message?.includes("6 fotos")) throw new Error(error.message);
    throw error;
  }

  const row = data as PhotoRow;
  return {
    id: row.id,
    storagePath: row.storage_path,
    url: productPhotoUrl(supabase, row.storage_path),
    isPrimary: row.is_primary,
    position: row.position,
  };
}

/**
 * Borra la FILA de la foto. El objeto del bucket se queda: los mensajes ya
 * enviados lo referencian. Si era la principal, el trigger promueve la
 * siguiente. Bajo RLS, un rol sin permiso afecta 0 filas sin error:
 * `assertRowsAffected` lo vuelve visible.
 */
export async function deleteProductPhoto(supabase: SupabaseClient, photoId: string): Promise<void> {
  const { data, error } = await supabase.from("product_photos").delete().eq("id", photoId).select("id");
  if (error) throw error;
  assertRowsAffected(data, PRODUCT_PHOTO_DENIED_MESSAGE);
}

/** Marca la foto como principal; el trigger desmarca a las demás del repuesto. */
export async function setPrimaryProductPhoto(supabase: SupabaseClient, photoId: string): Promise<void> {
  const { data, error } = await supabase
    .from("product_photos")
    .update({ is_primary: true })
    .eq("id", photoId)
    .select("id");
  if (error) throw error;
  assertRowsAffected(data, PRODUCT_PHOTO_DENIED_MESSAGE);
}

/**
 * Reemplaza la imagen de `photo` ACTUALIZANDO su misma fila: sube el JPEG nuevo
 * y apunta `storage_path`/medidas/peso a él. `id`, `position` e `is_primary`
 * no se tocan, así que el tope de 6 fotos (que cuenta al INSERTAR) no estorba
 * y no hay un momento en que el repuesto se quede sin su principal ni con dos.
 * (Primera versión, 30/10/2026: insertaba la nueva y borraba la vieja; con 6
 * fotos el trigger del tope rechazaba el insert. El orquestador cambió a UPDATE.)
 *
 * Si el UPDATE falla, el objeto recién subido queda huérfano en el bucket (no
 * hay política de borrado): es aceptable e inofensivo, y la foto vieja sigue
 * intacta. El objeto ANTERIOR tampoco se borra: los mensajes ya enviados lo
 * referencian.
 */
export async function replaceProductPhoto(
  supabase: SupabaseClient,
  photo: ProductPhoto,
  productId: string,
  file: Blob
): Promise<ProductPhoto> {
  const subida = await comprimirYSubir(supabase, productId, file);

  const { data, error } = await supabase
    .from("product_photos")
    .update({
      storage_path: subida.path,
      width: subida.width,
      height: subida.height,
      bytes: subida.blob.size,
    })
    .eq("id", photo.id)
    .select("id, storage_path, is_primary, position");
  if (error) throw error;
  assertRowsAffected(data, PRODUCT_PHOTO_DENIED_MESSAGE);

  return {
    id: photo.id,
    storagePath: subida.path,
    url: productPhotoUrl(supabase, subida.path),
    isPrimary: photo.isPrimary,
    position: photo.position,
  };
}
