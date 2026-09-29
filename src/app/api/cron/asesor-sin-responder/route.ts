import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { procesarDemoras, MAX_ACCIONES_POR_PASADA } from "@/lib/ai/demora-cron";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// "Nadie sin atender" (T10b-4, Entrega B del plan "Seba encuentra y el mostrador
// no deja esperando", 29/9/2026): la pasada por minuto que mira las
// conversaciones cuyo cliente lleva esperando a una persona. A los 10 min Seba
// responde una vez por episodio; a los 15 min de horario el caso pasa a otro
// asesor; con dos reasignaciones gastadas se avisa a los supervisores. La lógica
// vive en `src/lib/ai/demora-cron.ts` (y la decisión pura en `demora.ts`); esta
// ruta es solo el portón.
//
// La llama el servicio `cron` del compose cada minuto, igual que `process-queue`.
// Cada llamada autorizada puede gastar IA (la respuesta de Seba) o mover una
// conversación, así que se falla cerrado sin `CRON_SECRET` (503) y con un
// secreto que no calza (401), también fuera de producción. Con la demora
// apagada en Control IA (`agent_settings.demora_activa`, nace en false) la pasada
// responde `activa: false` sin leer ni escribir nada: el cron puede quedar
// agendado desde el día del deploy sin efecto.
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

  // Sin secreto no se abre: este endpoint puede disparar respuestas de IA.
  if (!secret) {
    console.error("Demora del asesor: falta CRON_SECRET, no se procesa nada.");
    return NextResponse.json({ error: "Endpoint mal configurado." }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!provided || !tokenMatches(provided, secret)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const resumen = await procesarDemoras(supabase, { now: new Date(), max: MAX_ACCIONES_POR_PASADA });
    return NextResponse.json({ ok: true, ...resumen });
  } catch (err) {
    // `procesarDemoras` no lanza, pero `createAdminClient()` sí si falta una
    // variable de entorno. El cuerpo no lleva el detalle: va al log.
    log.error("demora_cron_fallido", { detail: errorText(err) });
    return NextResponse.json({ ok: false, error: "No se pudo procesar la demora." }, { status: 500 });
  }
}
