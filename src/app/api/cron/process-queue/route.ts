import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { processQueuedTurns } from "@/lib/ai/queue";

// ---------------------------------------------------------------------------
// Red de seguridad de la cola de turnos.
//
// El camino normal es que el propio webhook procese lo que encola. Esto
// existe para lo que ese camino no cubre: el proceso que murió a mitad de un
// turno, o el turno que falló y quedó esperando otro intento.
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

  const result = await processQueuedTurns();
  return NextResponse.json({ ok: true, ...result });
}
