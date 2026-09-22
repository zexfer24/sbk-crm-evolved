import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processQueuedTurns } from "@/lib/ai/queue";
import { reconcileOrphanTurns } from "@/lib/ai/reconciler";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { getRedis } from "@/lib/redis";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Red de seguridad de la cola de turnos.
//
// El camino normal es que el propio webhook procese lo que encola. Esto
// cubre dos cosas que ese camino no cubre, en este orden:
//
//   1. Reconciliar (reconcileOrphanTurns, ver src/lib/ai/reconciler.ts): el
//      turno que nunca llegó a encolarse de verdad porque Redis lo perdió
//      -un reinicio sin persistencia, un `flushdb`, un proceso que murió
//      entre escribir el mensaje y encolar el turno-. El único que encola es
//      el webhook, y esa ventana ya pasó: sin esto, esa conversación no
//      vuelve a mirarse nunca. Postgres, no Redis, es la fuente de verdad de
//      quién sigue esperando.
//   2. Drenar (processQueuedTurns): el turno que sí quedó en la cola pero no
//      se procesó -el proceso que murió a mitad de turno, o el que falló y
//      quedó esperando otro intento-.
//
// El orden importa y es deliberado: reconciliar ANTES de drenar deja que lo
// que el reconciliador reencola en esta pasada se atienda en esta MISMA
// llamada -encola con debounce cero, así que ya está vencido para cuando
// processQueuedTurns corre un instante después-, en vez de esperar los cinco
// minutos hasta el próximo disparo del cron. Al revés -drenar primero-
// dejaría lo reconciliado esperando esa vuelta completa, justo el retraso
// que el reconciliador vino a evitar.
//
// Se llama desde un cron externo cada minuto (cada 5 minutos hasta el
// 7/9/2026: ver docs/PRODUCCION.md, "Rampa de los topes"). El drenado no
// depende de este intervalo para ir rápido — eso lo hace el propio webhook,
// con el tope de AGENT_MAX_TURNS_PER_MINUTE (src/lib/ai/queue.ts); esto sigue
// siendo solo la red de seguridad para lo que ese camino no cubre.
//
//   3. Purgar (purgeTurnTelemetryIfDue, T4, plan "Nada se pierde en un corte
//      ni en un deploy", 21-22/9/2026): DESPUÉS de reconciliar y drenar, sin
//      que un fallo suyo pueda tocar ninguna de las dos cosas de arriba —
//      borra de `agent_turn_calls` lo más viejo que la retención (90 días),
//      una sola vez al día (lock en Redis), y nunca frena este endpoint.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

/** Comparación en tiempo constante: un `===` filtra el secreto carácter a carácter. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Purgado diario de `agent_turn_calls` (T4, plan "Nada se pierde en un corte
// ni en un deploy", 21-22/9/2026, migración 20260921040000). La tabla nace
// SIN retención (T3 del mismo plan): 3-7 filas por turno, 1.100-2.500/día
// medidas el 21/9/2026 -- sin esto crece para siempre.
//
// `RETAIN_DAYS` repite el default de la RPC `agent_turn_calls_purge`
// explícito acá para que quede a la vista en el código de quien la llama, no
// solo escondido en la firma de la función de la base.
// ---------------------------------------------------------------------------
const RETAIN_DAYS = 90;

/** YYYY-MM-DD en UTC: el mismo día lógico sin importar la zona horaria del reloj de la instancia que corre el cron. */
function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Guarda en Redis para que el purgado corra UNA sola vez por día, aunque el
 * cron dispare más seguido de lo esperado o dos instancias corran a la vez
 * -- mismo patrón que `acquireSweepLock` (redis-queue.ts): `SET NX EX` es la
 * carrera entera, la primera que la gana es la única que purga.
 *
 * Nunca lanza: un corte de Redis (o `REDIS_URL` sin configurar, que
 * `getRedis()` sí lanza) deja `log.warn` y la función devuelve `false` --
 * "no se pudo confirmar que somos los primeros hoy" se trata como "no
 * purgar", nunca como "purgar igual y arriesgar dos DELETE del mismo día
 * (inofensivo, pero un desperdicio que además esconde si el lock de verdad
 * está funcionando)".
 */
async function claimDailyPurgeLock(now: Date): Promise<boolean> {
  const key = `telemetria:purga:${utcDateKey(now)}`;
  try {
    const puesto = await getRedis().set(key, "1", "EX", 86_400, "NX");
    return puesto === "OK";
  } catch (err) {
    log.warn("telemetria_purga_lock_no_disponible", { detail: errorText(err) });
    return false;
  }
}

/**
 * El purgado en sí, protegido por el lock de arriba. Nunca lanza -- ni el
 * lock ni la RPC pueden frenar la cola, que es lo que de verdad importa que
 * este cron drene (ver el resto del archivo). Si la RPC falla, queda
 * `log.warn`; si purga de verdad, `log.info("telemetria_purgada", { filas })`
 * con lo que devolvió `agent_turn_calls_purge` (filas borradas).
 */
async function purgeTurnTelemetryIfDue(supabase: SupabaseClient<Database>): Promise<void> {
  try {
    if (!(await claimDailyPurgeLock(new Date()))) return;

    const { data, error } = await supabase.rpc("agent_turn_calls_purge", { retain_days: RETAIN_DAYS });
    if (error) {
      log.warn("telemetria_purga_fallida", { detail: errorText(error) });
      return;
    }
    log.info("telemetria_purgada", { filas: data ?? 0 });
  } catch (err) {
    // Red de más: nada de lo de arriba debería lanzar (las dos partes ya
    // tienen su propio try/catch), pero esto es un cron -- que se caiga por
    // un fallo de telemetría, que es accesorio, sería peor que perderla.
    log.warn("telemetria_purga_fallida", { detail: errorText(err) });
  }
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;

  // Sin secreto no se abre: este endpoint dispara turnos de IA, o sea gasto.
  // Se falla cerrado siempre, también fuera de producción.
  if (!secret) {
    console.error("Cola de turnos: falta CRON_SECRET, no se procesa nada.");
    return NextResponse.json({ error: "Endpoint mal configurado." }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!provided || !tokenMatches(provided, secret)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  const supabase = createAdminClient();
  const reconciled = await reconcileOrphanTurns(supabase);
  const result = await processQueuedTurns();
  // T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026):
  // DESPUÉS de reconciliar y drenar, a propósito -- es lo accesorio de esta
  // llamada, y `purgeTurnTelemetryIfDue` nunca lanza, así que no puede
  // retrasar ni frenar lo que de verdad importa que este cron haga.
  await purgeTurnTelemetryIfDue(supabase);
  return NextResponse.json({ ok: true, reconciled, ...result });
}
