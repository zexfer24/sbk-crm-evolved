import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getRedis } from "@/lib/redis";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// T2, plan "Seba no habla de más mientras el cliente espera al asesor"
// (22-23/9/2026): "borrador cedido".
//
// Caso real (defecto B, 22/9/2026): un cliente escribe en fragmentos —
// "Cuánto cuesta la parrilla de sbr", "El guarda fango trasero con su tapa
// negra", "Y luces traseras de cruce"— y cada fragmento dispara su PROPIO
// turno completo. Si un turno todavía está redactando cuando llega el
// fragmento siguiente, hoy manda su borrador igual, basado en una ráfaga que
// ya quedó incompleta, y encima corre un turno más para el fragmento nuevo:
// dos (o tres) respuestas de Seba donde el cliente esperaba una.
//
// `runTurnPhases` (agent.ts) llama a `shouldCedeDraft` en DOS puntos: justo
// después de fase 0/1 (antes de mandar un escenario o arrancar el tool
// loop) y justo antes de entregar la redacción final (después del tool loop
// y de la guarda de identidad). En los dos, la pregunta es la misma:
// ¿llegó un mensaje del cliente más nuevo que el más nuevo que ESTE turno
// llegó a cargar? Si sí —y el turno todavía no escaló—, el turno se calla:
// no hace falta que conteste nada, porque el turno que ya está en cola para
// la MISMA conversación (el webhook encola cada entrante, T3 lo adelanta en
// cuanto se suelta el lock, ~1 s) va a ver la ráfaga completa y contestar
// todo junto. El costo es que ese fragmento se contesta en el turno
// siguiente en vez de en este — con T3 (`88fe103`) ese turno arranca ~1 s
// después de soltar el lock, así que el atraso es chico comparado con dos
// respuestas peleando por decir la verdad.
//
// Por qué "última línea del historial" no alcanza para decidir esto: el
// turno cargó su historial (`loadHistory`) al ABRIR — un fragmento que llegó
// MIENTRAS redactaba no está ahí. La única forma de verlo es releer
// `conversations.last_customer_message_at` EN EL MOMENTO de decidir, y
// compararlo contra el `hasta` de `latestCustomerMarker(zipped)` — la línea
// de cliente más nueva que ESTE turno cargó, no `convo.last_customer_
// message_at` (que se leyó ANTES de `loadHistory`, en la apertura del
// turno: un mensaje que entró en el hueco entre esa lectura y `loadHistory`
// daría una cesión falsa, porque ya estaría en el historial cargado pero
// `convo.last_customer_message_at` lo vería "más nuevo" igual).
//
// Nunca se cede si el turno YA escaló en este mismo turno (tool loop,
// red de seguridad de catálogo o de devolución/queja): la despedida de la
// escalada tiene que salir sí o sí — un chat recién escalado sin ninguna
// respuesta es peor que uno con una despedida de más.
//
// Sin traspaso al ceder: la invariante "ningún lead invisible" (CLAUDE.md)
// exige dejar rastro en toda salida silenciosa que cambie —o pueda
// confundirse con que cambia— el dueño de la conversación o su hora límite
// de respuesta. Acá no cambia nada de eso: `awaiting_reply` sigue en `true`
// (nadie respondió, es la verdad), el dueño sigue siendo el mismo, y lo que
// el cliente escribió sigue totalmente pendiente — de hecho MÁS pendiente
// que antes, porque no se escribe la marca "visto hasta" (`turn-seen.ts`):
// el turno siguiente, que ya está encolado porque el webhook encola cada
// entrante, va a ver TODO lo que este turno vio más lo nuevo. Si por algún
// motivo ese turno siguiente no estuviera encolado (no debería pasar: cada
// entrante dispara su propio encolado), el reconciliador lo recoge solo,
// porque el último mensaje visible de la conversación sigue siendo del
// cliente.
// ---------------------------------------------------------------------------

/**
 * Tope de cesiones SEGUIDAS antes de mandar el borrador aunque siga
 * llegando más: alguien que no para de escribir (o dos personas compartiendo
 * el mismo número) no puede dejar a Seba muda para siempre. Literal en el
 * código Y en los tests (CLAUDE.md, "El resguardo antes del push",
 * 20/9/2026: "un tope numérico se fija en el test con su literal, nunca con
 * el símbolo que ya está probando") — acá se documenta el porqué del
 * número, no se lo esconde detrás de una constante que un test podría
 * importar sin darse cuenta de que está probando el propio código contra sí
 * mismo.
 */
const CESSION_CAP = 2;

