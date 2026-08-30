import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRedis } from "@/lib/redis";

// ---------------------------------------------------------------------------
// Estado del servicio, para que un monitor externo avise cuando algo se cae
// en vez de enterarnos porque un cliente reclama.
//
// Responde 200 solo si el CRM puede trabajar de verdad: llegar a la base y
// leer la configuración del agente. Un proceso que levanta pero no alcanza
// Postgres no está sano, y decir que sí sería peor que no tener endpoint.
//
// T1.7 ("Ningún lead invisible") sumó dos datos INFORMATIVOS que no tocan el
// código HTTP: `unassigned_waiting` (leads esperando sin dueño) y
// `redis_persistence` (si la cola sobrevive un reinicio). Ver sus funciones
// más abajo para qué mide cada uno y qué no.
//
// No expone nada que sirva a un tercero: ni versiones, ni credenciales, ni
// nombres de host, ni ids/teléfonos/nombres de clientes — el CONTEO de
// `unassigned_waiting` es la única excepción, y es a propósito (ver su
// comentario).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

interface CheckResult {
  ok: boolean;
  detail?: string;
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("agent_settings").select("id").eq("id", true).single();
    if (error) return { ok: false, detail: "consulta rechazada" };
    return { ok: true };
  } catch {
    return { ok: false, detail: "sin conexión" };
  }
}

/**
 * La cola del agente. Sin Redis el CRM levanta y las pantallas cargan, pero
 * ningún mensaje entrante llega a atenderse: es una caída silenciosa, del
 * tipo que se descubre por el reclamo de un cliente.
 */
async function checkQueue(): Promise<CheckResult> {
  try {
    await getRedis().ping();
    return { ok: true };
  } catch {
    return { ok: false, detail: "sin conexión" };
  }
}

/**
 * unassigned_waiting — cuántas conversaciones siguen esperando respuesta y
 * quedaron sin dueño. Es el KPI central del plan "Ningún lead invisible"
 * (T1.7): el número que un monitor externo puede vigilar sin tener que
 * entrar al panel.
 *
 * QUÉ MIDE exactamente: conversaciones con `awaiting_reply = true` que
 * tienen AL MENOS UNA fila en `conversation_handoffs` con
 * `to_kind = 'unassigned'`. El `!inner` en el embed hace que PostgREST
 * cuente conversaciones DISTINTAS (una fila por conversación en el
 * resultado, no una por traspaso), así que una conversación que quedó sin
 * dueño más de una vez en su historia no se cuenta dos veces.
 *
 * QUÉ NO MIDE: no comprueba que esa fila `unassigned` sea la ÚLTIMA de la
 * conversación. Una conversación que pasó por `unassigned` y luego fue
 * reclamada o devuelta a la IA (nueva fila `to_kind = 'human'`/`'ai'`) pero
 * que TODAVÍA no recibió respuesta —sigue `awaiting_reply = true`— se cuenta
 * igual acá, aunque ya tenga dueño. Es una sobreestimación a propósito, no
 * una subestimación: en el peor caso avisa de un lead que ya se resolvió,
 * nunca esconde uno que sigue sin dueño. Calcular "la última fila por
 * conversación" de verdad exige `DISTINCT ON` o una función de ventana, que
 * PostgREST no expone sin una RPC dedicada — T1.7 solo amplía este endpoint,
 * no agrega funciones nuevas a la base. Decisión del operador, 30/8/2026.
 *
 * El conteo lo hace `unassigned_waiting_count()` en la base y no una consulta
 * armada acá, porque la pregunta correcta —"conversaciones cuya ÚLTIMA fila
 * de bitácora las dejó sin dueño"— PostgREST no la sabe expresar. Lo más
 * parecido que se puede escribir desde el cliente es "tiene al menos una
 * fila unassigned", y ese número está inflado de fábrica: el reconciliador
 * escribe un `reabierto` encima de lo que recupera, así que toda
 * conversación rescatada seguiría contando como perdida. Medido el
 * 30/8/2026 contra la base local: con un `reabierto` posterior, el conteo
 * por embed devolvía 1 donde la respuesta correcta era 0.
 *
 * Expuesto sin autenticación por decisión explícita del operador
 * (30/8/2026), con la advertencia sobre la mesa de que publica el VOLUMEN de
 * leads desatendidos a quien conozca la URL. Por eso el número es lo único
 * que sale: nunca ids de conversación, teléfonos ni nombres — quien lea esto
 * dentro de seis meses y sienta la tentación de agregar detalle a esta
 * respuesta, que la resista.
 */
