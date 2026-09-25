import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getBcvRate } from "@/lib/ai/bcv";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Fuerza la relectura de la tasa BCV cada minuto. Plan "La tasa BCV se lee
// cuatro veces al día" (25/9/2026): hasta esa fecha la única relectura la
// disparaba el request de un agente en la bandeja, y si nadie abría el CRM
// justo después de un horario (00/06/12/18 VE), la tasa vieja quedaba puesta
// horas de más — el caso real del 24/9 a las 23:53 mostrando la tasa de la
// mañana con la de mañana ya publicada por el BCV.
//
// La llama el servicio `cron` del compose cada minuto (mismo shell que dispara
// process-queue): el shell NO calcula horarios (la imagen alpine no trae
// tzdata) — es esta RUTA la que decide si de verdad toca leer, llamando a
// `getBcvRate` con `ignoreFailureBackoff: true` para que un fallo reciente del
// BCV no la frene (reintentar cada minuto no bloquea a ningún agente, a
// diferencia del request de la bandeja que sí respeta esa ventana). Si no
// toca leer según `shouldRefetchBcv` (bcv-schedule.ts), `getBcvRate` devuelve
// la fila guardada sin salir a la red: esta llamada es, en ese caso, solo una
// lectura de la base. Las páginas siguen llamando a `getBcvRate` como
// respaldo — este cron no es la única vía, es la que evita depender de que
// alguien abra la bandeja justo después de que cambie la tasa.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

/**
 * Comparación en tiempo constante: un `===` filtra el secreto carácter a
 * carácter por el tiempo de respuesta. Copiado de
 * `api/cron/process-queue/route.ts` — moverlo a un módulo compartido queda
 * fuera de esta tarea (T3 del plan solo toca estos tres archivos).
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;

  // Sin secreto no se abre: fallar cerrado siempre, también fuera de producción.
  if (!secret) {
    console.error("BCV: falta CRON_SECRET, no se relee la tasa.");
    return NextResponse.json({ error: "Endpoint mal configurado." }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!provided || !tokenMatches(provided, secret)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const { rate, rateDate, isStale, refreshed } = await getBcvRate(supabase, { ignoreFailureBackoff: true });
    return NextResponse.json({ rate, rateDate, isStale, refreshed });
  } catch (err) {
    // getBcvRate solo lanza cuando la lectura en vivo falló Y no hay ninguna
    // tasa guardada de la que salir: no hay nada que devolver.
    log.error("bcv_refresh_fallido", { detail: errorText(err) });
    return NextResponse.json({ error: "No se pudo leer la tasa BCV." }, { status: 503 });
  }
}
