import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Quién puede ver una página, y el refresco de la sesión.
//
// Lo que NO hace, y por qué: preguntarle a GoTrue "¿este token sigue vivo?"
// (`auth.getUser()`) en cada petición. Medido contra GoTrue directo, esa
// llamada tarda 300 ms–3,5 s y consume 53–82 % de un núcleo, mientras sus
// consultas a la base tardan 0,3–0,6 ms: el tiempo se va dentro de GoTrue.
// Eran 8,5 llamadas por minuto a 841 ms de media.
//
// La sesión que ya viaja en la cookie alcanza para las dos cosas que se
// deciden acá, y no baja el listón de seguridad:
//
//   - El token va a PostgREST en CADA consulta, que verifica su firma con el
//     JWT_SECRET y aplica RLS. Ninguna fila sale de la base sin esa
//     verificación, la haga o no la aplicación.
//   - Lo único que agregaba `getUser()` era detectar una sesión revocada
//     antes de que expire el token. Pero eso nunca protegió los datos:
//     cualquiera con ese mismo token puede pegarle a PostgREST directo. El
//     listón real es y sigue siendo la firma.
//   - Redirigir a /login no es una decisión de autorización, es de
//     navegación. Una cookie inventada pasa este portón y no consigue nada:
//     la primera consulta la rechaza PostgREST.
//
// `getSession()` sí renueva el token cuando venció (una llamada por hora, no
// una por petición) y escribe la cookie nueva, que es la otra mitad del
// trabajo de este middleware.
// ---------------------------------------------------------------------------

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Las rutas /api/* manejan su propia autenticación (401 en JSON en vez de
  // redirect a /login) — el webhook de Meta en particular no tiene sesión de
  // usuario, se verifica con su propio verify_token. Acá no se decide nada
  // sobre ellas, así que no hay ninguna razón para mirar la sesión: hacerlo
  // costaba una llamada a GoTrue por healthcheck (cada 30 s), por mensaje
  // entrante de WhatsApp y por vuelta del cron. Cada route handler crea su
  // propio cliente y renueva la sesión si le hace falta.
  if (pathname.startsWith("/api")) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const isLogin = pathname.startsWith("/login");

  if (!session && !isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (session && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
