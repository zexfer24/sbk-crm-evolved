import type { SupabaseClient } from "@supabase/supabase-js";
import type { Product, ProductPhoto } from "@/lib/types";

/**
 * Fotos de los repuestos (30/10/2026, plan «Cada repuesto con su foto», T2).
 *
 * Los archivos viven en el bucket `product-photos`, de lectura PÚBLICA (D5):
 * la caja ve las fotos sin abrirle `/api` y Meta las descarga directo por una
 * URL que no vence. La ruta de cada objeto es `<product_id>/<uuid>.jpg`.
 */
export const PRODUCT_PHOTOS_BUCKET = "product-photos";

/**
 * URL pública de una foto. `getPublicUrl` solo arma el texto (no hace red ni
 * revisa que el objeto exista), así que se puede llamar por cada foto de cada
 * fila sin costo.
 */
export function productPhotoUrl(supabase: SupabaseClient, path: string): string {
  return supabase.storage.from(PRODUCT_PHOTOS_BUCKET).getPublicUrl(path).data.publicUrl;
}

/**
 * La foto principal: la primera de `fotos`, que ya viene ordenada por
 * `ordenarFotos`. `null` si el repuesto no tiene ninguna.
 */
export function fotoPrincipal(product: Pick<Product, "fotos">): ProductPhoto | null {
  return product.fotos[0] ?? null;
}

/**
 * Principal primero, luego por `position` ascendente; el empate se rompe por
 * `id` para que el orden sea total y estable entre refrescos (dos fotos con la
 * misma `position` no deben saltar de lugar). No muta el arreglo recibido.
 */
export function ordenarFotos(fotos: ProductPhoto[]): ProductPhoto[] {
  return [...fotos].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    if (a.position !== b.position) return a.position - b.position;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
