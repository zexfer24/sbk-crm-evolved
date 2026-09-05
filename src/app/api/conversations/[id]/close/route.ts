import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchCurrentAgent } from "@/lib/data";
import { recordHandoff } from "@/lib/ai/handoffs";
import { log } from "@/lib/log";

// ---------------------------------------------------------------------------
// Cerrar una conversación a mano (T2.1, 5/9/2026).
//
// `record_handoff()` sólo está concedida a `service_role`
// (20260830040000_conversation_handoffs.sql): el navegador no puede llamarla
// con su sesión `authenticated`, así que esta ruta comprueba la sesión con el
// cliente normal (mismo patrón que `api/messages/send`) y solo abre un
// cliente admin para esa única RPC. El UPDATE de `status` y el evento de
// sistema sí corren con la sesión del asesor: la RLS de `conversations` y
// `messages` ya deja escribir a cualquier `authenticated` (ver el resto de
// mutations.ts, que hace exactamente esto desde el navegador).
// ---------------------------------------------------------------------------
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: conversationId } = await context.params;

  const supabase = await createClient();
  const agent = await fetchCurrentAgent(supabase);
  if (!agent) {
    return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  }

  const { error: updateError } = await supabase
    .from("conversations")
    .update({ status: "closed" })
    .eq("id", conversationId);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const { error: eventError } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    direction: "outbound",
    sender_type: "system",
    sender_agent_id: agent.id,
    message_type: "system_event",
    content: `${agent.displayName} cerró la conversación`,
  });
  if (eventError) {
    log.error("cerrar_conversacion_evento_fallido", { conversationId, detalle: eventError.message });
  }

  // Nunca lanza, y su resultado no cambia la respuesta: la regla es la misma
  // que en handoffs.ts — registrar el traspaso no puede tumbar la acción que
  // el asesor sí pidió.
  await recordHandoff(createAdminClient(), {
    conversationId,
    toKind: "closed",
    reason: "cerrada_por_asesor",
    createdBy: "user",
    fromId: agent.id,
  });

  return NextResponse.json({ ok: true });
}
