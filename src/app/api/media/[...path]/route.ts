import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MEDIA_BUCKET } from "@/lib/storage";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Sirve el multimedia de WhatsApp con la sesión del CRM por delante.
//
// El bucket es privado: sin esta ruta no hay forma de ver una foto o un
// comprobante desde el navegador. Antes el bucket era público y cualquiera
// con la URL —o con la paciencia de probar rutas— llegaba al archivo sin
// tener cuenta.
//
// Se responde con una redirección a una URL firmada de vida corta en vez de
// hacer streaming: el archivo lo entrega Supabase, no este proceso, y la URL
// deja de servir en un minuto.
//
// Hallazgo 1 del plan "Nada se pierde en un corte ni en un deploy"
// (21/9/2026): Meta NUNCA pasa por acá. El enlace que se le manda para
// descargar un adjunto saliente es una URL firmada de Storage armada aparte
// (`media-link.ts`), y esta ruta exige sesión de agente — a Meta le daría
// 401, nunca 500. El 500 real que sufrió un asesor el 21/9 tampoco fue de
// acá ni de Storage/Envoy: la petición de Meta murió antes, en Traefik o el
// borde TLS, y eso lo instrumenta el access log de Traefik (T9), no este
// archivo. Lo que sí faltaba acá es que un 401/403/404/500 real de un
// ASESOR mirando una foto o un sticker no dejaba ninguna línea (T7,
// 22/9/2026): ahora cada rama registra su evento.
// ---------------------------------------------------------------------------

const SIGNED_URL_TTL_SECONDS = 60;

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  // El path se resuelve dentro del `try`: si `context.params` o cualquier
  // paso anterior lanza, todavía puede quedar `undefined` acá, y el catch de
  // abajo registra lo que haya.
  let objectPath: string | undefined;

  try {
    const supabase = await createClient();

    // La sesión se lee de la cookie y no con `auth.getUser()`: esa ruta pega a
    // GoTrue (~841 ms medidos) y acá se llama UNA VEZ POR ARCHIVO, así que
    // abrir un chat con diez fotos eran diez llamadas.
    //
    // El portón no se movió de sitio: lo que autoriza es la consulta de abajo,
    // que viaja a PostgREST con este mismo token. Si el token no está firmado,
    // PostgREST la rechaza y no vuelve ninguna fila -> 403. Y `sub` no se puede
    // cambiar sin romper la firma, así que el id que se consulta es el del
    // dueño de la sesión y no uno elegido por quien pide.
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      log.warn("media.sin_sesion");
      return NextResponse.json({ error: "No autenticado." }, { status: 401 });
    }

    // Tener sesión en Supabase no basta: el CRM exige además una fila activa
    // en `agents`, igual que el resto de las políticas.
    const { data: agent } = await supabase
      .from("agents")
      .select("id")
      .eq("id", session.user.id)
      .maybeSingle();
    if (!agent) {
      log.warn("media.sin_acceso", { userId: session.user.id });
      return NextResponse.json({ error: "Sin acceso." }, { status: 403 });
    }

    const { path } = await context.params;
    objectPath = path.join("/");

    // La firma la hace el cliente admin: el bucket ya no da lectura a nadie.
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);

    if (error || !data) {
      // Antes este error de Storage se descartaba entero: un archivo movido,
      // un bucket mal configurado o un corte contra Storage se veían todos
      // igual, como un simple "no existe".
      log.error("media.no_firmado", { path: objectPath, detail: errorText(error) });
      return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 });
    }

    return NextResponse.redirect(data.signedUrl);
  } catch (err) {
    log.error("media.fallo", { path: objectPath, detail: errorText(err) });
    return NextResponse.json({ error: "No se pudo procesar el pedido." }, { status: 500 });
  }
}
