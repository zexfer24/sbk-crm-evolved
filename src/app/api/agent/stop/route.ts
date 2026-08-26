import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchCurrentAgent } from "@/lib/data";
import { stopAgentQueue } from "@/lib/ai/queue";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// El freno de emergencia.
//
// Apagar la IA escribía `ai_globally_enabled = false` y se acababa ahí. Eso
// dejaba tres cosas vivas, y el dueño las vio las tres el 26 de agosto de
// 2026 cuando apagó y los mensajes siguieron saliendo:
//
//   1. Los turnos en vuelo. El interruptor se miraba una vez, al abrir el
//      turno, y después venían el reconocimiento de escenario, la
//      clasificación, hasta cinco pasos de tool loop y el envío. Apagar no
//      cancelaba nada de eso. Lo cierra la comprobación que ahora hay justo
//      antes de cada envío (ver stillEnabled en agent.ts).
//
//   2. La cola. Se quedaba llena. Los turnos se reclamaban uno a uno y salían
//      por la puerta de atrás de runAgentTurn sin dejar rastro — y si alguien
//      volvía a encender antes de que se drenara, la tanda vieja salía de
//      golpe. Lo cierra la purga de acá.
//
//   3. El webhook, que seguía encolando en cada mensaje entrante aunque la IA
//      estuviera apagada. Lo cierra la comprobación del propio webhook.
//
// Esta ruta es la número 2, y es la única de las tres que necesita un
// endpoint: la purga es en Redis, y el interruptor lo pulsa un componente de
// navegador que no puede tocarlo.
//
// Es idempotente: pulsarlo dos veces apaga algo que ya estaba apagado y purga
// una cola que ya estaba vacía. Un botón de pánico tiene que poder pulsarse
// dos veces sin pensarlo.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createClient();

  const agent = await fetchCurrentAgent(supabase);
  if (!agent) {
    return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  }

  // El mismo permiso que hace falta para encenderla (RLS sobre agent_settings).
  if (agent.role !== "supervisor" && agent.role !== "admin") {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 });
  }

  // El interruptor PRIMERO y la purga después, nunca al revés. Entre las dos
  // operaciones hay un instante, y en ese instante lo que importa es que no
  // entre nada nuevo: purgar primero dejaría una cola vacía que el webhook
  // vuelve a llenar antes de que el interruptor esté abajo.
  const { error } = await supabase
    .from("agent_settings")
    .update({ ai_globally_enabled: false, updated_by: agent.id, updated_at: new Date().toISOString() })
    .eq("id", true);

  if (error) {
    log.error("apagado_interruptor_fallido", { agentId: agent.id, detail: error.message });
    return NextResponse.json({ error: "No se pudo apagar la IA." }, { status: 500 });
  }

  // A partir de acá la IA ya no atiende nada nuevo aunque la purga falle, así
  // que un fallo de Redis no se convierte en un 500: se avisa y se sigue. Lo
  // peor de un botón de pánico es que diga que no funcionó cuando la parte
  // que importa sí funcionó.
  let discarded = 0;
  try {
    ({ discarded } = await stopAgentQueue());
  } catch (err) {
    log.error("apagado_purga_fallida", { agentId: agent.id, detail: errorText(err) });
    return NextResponse.json({
      ok: true,
      discarded: null,
      warning: "La IA quedó apagada, pero no se pudo vaciar la cola de turnos pendientes.",
    });
  }

  // La línea que hay que buscar para saber quién apagó y cuánto se descartó.
  log.warn("ia_apagada", { agentId: agent.id, descartados: discarded });

  return NextResponse.json({ ok: true, discarded });
}