/**
 * TTL del contador de cesiones, en segundos: 120 s. Una ráfaga real de
 * fragmentos ocurre en cuestión de segundos (CLAUDE.md, "La respuesta llega
 * en siete segundos"); dos minutos alcanzan de sobra para cualquier ráfaga
 * legítima sin dejar que el contador seguido de una conversación de hace
 * media hora bloquee una cesión de hoy.
 */
const CESSION_TTL_SECONDS = 120;

function cessionKey(conversationId: string): string {
  return `turno:cedido:${conversationId}`;
}

/** `value` como epoch-ms, o `null` si no es un string parseable — nunca `NaN`. */
function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export type CessionMotivo =
  | "mas_nuevo"
  | "sin_novedad"
  | "ya_escalo"
  | "tope"
  | "lectura_fallida"
  | "redis_no_disponible";

export interface CessionDecisionInputs {
  /**
   * `conversations.last_customer_message_at` releído JUSTO ANTES de decidir
   * — no el que se leyó al abrir el turno.
   */
  lastCustomerMessageAtAhora: string | null;
  /**
   * El `hasta` de `latestCustomerMarker(zipped)`: la línea de cliente más
   * nueva que ESTE turno llegó a cargar (`null` si el historial cargado no
   * trae ninguna línea de cliente con fecha parseable).
   */
  hastaCargado: string | null;
  /**
   * `true` si este turno ya llamó a `escalateConversation` — por el tool
   * loop (`escalarAAsesor`), por la red de seguridad de catálogo, o por la
   * de devolución/queja. Con `true`, la respuesta tiene que salir sí o sí.
   */
  yaEscalo: boolean;
}

export interface CessionDecision {
  cede: boolean;
  motivo: CessionMotivo;
}

/**
 * La decisión PURA: sin Supabase, sin Redis, sin `await`. Aislada de
 * `shouldCedeDraft` (más abajo) para poder mutarla en un test sin fake de
 * base ni de Redis — mismo criterio que llevó a separar `decideCession` de
 * su wrapper impuro (CLAUDE.md, trampa de "El resguardo antes del push":
 * un fake de Supabase puede tragarse el operador o el valor real de un
 * filtro sin que ningún test lo note).
 *
 * "Más nuevo" es estrictamente posterior — un empate (`ahora === cargado`)
 * NO cede: es exactamente lo que este turno ya cargó, no algo nuevo.
 */
export function decideCession(inputs: CessionDecisionInputs): CessionDecision {
  if (inputs.yaEscalo) return { cede: false, motivo: "ya_escalo" };

  const ahora = parseTimestamp(inputs.lastCustomerMessageAtAhora);
  const cargado = parseTimestamp(inputs.hastaCargado);

  // Conservador ante un dato que no parsea (no debería pasar nunca: los dos
  // vienen de `created_at` de Meta, con precisión de segundo) — mismo
  // criterio que `pendingCustomerLines`/`customerBurst` en history-line.ts:
  // mejor no ceder por un dato que falta que dejar un mensaje sin contestar
  // por un `NaN`.
  if (ahora === null || cargado === null) return { cede: false, motivo: "sin_novedad" };

  return ahora > cargado ? { cede: true, motivo: "mas_nuevo" } : { cede: false, motivo: "sin_novedad" };
}

export interface CessionCheck {
  supabase: SupabaseClient<Database>;
  conversationId: string;
  /** Ver `CessionDecisionInputs.hastaCargado`. */
  hastaCargado: string | null;
  /** Ver `CessionDecisionInputs.yaEscalo`. */
  yaEscalo: boolean;
}

/**
 * ¿Corresponde ceder el borrador? Nunca lanza — un fallo leyendo la base o
 * hablando con Redis se trata como "no ceder" (se manda como siempre): un
 * turno que ya redactó algo real no puede quedarse mudo por un corte que no
 * tiene nada que ver con lo que el cliente preguntó.
 *
 * Con `yaEscalo`, ni siquiera toca la base ni Redis: la despedida de la
 * escalada sale sí o sí, así que preguntar es gasto de balde.
 */
