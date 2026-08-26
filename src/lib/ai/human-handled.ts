import type { SupabaseClient } from "@supabase/supabase-js";

// Sin `server-only`, a diferencia del resto de src/lib/ai. No es un descuido:
// esto lo usa src/lib/data.ts, del que los componentes de cliente importan
// tipos y ayudantes, y marcarlo rompe el build entero. Es el mismo motivo por
// el que data.ts tampoco lo lleva. No hay nada que proteger acá: son dos
// consultas que no leen secretos y que trabajan con el cliente que se les
// pasa, así que desde el navegador quedarían bajo RLS como cualquier otra.

// ---------------------------------------------------------------------------
// ¿Este chat lo está trabajando una persona?
//
// El 26 de agosto de 2026 la IA le escribió a 22 clientes que ya estaban
// hablando con un asesor. Ninguna de las guardas falló: todas dijeron que sí
// se podía. El problema era qué preguntaban.
//
//   assigned_agent_id is null   Los asesores de SBK contestan sin asignarse
//                               la conversación. Nada en el CRM se lo pide y
//                               el trabajo les sale igual. Nulo no significa
//                               "libre", significa "nadie pulsó un botón que
//                               nadie sabe que existe".
//
//   awaiting_reply              "El último mensaje del hilo es del cliente".
//                               El asesor escribe, el cliente contesta "Ok",
//                               y la columna se pone en true. Es exactamente
//                               una conversación en curso, no una sin
//                               atender.
//
//   ai_enabled                  Solo se apaga al escalar. Un asesor que
//                               responde a mano no escala nada, así que
//                               sigue en true para siempre.
//
// Las tres se cumplen a la vez en un chat que una persona está atendiendo en
// ese momento. No hay combinación de esas tres que lo detecte.
//
// La señal que sí lo detecta ya estaba en la base: si en `messages` hay una
// fila con sender_type = 'agent', un humano escribió acá. Es binaria, no
// depende de que nadie recuerde asignarse nada, y en el incidente habría
// dejado fuera los 22 casos de 22 — no 21, los 22.
//
// Que sea limpia depende de un detalle que conviene no romper: 'agent' lo
// escribe UN SOLO sitio, /api/messages/send, que es un asesor tecleando en el
// CRM. La bienvenida se guarda como 'ai' y los avisos de escalado como
// 'system'. Si algún día algo automático empieza a escribir 'agent', esta
// guarda deja de distinguir y hay que darle otra columna.
//
// Las notas internas cuentan: son sender_type 'agent' y significan que
// alguien está trabajando el caso aunque todavía no le haya escrito al
// cliente. Ante la duda, la IA se queda afuera.
// ---------------------------------------------------------------------------

/**
 * true si algún asesor escribió alguna vez en esta conversación.
 *
 * No lleva ventana de tiempo a propósito. Un filtro de 24 h habría dejado
 * pasar uno de los 22 casos, y ese uno es un cliente real recibiendo
 * "gracias por tu compra" en medio de un reclamo. El chat que una persona
 * tocó es de esa persona hasta que alguien decida lo contrario.
 */
export async function humanHasWritten(supabase: SupabaseClient, conversationId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("sender_type", "agent")
    .limit(1);

  // Se falla CERRADO: si no se puede comprobar, la IA no entra. Al revés
  // —seguir ante un error de red— es volver al comportamiento que causó el
  // incidente, y el costo de los dos lados no se parece: no contestar deja a
  // un cliente esperando un rato más; contestar encima de un asesor le
  // escribe a alguien que está a mitad de una venta.
  if (error) throw new Error(`No se pudo comprobar si ${conversationId} la atiende una persona: ${error.message}`);

  return (data ?? []).length > 0;
}

/**
 * De un lote de conversaciones, cuáles tienen mensajes de un asesor.
 *
 * Una sola consulta para todo el lote: el barrido mira ciento y pico de
 * conversaciones y preguntar una por una serían ciento y pico de viajes.
 */
export async function conversationsWrittenByHumans(
  supabase: SupabaseClient,
  conversationIds: string[]
): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();

  const { data, error } = await supabase
    .from("messages")
    .select("conversation_id")
    .in("conversation_id", conversationIds)
    .eq("sender_type", "agent");

  if (error) throw new Error(`No se pudo comprobar qué chats atiende una persona: ${error.message}`);

  return new Set(((data ?? []) as { conversation_id: string }[]).map((row) => row.conversation_id));
}
