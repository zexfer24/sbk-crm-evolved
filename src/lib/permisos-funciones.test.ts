import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ============================================================================
// Guardián estático de permisos sobre funciones `security definer`
//
// Por qué existe además del script de aserciones contra la base real
// (supabase/tests/permisos_funciones.sql): esa suite corre con Postgres vivo
// y solo se ejecuta en el job `migraciones` de CI — en Windows local Docker
// suele estar apagado y nadie la ve pasar antes del commit. Este archivo no
// necesita base: lee los `.sql` de supabase/migrations como texto y atrapa
// el mismo agujero de origen (auditoría del 30/8/2026: `agent_metrics` le
// devolvía métricas de ventas a la anon key, sin sesión) en el momento en
// que sale más barato: al escribir la migración, no seis meses después en
// una auditoría.
//
// EL PRIVILEGIO LLEGA POR DOS VÍAS INDEPENDIENTES, Y HAY QUE CORTAR LAS DOS
// (la razón de que este archivo exija DOS revokes, no uno):
//   1. Postgres — no Supabase — concede EXECUTE de fábrica al pseudo-rol
//      PUBLIC en toda función nueva (`pg_proc.proacl` trae una entrada
//      `=X/postgres`, sin nombre de rol antes del `=`). Mientras esa entrada
//      siga ahí, `has_function_privilege('anon', ...)` da `true` aunque no
//      exista ningún grant a `anon`, porque `anon` hereda de PUBLIC. Se
//      corta con `revoke execute ... from public`.
//   2. Supabase deja un `alter default privileges ... grant execute on
//      functions to anon, authenticated, service_role` en `public`, que
//      agrega grants EXPLÍCITOS a esos roles (visibles en pg_default_acl).
//      Se corta con `revoke execute ... from anon, authenticated`.
//
// El dato que obliga a exigir las dos y no una: la migración del
// 30/8/2026 (20260830010000_security_definer_revoke_roles.sql), en su
// primera versión, solo traía el revoke de la vía 2 (`from anon,
// authenticated`) para las 17 funciones. Se aplicó contra una base real y,
// al medir después con `has_function_privilege` contra `pg_proc.proacl`,
// 14 de las 17 funciones seguían siendo ejecutables por `anon` — solo las
// tres del lock (`ai_turn_lock_acquire/renew/release`) habían quedado
// cerradas, y de pura casualidad: su migración original
// (20260829020000_conversations_turn_lock_lease.sql:113-115) ya traía el
// `revoke ... from public` (vía 1) que a la nueva migración le faltaba. Un
// test que solo pidiera "algún revoke que mencione anon" habría aprobado
// esa migración rota sin chistar: por eso la regla de acá exige que, para
// cada función, existan AMBOS revokes en algún lugar del historial de
// migraciones — no necesariamente en el mismo archivo ni en la misma
// sentencia, porque las tres del lock reciben uno en 20260829020000 y el
// otro en 20260830010000, y ese patrón (revoke repartido entre migraciones)
// es legítimo y va a repetirse.
//
// La trampa que hay que dejar escrita acá también: `is_agent()` e
// `is_supervisor_or_admin()` están en la lista blanca A PROPÓSITO, no por
// descuido. 49 políticas de RLS vivas las invocan y 48 no llevan cláusula
// `TO`, o sea que corren `TO public` — para todos los roles, `anon`
// incluido. Una política se evalúa con los privilegios del rol que consulta:
// revocarle EXECUTE a `anon` sobre `is_agent()` convierte una consulta
// anónima a `contacts` (hoy 0 filas, sin reventar) en un `42501 permission
// denied for function is_agent`; revocárselo a `authenticated` apaga el CRM
// para todo el equipo. Ninguna de las dos filtra nada por sí sola — son un
// booleano sobre quién pregunta, el filtro lo pone la política que las usa.
// Que nadie las saque de la lista blanca "por consistencia" con las demás.
// ============================================================================

const LISTA_BLANCA = new Set(["is_agent", "is_supervisor_or_admin"]);

// Las 17 funciones `security definer` conocidas en el esquema `public` a
// fecha 30/8/2026. Sirve para comprobar que el parser de abajo no se está
// quedando corto: si algún día detecta menos de estas, el guardián dejó de
// proteger algo y hay que enterarse antes de confiar en el resultado.
const FUNCIONES_SECURITY_DEFINER_CONOCIDAS = [
  "is_agent",
  "is_supervisor_or_admin",
  "handle_new_agent",
  "handle_new_message",
  "handle_conversation_assigned",
  "handle_message_status_change",
  "enforce_sale_role_guard",
  "agent_spend_today",
  "agent_can_run",
  "rate_limit_allow",
  "enqueue_agent_turn",
  "claim_agent_turn",
  "finish_agent_turn",
  "agent_metrics",
  "ai_turn_lock_acquire",
  "ai_turn_lock_renew",
  "ai_turn_lock_release",
].sort();

