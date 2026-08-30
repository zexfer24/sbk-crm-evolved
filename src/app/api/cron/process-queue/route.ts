import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { processQueuedTurns } from "@/lib/ai/queue";
import { reconcileOrphanTurns } from "@/lib/ai/reconciler";
import { createAdminClient } from "@/lib/supabase/admin";

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
// Se llama desde un cron externo cada pocos minutos (ver docs/PRODUCCION.md).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

/** Comparación en tiempo constante: un `===` filtra el secreto carácter a carácter. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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

  const reconciled = await reconcileOrphanTurns(createAdminClient());
  const result = await processQueuedTurns();
  return NextResponse.json({ ok: true, reconciled, ...result });
}
