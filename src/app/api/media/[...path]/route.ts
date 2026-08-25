import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MEDIA_BUCKET } from "@/lib/storage";

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
// ---------------------------------------------------------------------------

const SIGNED_URL_TTL_SECONDS = 60;

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
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
    return NextResponse.json({ error: "Sin acceso." }, { status: 403 });
  }

  const { path } = await context.params;
  const objectPath = path.join("/");

  // La firma la hace el cliente admin: el bucket ya no da lectura a nadie.
  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);

  if (error || !data) {
    return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 });
  }

  return NextResponse.redirect(data.signedUrl);
}