const DIR_MIGRACIONES = path.resolve(__dirname, "../../supabase/migrations");

interface CreacionFuncion {
  nombre: string;
  archivo: string;
  esSecurityDefiner: boolean;
}

/**
 * Recorre un archivo de migración y devuelve cada `create function` /
 * `create or replace function public.<nombre>` que encuentre, junto con si
 * esa creación puntual llevaba `security definer`.
 *
 * Una función puede crearse en un archivo y reemplazarse (`create or
 * replace`) en otro más adelante — por eso esto devuelve TODAS las
 * creaciones, no solo la primera, y quien llama se queda con la última en
 * orden cronológico para saber el estado final.
 *
 * El truco del parseo: entre `create function` y el cuerpo hay firma,
 * `returns`, `language`, volatilidad y `security definer` — todo eso puede
 * partirse en varias líneas y `security definer` puede aparecer bastante más
 * abajo del `create` (agent_metrics lo tiene 17 líneas después, por el
 * `returns table (...)` de varias columnas). Pero nada de eso contiene `$$`:
 * el cuerpo dollar-quoted (siempre con `$$` en este repo, se verificó que no
 * se usa otra etiqueta) es lo primero que aparece con `$$` tras el `create`.
 * Así que cortar el texto entre el `create function` y el primer `$$`
 * siguiente da exactamente la cabecera de la función, sin arrastrar nada del
 * cuerpo (que sí podría contener la palabra "definer" en un comentario y dar
 * un falso positivo).
 */
function extraerCreaciones(contenido: string, archivo: string): CreacionFuncion[] {
  const creaciones: CreacionFuncion[] = [];
  const regexCreate = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_][a-z0-9_]*)\s*\(/gi;

  let coincidencia: RegExpExecArray | null;
  while ((coincidencia = regexCreate.exec(contenido)) !== null) {
    const nombre = coincidencia[1].toLowerCase();
    const inicioCabecera = coincidencia.index;
    const indiceDolar = contenido.indexOf("$$", coincidencia.index);
    const finCabecera = indiceDolar === -1 ? contenido.length : indiceDolar;
    const cabecera = contenido.slice(inicioCabecera, finCabecera);

    creaciones.push({
      nombre,
      archivo,
      esSecurityDefiner: /security\s+definer/i.test(cabecera),
    });
  }

  return creaciones;
}

/**
 * Devuelve, para cada `revoke execute on function public.<nombre>(...)`
 * encontrado en el contenido (acumulado de todas las migraciones, no de un
 * solo archivo), la lista de roles que sigue al `from` — la parte que
 * importa es SOLO lo que va después del `from` y antes del `;`: el propio
 * nombre calificado de la función ya trae un `public.` como prefijo de
 * esquema (`public.claim_agent_turn(...)`) que no tiene nada que ver con el
 * rol PUBLIC, así que hay que cortarlo antes de mirar roles. El grupo
 * capturado por la regex ya excluye ese prefijo — arranca después del
 * `from` — así que buscar `\bpublic\b` ahí adentro no puede confundirse con
 * el prefijo de esquema.
 *
 * No exige que la firma (tipos de parámetros) coincida con la del `create`:
 * acá solo importa el nombre, porque lo que se audita es "¿existe algún
 * revoke real para esta función en algún lado del historial?", no
 * reconstruir sobrecargas.
 *
 * Distintas sentencias `revoke` sobre la misma función (una a `public`, otra
 * a `anon, authenticated`, en el mismo archivo o en archivos distintos) son
 * coincidencias separadas de esta regex global — por diseño: el revoke a
 * PUBLIC y el revoke a anon/authenticated son dos vías de privilegio
 * independientes (ver comentario de cabecera) y pueden llegar en momentos
 * distintos, como pasa hoy con las tres funciones del lock.
 */
function listasDeRolesEnRevokes(contenido: string, nombre: string): string[] {
  const regexRevoke = new RegExp(
    `revoke\\s+execute\\s+on\\s+function\\s+public\\.${nombre}\\s*\\([^;]*?from\\s+([^;]+);`,
    "gi",
  );

  const listas: string[] = [];
  let coincidencia: RegExpExecArray | null;
  while ((coincidencia = regexRevoke.exec(contenido)) !== null) {
    listas.push(coincidencia[1]);
  }

  return listas;
}

/** ¿Alguna sentencia `revoke` de esta función le quita EXECUTE al rol que matchea `rol`? */
function tieneRevokeDeRol(contenido: string, nombre: string, rol: RegExp): boolean {
  return listasDeRolesEnRevokes(contenido, nombre).some((listaRoles) => rol.test(listaRoles));
}

function leerMigraciones(): { archivo: string; contenido: string }[] {
  return readdirSync(DIR_MIGRACIONES)
    .filter((f) => f.endsWith(".sql"))
    .sort() // los nombres llevan timestamp: el orden alfabético es el cronológico
    .map((archivo) => ({
      archivo,
      contenido: readFileSync(path.join(DIR_MIGRACIONES, archivo), "utf8"),
    }));
}

