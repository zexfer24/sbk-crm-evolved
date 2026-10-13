// Alta de un usuario de CAJA (13/10/2026, migración 20261013010000_rol_caja.sql).
//
// Una cuenta de caja solo LEE el Inventario: la base (RLS) no le deja ver
// conversaciones, clientes, ventas ni configuración. El rol viaja en
// `app_metadata` (que SOLO escribe el servidor con la llave service_role) y no
// en `user_metadata` (que el propio usuario puede editar). `handle_new_agent()`
// sabe leerlo, pero GoTrue lo escribe DESPUÉS del INSERT (ver más abajo), así
// que el script fija además `role = 'caja'` e `is_active = false` en `agents`
// (la IA nunca le reparte chats) y lo confirma leyendo de vuelta.
//
// Uso (Node 22.18+ ya corre TypeScript sin banderas; en uno anterior, con
// `--experimental-strip-types`). No hay `tsx` en el proyecto:
//
//   node --env-file=.env.local scripts/crear-usuario-caja.ts \
//     --email caja1@sbk.com --password "una-clave-larga" --nombre "Caja 1"
//
// Variables de entorno: NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY
// (las mismas que usa `src/lib/supabase/admin.ts`). En el VPS, con las del
// contenedor de la app. No importa `server-only` a propósito: es un script
// de consola, no código de Next.
//
// Sale con código 0 solo si la fila de `agents` quedó con `role = 'caja'` e
// `is_active = false`; con cualquier otro resultado sale con código 1 y dice
// por qué (y, si la cuenta ya se había creado, la borra para no dejar un
// asesor sin querer). Si el correo ya existe NO lo pisa (no cambia
// contraseñas ni roles de cuentas ajenas): hay que borrarlo antes o usar otro
// correo. El aviso MODULE_TYPELESS_PACKAGE_JSON de Node es inofensivo
// (package.json no declara "type").

import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

export interface ArgumentosCaja {
  email: string;
  password: string;
  nombre: string;
}

export type ResultadoArgumentos =
  | { ok: true; valor: ArgumentosCaja }
  | { ok: false; error: string };

/** Largo mínimo de la contraseña (el mínimo por defecto de Supabase Auth es 6). */
export const LARGO_MINIMO_PASSWORD = 8;

const USO =
  'Uso: node --env-file=.env.local scripts/crear-usuario-caja.ts --email <correo> --password <clave> --nombre "<nombre>"';

/**
 * Parsea `--email x --password y --nombre z` (también `--email=x`). Pura: no
 * lee el entorno ni escribe nada, para poder probarla sin base ni red.
 * Valida lo mínimo que haría fallar el alta a medias (correo con forma de
 * correo, clave de largo suficiente, nombre no vacío) y rechaza banderas
 * desconocidas o repetidas para que un error de tipeo no se pierda.
 */
export function parsearArgumentos(argv: readonly string[]): ResultadoArgumentos {
  const conocidas = new Set(["email", "password", "nombre"]);
  const valores = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      return { ok: false, error: `Argumento inesperado "${token}". ${USO}` };
    }
    const igual = token.indexOf("=");
    const clave = (igual === -1 ? token.slice(2) : token.slice(2, igual)).trim();
    if (!conocidas.has(clave)) {
      return { ok: false, error: `Bandera desconocida "--${clave}". ${USO}` };
    }
    if (valores.has(clave)) {
      return { ok: false, error: `La bandera "--${clave}" está repetida. ${USO}` };
    }
    let valor: string | undefined;
    if (igual !== -1) {
      valor = token.slice(igual + 1);
    } else {
      valor = argv[i + 1];
      if (valor === undefined || valor.startsWith("--")) {
        return { ok: false, error: `Falta el valor de "--${clave}". ${USO}` };
      }
      i++;
    }
    valores.set(clave, valor);
  }

  for (const clave of conocidas) {
    if (!valores.get(clave)?.trim()) {
      return { ok: false, error: `Falta "--${clave}". ${USO}` };
    }
  }

  const email = valores.get("email")!.trim().toLowerCase();
  const password = valores.get("password")!;
  const nombre = valores.get("nombre")!.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: `El correo "${email}" no parece un correo válido.` };
  }
  if (password.length < LARGO_MINIMO_PASSWORD) {
    return {
      ok: false,
      error: `La contraseña debe tener al menos ${LARGO_MINIMO_PASSWORD} caracteres.`,
    };
  }

  return { ok: true, valor: { email, password, nombre } };
}

