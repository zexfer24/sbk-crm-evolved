import type { SupabaseClient } from "@supabase/supabase-js";

// Sin `server-only`, a diferencia del resto de src/lib/ai. No es un descuido:
// esto lo usa src/lib/data.ts, del que los componentes de cliente importan
// tipos y ayudantes, y marcarlo rompe el build entero. Es el mismo motivo por
// el que data.ts tampoco lo lleva. No hay nada que proteger acá: son dos
// consultas que no leen secretos y que trabajan con el cliente que se les
// pasa, así que desde el navegador quedarían bajo RLS como cualquier otra.
// Por lo mismo `humanGraceMinutes()` lee `process.env.AI_HUMAN_GRACE_MINUTES`
// sabiendo que en el navegador esa variable no existe: cae al default (30),
// que es el comportamiento correcto ahí también.

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
//
// ---------------------------------------------------------------------------
// 7-8 de septiembre de 2026: la guarda de arriba preguntaba "¿ALGUNA VEZ
// escribió un asesor?" — sin ventana de tiempo, a propósito (ver el docblock
// viejo de `humanHasWritten`, reemplazado por este). Medido en producción el
// 8/9: de 48 conversaciones esperando respuesta con la IA encendida y sin
// asesor asignado, 47 tenían un humano que había escrito ALGUNA VEZ. La IA
// quedaba muda en casi todo el atraso.
//
// Caso real: `3b654d2c-3cf8-4eef-8638-bc75e45cb10a` (+584225157846). Un
// supervisor escribió un "a" —una sola letra, casi seguro sin querer— el
// 28/8/2026. El último mensaje de un humano en ese chat fue el 6/9 18:40 UTC;
// el cliente escribió el 7/9 12:54 UTC preguntando algo nuevo. La guarda vieja
// seguía diciendo "sí, un humano escribió acá" y la IA se quedaba callada
// aunque "Reactivar respuestas automáticas" ya había puesto `ai_enabled =
// true` — esa mutación no toca `messages`, así que la guarda ni se enteraba.
//
// El error no estaba en la implementación: la pregunta tenía el alcance
// temporal equivocado. "¿Alguna vez?" es la pregunta correcta para decidir si
// ALGUIEN tocó el caso; la pregunta que hace falta acá es "¿lo está tocando
// AHORA?". Por eso la regla nueva tiene dos cláusulas, y cada una protege algo
// distinto:
//
//   created_at > lastCustomerMessageAt   El asesor se adelantó a lo que la IA
//                                        iba a contestar: ya le respondió (o
//                                        dejó una nota) DESPUÉS de lo último
//                                        que dijo el cliente. No hay nada que
//                                        la IA tenga que agregar todavía.
//
//   created_at > now − G minutos         El asesor está conversando AHORA
//                                        MISMO, aunque su último mensaje sea
//                                        anterior al del cliente. Sin esta
//                                        cláusula: el asesor contesta, el
//                                        cliente responde a los dos minutos,
//                                        y la IA se mete a mitad de una venta
//                                        que el asesor está cerrando — es
//                                        exactamente el incidente del 26/8,
//                                        solo que con el reloj corriendo en
//                                        vez de parado.
//
// `lastCustomerMessageAt` null (lead sin mensajes del cliente) da `false` sin
// ni siquiera consultar `messages`: no hay nada que contestar, y el turno de
// todas formas termina saliendo por `fuera_de_ventana` (`withinFreeformWindow`
// en agent.ts exige esa fecha).
//
// G —la gracia, en minutos— se lee de `AI_HUMAN_GRACE_MINUTES` con default
// 30, fijado por el operador el 8/9/2026 sobre la medición del día: libera 44
// de las 48 mudas (39 con G=60). Vive en el entorno y no en código para poder
// subirla sin redeploy si el filtro resulta corto en producción (ver el
// evento `turno_persona_se_adelanto`).
//
// Por qué la parte "después de lcma" ya casi no la necesitan el reconciliador
// ni el atraso (`fetchBacklogConversationIds`/`fetchBacklogCounts` en
// data.ts): las dos filtran por `awaiting_reply = true`, y esa columna
// generada ya es `last_reply_at <= last_customer_message_at` — una respuesta
// de asesor mueve `last_reply_at`, así que un humano que respondió DESPUÉS
// del cliente casi siempre apaga `awaiting_reply` antes de que este filtro
// tenga que mirarlo. Ahí la cláusula que de verdad decide es la gracia. La
// cláusula de `lcma` sigue haciendo falta completa en `deliver()`
// (`humanWroteMeanwhile`, agent.ts) y al abrir el turno
// (`runAgentTurn`): ahí no se filtra por `awaiting_reply` fresco — el turno
// ya está corriendo con el estado que tenía al empezar — y una nota interna
// no mueve `last_reply_at` en ningún caso, en ningún consumidor.
//
// Verificación contra el incidente del 26/8 (los cinco casos de
// human-handled.test.ts): la regla nueva los sigue bloqueando a los cinco,
// pero por la cláusula de la gracia, no por "alguna vez" — en los cinco el
// asesor escribió antes del último mensaje del cliente pero a minutos de
// diferencia (una conversación en curso), así que `now − G` los sigue
// atrapando con G=30. Una ventana de 24 h sobre "alguna vez" (lo que se
// consideró en agosto y se descartó) habría dejado pasar 1 de los 22 casos
// reales de ese incidente; la regla de acá, con G=30, no deja pasar ninguno
// de los cinco reconstruidos en el test porque ninguno cruza los 30 minutos.
// ---------------------------------------------------------------------------
// H2, plan "Seba atiende el mostrador" (18/9/2026): la gracia también
// atrapaba una conversación que ya había arrancado de cero.
//
// Escenario a mano, base local: un asesor escribió en un chat escalado, el
// chat se CERRÓ, y el cliente volvió a escribir a los pocos segundos. El
// webhook (`route.ts`, ~l.1096) reabre bien — `status=open`, `ai_enabled=
// true`, `assigned_agent_id=null`, `welcome_sent_at=null` — y dejar una fila
// `conversation_handoffs` con `reason: "reabierta_por_cliente"`. Pero el
// turno salía igual por `humano_intervino`: la cláusula de gracia de arriba
// vio el mensaje VIEJO del asesor (de antes del cierre) a minutos de
// distancia de `now` y bloqueó a Seba, que se quedó sin saludar hasta que
// pasaran los G minutos — sobre un chat que la reapertura ya había dejado
// sin asesor.
//
// Decisión del operador (D2): "la reapertura salta la gracia". Un chat
// reabierto arranca de cero, así que la cláusula de gracia SOLO cuenta
// mensajes de asesor POSTERIORES a la última reapertura por el cliente — un
// mensaje de antes de esa fila es de la conversación vieja, no de "alguien
// conversando ahora mismo". La cláusula de "se adelantó" (`humanTime >
// lastCustomerMessageAt`) NO cambia: si el asesor escribió después del
// último mensaje del cliente, sigue bloqueando igual, reapertura o no — y
// por construcción (`route.ts`: el UPDATE de reapertura corre ANTES del
// insert del mensaje entrante) un mensaje de asesor anterior a una
// reapertura nunca puede ser posterior al `last_customer_message_at` que
// esa misma reapertura originó, así que las dos cláusulas no compiten.
//
// El instante de "reapertura" es el `created_at` de la fila más reciente de
// `conversation_handoffs` con `reason = 'reabierta_por_cliente'` de esa
// conversación — no hay una columna `reopened_at` en `conversations` (se
// verificó contra la migración y `database.types.ts` antes de escribir esto;
// no crear una a propósito, la bitácora ya la tiene).
//
// La consulta nueva SOLO corre cuando la cláusula de gracia iba a disparar
// de todas formas (el asesor escribió antes del cliente pero dentro de los G
// minutos): si "se adelantó" ya bloqueó, o si el mensaje del asesor es
// demasiado viejo para la gracia, preguntar por una reapertura no cambia
// nada y no vale el viaje a la base — el turno abre decenas de conversación
// por minuto y esta guarda corre en cada una.
//
// Por qué esto NO importa `@/lib/log`: este archivo no lleva
// `import "server-only"` a propósito (ver el bloque de arriba del todo) —
// `src/lib/data.ts` importa `conversationsWrittenByHumans` de acá y
// componentes de cliente importan de `data.ts`. `lib/log.ts` SÍ es
// server-only; importarlo acá arrastraría ese mundo entero al bundle del
// navegador la primera vez que alguien lo toque, exactamente el error que el
// comentario de arriba de este archivo ya advierte. `data.ts` resuelve el
// mismo problema con `console.error` directo (l.2628); acá se sigue el
// mismo criterio en vez de reabrir la discusión.
// ---------------------------------------------------------------------------

