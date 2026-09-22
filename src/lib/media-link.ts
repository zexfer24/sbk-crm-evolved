import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { MEDIA_BUCKET, storagePathFromUrl } from "@/lib/storage";
import { errorText, log } from "@/lib/log";

/**
 * Meta descarga el archivo por su cuenta cuando le pasamos un `link`, así que
 * necesita una URL que abra sin la sesión del CRM. La ruta /api/media no le
 * sirve: exige cookie de agente.
 *
 * Se firma en el momento del envío y vence en diez minutos — suficiente para
 * que Meta lo baje, corto para que el enlace no quede circulando.
 */
const SEND_TTL_SECONDS = 600;

export async function signedUrlForSending(
  mediaUrl: string,
  contexto?: { messageId?: string; conversationId?: string }
): Promise<string | null> {
  // Una URL que no apunte a nuestro bucket no se firma: si viene de otro
  // lado, se manda tal cual y que Meta decida.
  const path = storagePathFromUrl(mediaUrl);
  if (!path) return mediaUrl.startsWith("http") ? mediaUrl : null;

  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(MEDIA_BUCKET).createSignedUrl(path, SEND_TTL_SECONDS);

  if (error || !data) {
    // T7, plan "Nada se pierde en un corte ni en un deploy" (22/9/2026): un
    // `console.error` no se puede filtrar por conversación ni contar como
    // evento — pasa a `lib/log.ts` con los ids que traiga el llamador, para
    // poder correlacionar un envío fallido con la conversación real.
    log.error("send.enlace_no_firmado", {
      detail: errorText(error),
      messageId: contexto?.messageId,
      conversationId: contexto?.conversationId,
    });
    return null;
  }
  return data.signedUrl;
}