async function checkUnassignedWaiting(): Promise<CheckResult & { count: number | null }> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("unassigned_waiting_count");

    if (error) return { ok: false, count: null, detail: "consulta rechazada" };
    return { ok: true, count: data ?? 0 };
  } catch {
    return { ok: false, count: null, detail: "sin conexión" };
  }
}

/**
 * redis_persistence — el resultado de `CONFIG GET appendonly` contra Redis.
 *
 * Sin AOF, un reinicio del contenedor de Redis vacía la cola de turnos en
 * silencio: los mensajes ya encolados y no procesados desaparecen sin que
 * nadie se entere. Es exactamente el agujero que el reconciliador tapa desde
 * el otro lado (conversaciones que quedan `unassigned` sin explicación) —
 * esto avisa ANTES de que pase, no después.
 *
 * Puramente informativo: no decide el código HTTP. Un Redis sin
 * persistencia responde igual y la cola funciona en caliente, así que no es
 * una caída del servicio — es una advertencia de operación.
 */
async function checkRedisPersistence(): Promise<CheckResult & { appendonly: string | null }> {
  try {
    const result = await getRedis().config("GET", "appendonly");
    // ioredis en modo RESP2 (el default) devuelve CONFIG GET como pares
    // [clave, valor, clave, valor, ...]; para una sola clave es un array de
    // dos elementos y el valor queda en el índice 1.
    const pairs = result as unknown as string[];
    const value = Array.isArray(pairs) ? pairs[1] : undefined;
    return { ok: true, appendonly: value ?? null };
  } catch {
    return { ok: false, appendonly: null, detail: "sin conexión" };
  }
}

/**
 * Variables sin las cuales el CRM arranca pero no hace su trabajo. Se informa
 * cuáles faltan por nombre —no su valor— porque es exactamente el dato que
 * hace falta para arreglarlo.
 */
function checkConfig(): CheckResult & { missing: string[] } {
  const required = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "REDIS_URL",
  ];

  // En producción el webhook se rechaza sin esta variable, así que su
  // ausencia es una falla y no un aviso.
  if (process.env.NODE_ENV === "production") required.push("WHATSAPP_APP_SECRET");

  const missing = required.filter((name) => !process.env[name]);
  return { ok: missing.length === 0, missing };
}

export async function GET() {
  const [database, queue, config, unassignedWaiting, redisPersistence] = [
    await checkDatabase(),
    await checkQueue(),
    checkConfig(),
    await checkUnassignedWaiting(),
    await checkRedisPersistence(),
  ];
  // Los tres de siempre deciden el código HTTP. Los dos nuevos son
  // informativos a propósito (ver sus comentarios): ni un lead esperando ni
  // un Redis sin AOF son una caída del servicio.
  const healthy = database.ok && queue.ok && config.ok;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: {
        database: database.ok ? "ok" : `fallo: ${database.detail}`,
        queue: queue.ok ? "ok" : `fallo: ${queue.detail}`,
        config: config.ok ? "ok" : `faltan variables: ${config.missing.join(", ")}`,
      },
      unassigned_waiting: unassignedWaiting.ok ? unassignedWaiting.count : `fallo: ${unassignedWaiting.detail}`,
      redis_persistence: redisPersistence.ok ? redisPersistence.appendonly : `fallo: ${redisPersistence.detail}`,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
