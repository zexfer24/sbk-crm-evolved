import { createServerClient } from "@supabase/ssr";
import type { Session } from "@supabase/supabase-js";
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

// ---------------------------------------------------------------------------
// El rol `caja` (13/10/2026): cuentas que solo VEN el Inventario.
//
// En la base `is_agent()` les da false (no leen conversaciones ni mensajes) y
// `can_read_inventory()` les abre solo el inventario. Acá se cierra además la
// navegación: una cuenta de caja que escriba `/inbox` en la barra aterriza en
// `/inventario` en vez de ver una bandeja vacía llena de errores de RLS. Es de
// NAVEGACIÓN, no de autorización (la autorización es la RLS, ver arriba): la
// misma razón por la que leer el rol del JWT de la cookie, sin preguntarle a
// GoTrue, alcanza. El rol viaja en `app_metadata.role` (los usuarios de caja se
// crean con la Admin API con ese metadata; `app_metadata` solo lo escribe el
// servidor, el usuario no puede cambiárselo).
// ---------------------------------------------------------------------------

/** Prefijos de ruta de la sección y de los estáticos que una cuenta de caja puede pedir. */
const PREFIJOS_ESTATICOS = ["/_next/", "/favicon", "/manifest", "/icon", "/apple-icon"];

function esRutaOSubruta(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * ¿Puede una cuenta de caja pedir esta PÁGINA? Solo `/inventario` (y sus
 * subrutas), `/login` y los estáticos. Un prefijo parecido (`/inventarioX`) NO
 * cuenta. Las rutas `/api/*` no pasan por acá: para caja son siempre 403.
 */
export function rutaPermitidaParaCaja(pathname: string): boolean {
  if (esRutaOSubruta(pathname, "/inventario") || esRutaOSubruta(pathname, "/login")) return true;
  return PREFIJOS_ESTATICOS.some((prefijo) => pathname.startsWith(prefijo));
}

function esCaja(session: Session | null): boolean {
  return session?.user?.app_metadata?.role === "caja";
}

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const esApi = pathname.startsWith("/api");

  // Las rutas /api/* manejan su propia autenticación (401 en JSON en vez de
  // redirect a /login) — el webhook de Meta en particular no tiene sesión de
  // usuario, se verifica con su propio verify_token. Acá no se decide nada
  // sobre ellas, así que no hay ninguna razón para mirar la sesión: hacerlo
  // costaba una llamada a GoTrue por healthcheck (cada 30 s), por mensaje
  // entrante de WhatsApp y por vuelta del cron. Cada route handler crea su
  // propio cliente y renueva la sesión si le hace falta.
  //
  // Única excepción (13/10/2026, rol `caja`): una petición /api CON cookie de
  // Supabase sí se mira, para devolverle 403 a una cuenta de caja. El
  // webhook, el cron y el healthcheck no traen cookie `sb-*`, así que siguen
  // sin pagar nada.
  if (esApi && !request.cookies.getAll().some((c) => c.name.startsWith("sb-"))) {
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

  const caja = esCaja(session);

  if (esApi) {
    // Se devuelve `supabaseResponse` y no un `next()` nuevo: si `getSession()`
    // renovó el token, la cookie nueva viaja ahí; descartarla gastaría el
    // refresh token (rota en cada uso) y la ruta fallaría al renovar el suyo.
    if (caja) return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    return supabaseResponse;
  }

  const isLogin = pathname.startsWith("/login");

  if (!session && !isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (session && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = caja ? "/inventario" : "/";
    return NextResponse.redirect(url);
  }

  if (caja && !rutaPermitidaParaCaja(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/inventario";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
