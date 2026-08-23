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
// No expone nada que sirva a un tercero: ni versiones, ni credenciales, ni
// nombres de host.
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
  const [database, queue, config] = [await checkDatabase(), await checkQueue(), checkConfig()];
  const healthy = database.ok && queue.ok && config.ok;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: {
        database: database.ok ? "ok" : `fallo: ${database.detail}`,
        queue: queue.ok ? "ok" : `fallo: ${queue.detail}`,
        config: config.ok ? "ok" : `faltan variables: ${config.missing.join(", ")}`,
      },
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