export async function shouldCedeDraft(check: CessionCheck): Promise<CessionDecision> {
  if (check.yaEscalo) return { cede: false, motivo: "ya_escalo" };

  const { data, error } = await check.supabase
    .from("conversations")
    .select("last_customer_message_at")
    .eq("id", check.conversationId)
    .maybeSingle();

  if (error) {
    log.warn("turno_cesion_no_consultable", { conversationId: check.conversationId, detail: errorText(error) });
    return { cede: false, motivo: "lectura_fallida" };
  }

  const decision = decideCession({
    lastCustomerMessageAtAhora:
      (data as { last_customer_message_at?: string | null } | null)?.last_customer_message_at ?? null,
    hastaCargado: check.hastaCargado,
    yaEscalo: false,
  });

  if (!decision.cede) return decision;

  // Tope: INCR + EXPIRE, y recién ACÁ —cuando de verdad hay un mensaje más
  // nuevo— se toca Redis. Un turno que de todos modos no iba a ceder no
  // gasta la ida y vuelta.
  const tope = await checkCessionCap(check.conversationId);
  if (tope !== "bajo_el_tope") {
    return { cede: false, motivo: tope };
  }

  return decision;
}

/**
 * `"bajo_el_tope"` si, tras incrementar el contador de cesiones SEGUIDAS de
 * esta conversación, todavía se puede ceder (valor ≤ `CESSION_CAP`); si no,
 * el motivo por el que no se puede: `"tope"` (el contador ya lo alcanzó) o
 * `"redis_no_disponible"` (un fallo de Redis se trata igual — mismo criterio
 * que `turn-seen.ts`: sin Redis, el turno se comporta como si el tope ya se
 * hubiera alcanzado, nunca como si no existiera ningún tope).
 */
async function checkCessionCap(conversationId: string): Promise<"bajo_el_tope" | "tope" | "redis_no_disponible"> {
  try {
    const redis = getRedis();
    const key = cessionKey(conversationId);
    const value = await redis.incr(key);
    await redis.expire(key, CESSION_TTL_SECONDS);
    if (value > CESSION_CAP) {
      log.info("turno_cedido_tope_alcanzado", { conversationId });
      return "tope";
    }
    return "bajo_el_tope";
  } catch (err) {
    log.warn("turno_cesion_redis_no_disponible", { conversationId, detail: errorText(err) });
    return "redis_no_disponible";
  }
}

/**
 * Borra el contador de cesiones seguidas de esta conversación: la próxima
 * ráfaga que llegue empieza a contar desde cero. Nunca lanza: un DEL que no
 * se pudo hacer deja el contador viejo, que en el peor caso vence solo a
 * los 120 s (`CESSION_TTL_SECONDS`).
 *
 * SOLO se llama donde `runTurnPhases` (agent.ts) confirma que ENTREGÓ algo
 * de verdad — un escenario (dentro del `onDelivered` que le pasa a
 * `runPlaybook`) o la redacción final (después de `deliver()` +
 * `deliveryFailed()`, junto con `marcarTurnoVisto()`) —, NUNCA solo porque
 * un punto de cesión decidió "no cede".
 *
 * Bug real, hallado en revisión por el orquestador (23/9/2026): la primera
 * versión de esta tarea llamaba a esto en el PUNTO 1 de `runTurnPhases`
 * cada vez que ese punto decidía no ceder — pero "no cede en el punto 1" es
 * el caso normal de CASI todos los turnos (fase 0/1 tarda ~2 s; rara vez
 * alcanza a llegar un fragmento nuevo en ese hueco), así que ese `DEL`
 * corría en cada turno, sin relación con si el turno anterior había
 * incrementado el contador. Secuencia real que eso rompía, con
 * `CESSION_CAP = 2`:
 *
 *   1. Turno A no cede en el punto 1 (nada nuevo todavía), cede en el
 *      punto 2 (llegó un fragmento mientras redactaba) → contador en 1.
 *   2. Turno B no cede en el punto 1 —de nuevo el caso normal— y la
 *      versión vieja BORRABA el contador ahí mismo, volviéndolo a 0, antes
 *      de llegar siquiera al punto 2; en el punto 2 vuelve a ceder →
 *      contador en 1 (no en 2).
 *   3. Turno C, igual que B: el contador NUNCA supera 1, así que el tope
 *      nunca se alcanza — un cliente que no para de escribir en fragmentos
 *      puede quedarse sin ninguna respuesta indefinidamente, exactamente
 *      el caso para el que existe el tope.
 *
 * La corrección ata el `DEL` a la ENTREGA confirmada, no a la decisión de
 * "seguir de largo": con eso, un turno que cede en su punto 2 dos veces
 * seguidas SÍ deja el contador en 2, y el tercero —aunque su punto 1 no
 * ceda, como siempre— topa en el punto 2 y entrega.
 */
export async function clearCessionCounter(conversationId: string): Promise<void> {
  try {
    await getRedis().del(cessionKey(conversationId));
  } catch (err) {
    log.warn("turno_cesion_contador_no_borrado", { conversationId, detail: errorText(err) });
  }
}
