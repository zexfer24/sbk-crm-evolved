import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchBacklogConversationIds, fetchCurrentAgent } from "@/lib/data";
import { enqueueAgentTurns, pendingAgentTurns } from "@/lib/ai/queue";
import { acquireSweepLock } from "@/lib/ai/redis-queue";
import { getRedis } from "@/lib/redis";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Repaso del atraso al encender la IA.
//
// Encender el interruptor global no tocaba nada de lo que ya estaba
// esperando: los turnos solo se encolan desde el webhook, o sea cuando entra
// un mensaje nuevo. Esto encola de una vez las conversaciones sin contestar
// que la IA tiene permitido atender, para que el atraso deje de crecer en
// paralelo a la IA funcionando.
//
// El drenado NO se hace acá. La cola la vacía el cron de process-queue, diez
// turnos cada cinco minutos, y esa lentitud es a propósito: runAgentTurn
// vuelve a preguntar `agent_can_run` en CADA turno, así que apagar el
// interruptor a mitad de tanda mata lo que quede sin gastar una sola llamada
// al modelo. Drenando a toda velocidad —el sistema da ~1,4 chats por
// segundo— la tanda entera saldría antes de que nadie alcance a leer la
// primera respuesta, y entonces el freno de emergencia no frenaría nada.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

/**
 * Un segundo entre conversación y conversación. No frena nada —el ritmo lo
 * pone el tope por pasada del cron—; fija el orden, que sin esto lo decidiría
 * el orden alfabético de los ids. Ver EnqueueOptions.spacingSeconds.
 */
const SPACING_SECONDS = 1;

/**
 * Cuánto vale el lock del barrido.
 *
 * El 26 de agosto de 2026 el barrido se disparó dos veces con dos minutos y
 * medio de diferencia —139 conversaciones y después 129— porque el botón no
 * tiene memoria de que ya se pulsó. Con la tanda a medio drenar, el segundo
 * pulso re-encoló todo lo que no había salido.
 *
 * Media hora es lo que tarda una tanda normal en drenar al ritmo del cron. Si
 * alguien necesita relanzar antes, el mensaje de error le dice cuántos turnos
 * quedan pendientes, que es el dato con el que se decide.
 */
const SWEEP_LOCK_SECONDS = 1800;

export async function POST() {
  const supabase = await createClient();

  const agent = await fetchCurrentAgent(supabase);
  if (!agent) {
    return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  }

  // El mismo permiso que hace falta para encender la IA (RLS sobre
  // agent_settings). Esto le escribe a clientes reales sin revisión previa:
  // no puede quedar al alcance de un asesor que entre por la URL.
  if (agent.role !== "supervisor" && agent.role !== "admin") {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 });
  }

  // agent_can_run junta el interruptor global y el tope de gasto del día. Si
  // dice que no, encolar sería llenar la cola de turnos que van a salir por
  // la puerta de atrás de runAgentTurn uno por uno.
  const { data: canRun } = await supabase.rpc("agent_can_run");
  if (!canRun) {
    log.warn("atraso_no_encolado", { agentId: agent.id, motivo: "agent_can_run devolvió false" });
    return NextResponse.json({ ok: true, enqueued: 0, reason: "La IA no está habilitada." });
  }

  // Una tanda a la vez. Va ANTES de consultar el atraso: si ya hay una en
  // curso, ni siquiera hace falta preguntar qué habría que encolar.
  const redis = getRedis();
  if (!(await acquireSweepLock(redis, SWEEP_LOCK_SECONDS))) {
    const pendientes = await pendingAgentTurns();
    log.warn("atraso_ya_en_curso", { agentId: agent.id, pendientes });
    return NextResponse.json(
      {
        error: `Ya hay un repaso del atraso en curso, con ${pendientes} turnos todavía en cola. Espera a que termine antes de lanzar otro.`,
        pending: pendientes,
      },
      { status: 409 }
    );
  }

  let conversationIds: string[];
  try {
    conversationIds = await fetchBacklogConversationIds(supabase);
  } catch (err) {
    log.error("atraso_consulta_fallida", { agentId: agent.id, detail: errorText(err) });
    return NextResponse.json({ error: "No se pudo leer el atraso." }, { status: 500 });
  }

  await enqueueAgentTurns(conversationIds, { debounceSeconds: 0, spacingSeconds: SPACING_SECONDS });

  // La línea que hay que buscar en el log para saber qué se disparó y quién
  // lo disparó. Encolar dos veces no duplica nada —la cola guarda una entrada
  // por conversación—, así que este número puede repetirse y no significa
  // que alguien haya recibido dos mensajes.
  log.info("atraso_encolado", { agentId: agent.id, encoladas: conversationIds.length });

  return NextResponse.json({ ok: true, enqueued: conversationIds.length });
}