/** Error de uso o de entorno que el script explica y convierte en código de salida 1. */
class ErrorAlta extends Error {}

function falla(mensaje: string): never {
  throw new ErrorAlta(mensaje);
}

async function principal(): Promise<void> {
  const args = parsearArgumentos(process.argv.slice(2));
  if (!args.ok) falla(args.error);
  const { email, password, nombre } = args.valor;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const llave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) falla("falta NEXT_PUBLIC_SUPABASE_URL en el entorno.");
  if (!llave) falla("falta SUPABASE_SERVICE_ROLE_KEY en el entorno.");

  const supabase = createClient(url, llave, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: creado, error: errorCrear } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "caja" },
    user_metadata: { display_name: nombre, full_name: nombre },
  });
  if (errorCrear || !creado.user) {
    falla(`no se pudo crear la cuenta: ${errorCrear?.message ?? "respuesta vacía de Auth"}`);
  }
  const id = creado.user.id;

  // A partir de acá la cuenta existe: si algo falla, se BORRA para no dejar
  // una cuenta con contraseña y rol de asesor (el valor por defecto).
  try {
    // GoTrue hace INSERT en auth.users con el app_metadata de fábrica y
    // recién después un UPDATE con el `app_metadata` que se le pasó (medido
    // contra la base local el 13/10/2026): el trigger handle_new_agent() es
    // AFTER INSERT, o sea que ve la fila SIN el rol y crea al agente como
    // 'agent'. Por eso el rol se fija aquí, con service_role (que pasa el
    // trigger agents_role_guard), y no se confía solo en el metadata.
    const { error: errorRol } = await supabase
      .from("agents")
      .update({ role: "caja", is_active: false })
      .eq("id", id);
    if (errorRol) {
      falla(`no se pudo fijar el rol caja: ${errorRol.message}`);
    }

    // Se lee de vuelta: el alta solo vale si la base lo confirma.
    const { data: fila, error: errorLeer } = await supabase
      .from("agents")
      .select("id, role, is_active, display_name")
      .eq("id", id)
      .maybeSingle();
    if (errorLeer) {
      falla(`no se pudo leer la fila de agents: ${errorLeer.message}`);
    }
    if (!fila) {
      falla("la cuenta no tiene fila en agents (¿está aplicada la migración 20261013010000_rol_caja.sql?).");
    }
    if (fila.role !== "caja" || fila.is_active !== false) {
      falla(
        `la cuenta quedó con role=${fila.role} is_active=${fila.is_active}; se esperaba role=caja is_active=false ` +
          "(¿está aplicada la migración 20261013010000_rol_caja.sql?).",
      );
    }

    console.log(
      `Usuario de caja creado: ${email} (${fila.display_name}), id ${id}, role=${fila.role}, is_active=${fila.is_active}.`,
    );
  } catch (err) {
    const { error: errorBorrar } = await supabase.auth.admin.deleteUser(id);
    const sufijo = errorBorrar
      ? ` NO se pudo borrar la cuenta ${id} (${errorBorrar.message}): bórrala a mano en Auth, tiene rol de asesor.`
      : " La cuenta se borró.";
    const motivo = err instanceof Error ? err.message : String(err);
    throw new ErrorAlta(`${motivo}${sufijo}`);
  }
}

// Solo corre al invocarlo como script, no al importarlo desde el test. Se usa
// `process.exitCode` y no `process.exit()`: cortar de golpe con una conexión
// abierta tira un assert de libuv en Windows (y deja el código en 127).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((err: unknown) => {
    const mensaje = err instanceof Error ? err.message : String(err);
    console.error(`crear-usuario-caja: ${err instanceof ErrorAlta ? "" : "error inesperado: "}${mensaje}`);
    process.exitCode = 1;
  });
}
