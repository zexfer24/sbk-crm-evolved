import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { MEDIA_BUCKET, storagePathFromUrl } from "@/lib/storage";

/**
 * Meta descarga el archivo por su cuenta cuando le pasamos un `link`, así que
 * necesita una URL que abra sin la sesión del CRM. La ruta /api/media no le
 * sirve: exige cookie de agente.
 *
 * Se firma en el momento del envío y vence en diez minutos — suficiente para
 * que Meta lo baje, corto para que el enlace no quede circulando.
 */
const SEND_TTL_SECONDS = 600;

export async function signedUrlForSending(mediaUrl: string): Promise<string | null> {
  // Una URL que no apunte a nuestro bucket no se firma: si viene de otro
  // lado, se manda tal cual y que Meta decida.
  const path = storagePathFromUrl(mediaUrl);
  if (!path) return mediaUrl.startsWith("http") ? mediaUrl : null;

  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(MEDIA_BUCKET).createSignedUrl(path, SEND_TTL_SECONDS);

  if (error || !data) {
    console.error("No se pudo firmar el archivo para enviarlo por WhatsApp:", error);
    return null;
  }
  return data.signedUrl;
}