describe("permisos de funciones security definer (guardián estático)", () => {
  const migraciones = leerMigraciones();

  // Estado final por función: la última creación en orden cronológico manda,
  // porque un `create or replace` puede quitarle o ponerle `security
  // definer` a una función que ya existía (no pasa hoy en este repo, pero el
  // detector tiene que seguir siendo correcto si pasara).
  const estadoFinal = new Map<string, { esSecurityDefiner: boolean; archivos: string[] }>();

  for (const { archivo, contenido } of migraciones) {
    for (const creacion of extraerCreaciones(contenido, archivo)) {
      const previo = estadoFinal.get(creacion.nombre);
      const archivos = previo ? [...previo.archivos, archivo] : [archivo];
      estadoFinal.set(creacion.nombre, {
        esSecurityDefiner: creacion.esSecurityDefiner,
        archivos,
      });
    }
  }

  const funcionesSecurityDefiner = [...estadoFinal.entries()]
    .filter(([, info]) => info.esSecurityDefiner)
    .map(([nombre]) => nombre)
    .sort();

  it("detecta exactamente las 17 funciones security definer conocidas", () => {
    // Si esto falla con MENOS de las 17, el parser se está comiendo alguna
    // (regex de cabecera roto, `$$` no encontrado, etc.) y el resto de este
    // archivo no protege nada aunque pase en verde. Si falla con MÁS,
    // apareció una función security definer nueva: hay que sumarla a esta
    // lista a propósito (y decidir si entra a la lista blanca o necesita su
    // revoke), no ajustar el test para que calle.
    expect(funcionesSecurityDefiner).toEqual(FUNCIONES_SECURITY_DEFINER_CONOCIDAS);
  });

  it("toda función security definer fuera de la lista blanca tiene los dos revokes: a public y a anon", () => {
    const contenidoCompleto = migraciones.map((m) => m.contenido).join("\n");

    const infractoras: string[] = [];

    for (const nombre of funcionesSecurityDefiner) {
      if (LISTA_BLANCA.has(nombre)) continue;

      const tienePublic = tieneRevokeDeRol(contenidoCompleto, nombre, /\bpublic\b/i);
      const tieneAnon = tieneRevokeDeRol(contenidoCompleto, nombre, /\banon\b/i);
      if (tienePublic && tieneAnon) continue;

      const archivos = estadoFinal.get(nombre)?.archivos ?? [];
      const explicaciones: string[] = [];

      if (!tienePublic) {
        explicaciones.push(
          '    · falta el revoke a `public`: sin "revoke execute ... from public", Postgres le' +
            " sigue concediendo EXECUTE de fábrica al pseudo-rol PUBLIC, y `anon` hereda de" +
            " PUBLIC — has_function_privilege('anon', ...) da true igual, aunque no exista" +
            " ningún grant explícito a anon.",
        );
      }
      if (!tieneAnon) {
        explicaciones.push(
          '    · falta el revoke a `anon` (típicamente "from anon, authenticated"): sin él,' +
            " el `alter default privileges ... grant execute on functions to anon," +
            " authenticated` que Supabase deja de fábrica en public le sigue dando EXECUTE" +
            " explícito a anon, más allá de lo que diga (o no diga) el revoke a PUBLIC.",
        );
      }

      infractoras.push(
        [`  - ${nombre}() — creada en: ${archivos.join(", ")}`, ...explicaciones].join("\n"),
      );
    }

    if (infractoras.length > 0) {
      throw new Error(
        [
          "Funciones security definer con algún revoke de EXECUTE faltante:",
          ...infractoras,
          "",
          "El privilegio llega por dos vías independientes y hace falta cortar las dos",
          "(ver cabecera de este archivo y de",
          "supabase/migrations/20260830010000_security_definer_revoke_roles.sql): un",
          "`revoke ... from public` sin el `revoke ... from anon[, authenticated]` — o al",
          "revés — deja la función tan abierta como si no tuviera ningún revoke. Los dos",
          "pueden estar en la misma sentencia, en sentencias distintas, o incluso en",
          "migraciones distintas (como las tres del lock, que reciben uno en",
          "20260829020000 y el otro en 20260830010000): lo único que importa es que ambos",
          "existan en algún lugar del historial.",
        ].join("\n"),
      );
    }
  });

  it("la lista blanca sigue teniendo exactamente las dos funciones que sostienen RLS", () => {
    // Con una tercera adentro esta prueba no dice nada por sí sola (haría
    // falta leer el diff para saber si se coló una de más), así que se deja
    // explícito el tamaño esperado.
    expect([...LISTA_BLANCA].sort()).toEqual(["is_agent", "is_supervisor_or_admin"]);
  });
});