/**
 * Minutos de gracia: cuánto tiempo después de escribir sigue "conversando
 * ahora" un asesor, aunque su mensaje sea anterior al último del cliente.
 *
 * Default 30 (decisión del operador, 8/9/2026). Cualquier valor que no sea un
 * número finito mayor que cero —ausente, vacío, texto, cero, negativo— cae al
 * default: una gracia de 0 o negativa equivaldría a apagar la cláusula sin
 * que nadie lo haya decidido explícitamente, y eso es exactamente el tipo de
 * fallo silencioso que esta corrida existe para cerrar.
 */
export function humanGraceMinutes(): number {
  const raw = process.env.AI_HUMAN_GRACE_MINUTES;
  if (!raw) return 30;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return parsed;
}

export interface HumanGuardOptions {
  /** Instante de "ahora", en ms epoch. Default `Date.now()`; fijo en los tests. */
  now?: number;
  /** Minutos de gracia. Default `humanGraceMinutes()`; inyectable en los tests. */
  graceMinutes?: number;
}

/**
 * La regla, pura: ¿un asesor reclama este chat?
 *
 * Compartida por `humanHasWritten` y `conversationsWrittenByHumans` para que
 * las dos decidan exactamente lo mismo — una consulta por chat y una consulta
 * de lote solo deberían diferir en cuántos viajes hacen a la base, nunca en el
 * criterio.
 *
 * `reopenedAt` (H2, 18/9/2026): el `created_at` de la última reapertura por
 * el cliente de esta conversación, o `null` si nunca se reabrió. Solo afecta
 * a la cláusula de gracia — un mensaje de asesor de ANTES de esa reapertura
 * es de la conversación vieja y no cuenta como "conversando ahora mismo". La
 * cláusula de "se adelantó" mira `lastHumanAt` tal cual, sin filtrar por
 * reapertura: ver el docblock de arriba para por qué las dos no compiten.
 */
