import "server-only";
import { getRedis } from "@/lib/redis";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// T6, plan "Seba no habla de más mientras el cliente espera al asesor"
// (22-23/9/2026, decisión del operador: "esperar la pregunta"). Caso RK200
// (22/9/2026, medido por el VPS): un cliente que YA conocía a Seba escribió
// "Buenas tardes" solo; el turno arrancó con ESE único pendiente y corrió
// igual —clasificó, corrió el tool loop y terminó escalando hablando de algo
// que el cliente ni había preguntado— porque la pregunta real llegó 10 s
// después, ya con el turno en marcha sobre un historial que todavía no la
// tenía.
//
// Cuando los pendientes de un turno (T1, `pendingCustomerLines`,
// history-line.ts) son SOLO saludo y Seba YA se había presentado ANTES de
// este turno (ver el `if` en `runTurnPhases`, agent.ts), conviene esperar un
// poco por si la pregunta real viene detrás — pero solo una vez: un cliente
// que de verdad solo quería saludar no puede quedarse sin respuesta.
//
// `claimGreetingWait` deja (o encuentra) un rastro CORTO en Redis, mismo
// patrón que el contador de cesiones de `turn-cession.ts`: distingue el
// primer intento (nadie esperó todavía: se difiere) del segundo (ya se
// esperó una vez: se contesta, pase lo que pase). El turno pide el diferido
// LANZANDO `GreetingAwaitsQuestionError` — el plan pide reusar el mecanismo
// que ya tiene la cola (`defer` + `registrarDiferidos`, ver queue.ts) en vez
// de inventar un segundo camino: mismo patrón que `ConversationBusyError`
// (conversation-lock.ts).
// ---------------------------------------------------------------------------

/**
 * Cuánto se difiere el turno la primera vez que ve un saludo suelto de un
 * cliente conocido. Decisión del operador (23/9/2026): 8 s justos — el caso
 * RK200 midió ~10 s de diferencia real entre el saludo y la pregunta, pero
 * esos 8 s son SOLO la espera en cola: se suman al debounce y al reclamo que
 * ya corrieron antes de llegar hasta acá, así que el margen real hasta que
 * el turno vuelve a mirar la conversación es mayor que 8 s solos.
 */
export const GREETING_WAIT_SECONDS = 8;

/**
 * TTL del rastro: más que `GREETING_WAIT_SECONDS` para que el reclamo del
 * segundo intento (que corre DESPUÉS de la espera, más lo que tarde la cola
 * en reclamarlo de nuevo) lo siga encontrando puesto, pero corto — una vez
 * resuelto este saludo, un rastro viejo no tiene por qué confundir a uno
 * nuevo minutos después.
 */
const TTL_SECONDS = GREETING_WAIT_SECONDS + 30;

function key(conversationId: string): string {
  return `turno:saludo_suelto:${conversationId}`;
}

export type GreetingWaitOutcome = "primer_intento" | "segundo_intento" | "sin_redis";

/**
 * Reclama (o encuentra) el rastro de esta conversación. `SET ... NX`: solo
 * la PRIMERA llamada logra ESCRIBIR la clave — mientras el TTL no venza, las
 * siguientes la encuentran puesta y devuelven `"segundo_intento"`.
 *
 * Nunca lanza: sin Redis (`"sin_redis"`) el llamador no difiere — mismo
 * criterio que `turn-seen.ts`/`turn-cession.ts` (CLAUDE.md): un corte de
 * Redis hace que esta tarea se comporte como si no existiera, nunca que el
 * turno se caiga.
 */
export async function claimGreetingWait(conversationId: string): Promise<GreetingWaitOutcome> {
  try {
    const puesta = await getRedis().set(key(conversationId), "1", "EX", TTL_SECONDS, "NX");
    return puesta === "OK" ? "primer_intento" : "segundo_intento";
  } catch (err) {
    log.warn("turno_saludo_suelto_redis_no_disponible", { conversationId, detail: errorText(err) });
    return "sin_redis";
  }
}

/**
 * Borra el rastro cuando el turno termina de verdad: Seba contestó el saludo
 * fijo (segundo intento sin pregunta detrás), o la pregunta real llegó y el
 * turno la contesta por el camino de siempre (ver `agent.ts`, dónde se
 * llama en cada caso). Nunca lanza: un DEL que no se pudo hacer deja el
 * rastro viejo, que en el peor caso vence solo a los `TTL_SECONDS`.
 */
export async function clearGreetingWait(conversationId: string): Promise<void> {
  try {
    await getRedis().del(key(conversationId));
  } catch (err) {
    log.warn("turno_saludo_suelto_rastro_no_borrado", { conversationId, detail: errorText(err) });
  }
}

/**
 * El turno pide diferirse 8 s por si la pregunta real llega detrás de un
 * saludo suelto — no es un fallo, es una espera deliberada. La cola
 * (`queue.ts`) la reconoce con `isGreetingAwaitsQuestion` y la trata igual
 * que `ConversationBusyError`: `defer()` con `GREETING_WAIT_SECONDS`, sin
 * contarla como intento fallido (`recordFailure` no corre para este caso).
 */
export class GreetingAwaitsQuestionError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(
      `El turno de ${conversationId} espera ${GREETING_WAIT_SECONDS} s por si la pregunta real llega detrás del saludo.`
    );
    this.name = "GreetingAwaitsQuestionError";
    this.conversationId = conversationId;
  }
}

export function isGreetingAwaitsQuestion(err: unknown): err is GreetingAwaitsQuestionError {
  return err instanceof GreetingAwaitsQuestionError;
}