export function humanClaimsChat(
  lastHumanAt: string | null,
  lastCustomerMessageAt: string | null,
  now: number,
  graceMinutes: number,
  reopenedAt: string | null = null
): boolean {
  // Lead sin mensajes del cliente: nada que contestar. El turno de todas
  // formas sale por `fuera_de_ventana` (withinFreeformWindow exige esta
  // fecha), así que decir `false` acá no arriesga que la IA le escriba a
  // nadie por error.
  if (lastCustomerMessageAt === null) return false;
  if (lastHumanAt === null) return false;

  const humanTime = Date.parse(lastHumanAt);

  // Se adelantó a lo que la IA iba a contestar.
  if (humanTime > Date.parse(lastCustomerMessageAt)) return true;

  // El chat reabierto arranca de cero (D2): un mensaje de antes de la
  // reapertura no cuenta para "está conversando ahora mismo".
  if (reopenedAt !== null && humanTime <= Date.parse(reopenedAt)) return false;

  // Está conversando ahora, aunque su mensaje sea anterior al del cliente.
  if (humanTime > now - graceMinutes * 60_000) return true;

  return false;
}

/**
 * Trae el instante de la última reapertura por el cliente, pero SOLO cuando
 * hace falta (H2, 18/9/2026): si la cláusula de "se adelantó" ya decidió, o
 * si el mensaje del asesor es demasiado viejo para que la gracia dispare de
 * todas formas, el resultado de esta consulta no puede cambiar nada — y el
 * turno abre esta guarda en cada conversación, así que un viaje de más acá
 * es un viaje de más siempre.
 *
 * Falla CERRADO: ante un error de esta consulta devuelve `null` (equivale a
 * "no hay reapertura que descuente al asesor"), así que `humanClaimsChat`
 * sigue su camino normal y la gracia bloquea igual — la duda se trata como
 * "el humano escribió", nunca al revés (mismo criterio que el resto del
 * archivo). Se deja un `console.error` (no `@/lib/log`: ver el porqué en el
 * docblock de arriba) para que quede rastro del corte de base.
 */
async function reopenedAtIfGraceWouldFire(
  supabase: SupabaseClient,
  conversationId: string,
  lastHumanAt: string | null,
  lastCustomerMessageAt: string,
  now: number,
  graceMinutes: number
): Promise<string | null> {
  if (lastHumanAt === null) return null;

  const humanTime = Date.parse(lastHumanAt);
  const seAdelanto = humanTime > Date.parse(lastCustomerMessageAt);
  const graciaDispararia = !seAdelanto && humanTime > now - graceMinutes * 60_000;
  if (!graciaDispararia) return null;

  const { data, error } = await supabase
    .from("conversation_handoffs")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("reason", "reabierta_por_cliente")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error(
      `No se pudo comprobar si ${conversationId} se reabrió recientemente (se trata como si no):`,
      error
    );
    return null;
  }

  return ((data ?? [])[0] as { created_at: string } | undefined)?.created_at ?? null;
}

/**
 * true si un asesor reclama esta conversación AHORA, según la regla de
 * arriba.
 *
 * `lastCustomerMessageAt` null se resuelve sin consultar `messages`: no hay
 * nada que decidir. Falla CERRADO como siempre: si no se puede comprobar, la
 * IA no entra. Al revés —seguir ante un error de red— es volver al
 * comportamiento que causó el incidente del 26/8, y el costo de los dos lados
 * no se parece: no contestar deja a un cliente esperando un rato más;
 * contestar encima de un asesor le escribe a alguien que está a mitad de una
 * venta.
 */
export async function humanHasWritten(
  supabase: SupabaseClient,
  conversationId: string,
  lastCustomerMessageAt: string | null,
  options: HumanGuardOptions = {}
): Promise<boolean> {
  if (lastCustomerMessageAt === null) return false;

  const { data, error } = await supabase
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("sender_type", "agent")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(`No se pudo comprobar si ${conversationId} la atiende una persona: ${error.message}`);

  const lastHumanAt = ((data ?? [])[0] as { created_at: string } | undefined)?.created_at ?? null;
  const now = options.now ?? Date.now();
  const graceMinutes = options.graceMinutes ?? humanGraceMinutes();

  const reopenedAt = await reopenedAtIfGraceWouldFire(
    supabase,
    conversationId,
    lastHumanAt,
    lastCustomerMessageAt,
    now,
    graceMinutes
  );

  return humanClaimsChat(lastHumanAt, lastCustomerMessageAt, now, graceMinutes, reopenedAt);
}

/**
 * De un lote de conversaciones, cuáles reclama un asesor AHORA.
 *
 * Una sola consulta para todo el lote: el barrido mira ciento y pico de
 * conversaciones y preguntar una por una serían ciento y pico de viajes.
 *
 * Filas con `lastCustomerMessageAt` null se descartan de entrada — no
 * consultan `messages` ni pueden bloquear nada, igual que en `humanHasWritten`.
 *
 * El `gt` de la consulta usa un umbral, no la fecha exacta de cada fila: pedir
 * "algún mensaje de asesor posterior a `now − G`, o posterior al `lcma` de ESA
 * fila" no se puede expresar en un solo filtro sin una condición por fila.
 * `umbral = min(now − G, min(lcma de todas las filas))` es una cota que NO
 * pierde ninguna fila relevante —cualquier mensaje humano que pueda reclamar
 * algún chat del lote es, por definición de la regla, posterior a esa cota— a
 * cambio de traer alguna fila de más que la decisión en memoria descarta. La
 * decisión exacta, por conversación, la hace `humanClaimsChat` sobre el
 * `created_at` más reciente de cada una.
 *
 * H2 (18/9/2026): mismo criterio de reapertura que `humanHasWritten`, para
 * que el reconciliador (`reconciler.ts`) y el atraso (`data.ts`,
 * `fetchBacklogConversationIds`/`fetchBacklogCounts`) no se contradigan con
 * el turno sobre el mismo chat — una sola consulta de LOTE, contra
 * `conversation_handoffs`, solo para las conversaciones donde la gracia
 * dispararía; el resto ni entra en el `.in(...)`.
 */
export async function conversationsWrittenByHumans(
  supabase: SupabaseClient,
  rows: { id: string; lastCustomerMessageAt: string | null }[],
  options: HumanGuardOptions = {}
): Promise<Set<string>> {
  const conRespuestaPendiente = rows.filter((r) => r.lastCustomerMessageAt !== null) as {
    id: string;
    lastCustomerMessageAt: string;
  }[];
  if (conRespuestaPendiente.length === 0) return new Set();

  const now = options.now ?? Date.now();
  const graceMinutes = options.graceMinutes ?? humanGraceMinutes();

  const graceCutoff = now - graceMinutes * 60_000;
  const minLcma = Math.min(...conRespuestaPendiente.map((r) => Date.parse(r.lastCustomerMessageAt)));
  const umbral = new Date(Math.min(graceCutoff, minLcma)).toISOString();

  const { data, error } = await supabase
    .from("messages")
    .select("conversation_id, created_at")
    .in(
      "conversation_id",
      conRespuestaPendiente.map((r) => r.id)
    )
    .eq("sender_type", "agent")
    .gt("created_at", umbral);

  if (error) throw new Error(`No se pudo comprobar qué chats atiende una persona: ${error.message}`);

  const ultimoHumanoPorChat = new Map<string, string>();
  for (const fila of (data ?? []) as { conversation_id: string; created_at: string }[]) {
    const previo = ultimoHumanoPorChat.get(fila.conversation_id);
    if (!previo || fila.created_at > previo) ultimoHumanoPorChat.set(fila.conversation_id, fila.created_at);
  }

  // De las que tienen un asesor reciente, cuáles harían disparar la gracia
  // (no las "se adelantó", esas ya bloquean sin mirar reaperturas). Solo esas
  // necesitan saber si hubo una reapertura después del mensaje del asesor.
  const idsConGraciaPosible = conRespuestaPendiente
    .filter((fila) => {
      const lastHumanAt = ultimoHumanoPorChat.get(fila.id);
      if (!lastHumanAt) return false;
      const humanTime = Date.parse(lastHumanAt);
      const seAdelanto = humanTime > Date.parse(fila.lastCustomerMessageAt);
      return !seAdelanto && humanTime > graceCutoff;
    })
    .map((fila) => fila.id);

  const reopenedAtPorChat = new Map<string, string>();
  if (idsConGraciaPosible.length > 0) {
    const { data: reaperturas, error: reaperturaError } = await supabase
      .from("conversation_handoffs")
      .select("conversation_id, created_at")
      .in("conversation_id", idsConGraciaPosible)
      .eq("reason", "reabierta_por_cliente");

    if (reaperturaError) {
      // Falla cerrado, igual que en humanHasWritten: el mapa queda vacío, así
      // que ninguna fila se descuenta y la gracia sigue bloqueando como
      // antes de esta corrida. Sin `@/lib/log` por el mismo motivo del
      // docblock de arriba del archivo.
      console.error("No se pudo comprobar qué chats se reabrieron recientemente (se trata como si ninguno):", reaperturaError);
    } else {
      for (const fila of (reaperturas ?? []) as { conversation_id: string; created_at: string }[]) {
        const previo = reopenedAtPorChat.get(fila.conversation_id);
        if (!previo || fila.created_at > previo) reopenedAtPorChat.set(fila.conversation_id, fila.created_at);
      }
    }
  }

  const resultado = new Set<string>();
  for (const fila of conRespuestaPendiente) {
    const lastHumanAt = ultimoHumanoPorChat.get(fila.id) ?? null;
    const reopenedAt = reopenedAtPorChat.get(fila.id) ?? null;
    if (humanClaimsChat(lastHumanAt, fila.lastCustomerMessageAt, now, graceMinutes, reopenedAt)) resultado.add(fila.id);
  }
  return resultado;
}
