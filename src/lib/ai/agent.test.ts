import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Playbook } from "@/lib/types";
import type { Intent } from "@/lib/ai/classify";
import { DEFAULT_BUSINESS_HOURS } from "@/lib/business-hours";

// ---------------------------------------------------------------------------
// Fake de Supabase acotado a lo que el orquestador realmente consulta.
// ---------------------------------------------------------------------------
interface FakeState {
  aiGloballyEnabled: boolean;
  /** Lo que devuelve la función agent_can_run() de la base. */
  canRun: boolean;
  conversation: Record<string, unknown> | null;
  /**
   * T1, plan "Seba sale sin pisar a nadie" (19/9/2026, C2): el error que
   * devuelve la lectura de `conversations` en la apertura del turno —
   * distinto de `data: null` sin error (la fila no existe, rama de siempre).
   * `null` de fábrica: la consulta se comporta como antes de esta tarea. Sin
   * esto, un 400 de PostgREST (p. ej. por faltar la migración
   * `20260916010000`, columna `ai_resume_cutoff_at`) se leía como "la
   * conversación no existe" y el turno se callaba sin traspaso ni log.
   */
  conversationError: { message: string } | null;
  history: {
    sender_type: string;
    content: string | null;
    is_internal_note: boolean;
    /** T3.2 (5/9/2026): loadHistory salta 'unsupported' explícito, sin depender de que content sea null. */
    message_type?: string;
    /**
     * T3, plan "Seba sale sin pisar a nadie" — corrección del 19/9/2026
     * (`code-review high`, hallazgo 4): la fecha real de la fila, que
     * `customerBurst` usa para acotar la ráfaga por tiempo. `undefined` de
     * fábrica (como antes de esta corrección) para los tests que no la
     * ejercitan — sin fecha, `customerBurst` trata la línea de forma
     * conservadora (ver su docblock en history-line.ts).
     */
    created_at?: string;
    /**
     * T1, plan "Seba no habla de más mientras el cliente espera al asesor"
     * (22-23/9/2026): el `id` real de la fila, que `pendingCustomerLines`/
     * `latestCustomerMarker` (history-line.ts) usan para desempatar dos
     * fragmentos del cliente con el mismo `created_at` de segundo.
     * `undefined` de fábrica para los tests que no la ejercitan.
     */
    id?: string;
  }[];
  historyOrderAscending: boolean | null;
  /** Claves encendidas en public.agent_tools. */
  enabledToolKeys: string[];
  /** Qué devuelve el upsert de contact_tags. Sirve para probar que un fallo etiquetando no frena el turno. */
  tagUpsertError: { message: string } | null;
  /**
   * Mensajes de asesor humano en la conversación, con `created_at` (T7,
   * 8/9/2026: la guarda dejó de preguntar "¿alguna vez?" y ahora compara
   * fechas — ver human-handled.ts). Con uno cuyo `created_at` sea posterior a
   * `last_customer_message_at`, o de hace menos de la gracia configurada, el
   * turno no corre: el chat es de esa persona AHORA.
   */
  humanMessages: { created_at: string }[];
  /** Fallo al preguntar si escribió una persona. La guarda falla cerrado. */
  humanMessagesError: { message: string } | null;
  /**
   * Qué devuelve `ai_turn_lock_renew` (conversation-lock.ts). `true` de
   * fábrica: el lock nunca es el protagonista salvo en su propio describe.
   */
  turnLockRenewResult: { data: boolean | null; error: { message: string } | null };
  /**
   * El wamid del último mensaje ENTRANTE (T3.1, 4/9/2026): lo que
   * `fireTypingIndicator` necesita para el "message_id" que Meta exige.
   * `null` simula un chat sin ningún mensaje entrante con wamid.
   */
  lastInboundWamid: string | null;
  /**
   * Anexo B2 (5/9/2026): qué devuelve el UPDATE que marca `is_auto_reply`
   * sobre el mensaje de un escenario que escaló sin asesores. `null` de
   * fábrica — el UPDATE sale bien y el turno sigue igual.
   */
  messageUpdateError: { message: string } | null;
  /**
   * Frente B3 (5/9/2026): lo que trae la columna `business_hours` de la fila
   * de `agent_settings`. `undefined` de fábrica — sin columna, `parseBusinessHours`
   * cae al horario por defecto, que es como se comportaban todos los tests
   * escritos antes de este frente.
   */
  agentSettingsBusinessHours: unknown;
  /** Si viene con mensaje, la lectura de `agent_settings` falla — el turno no se cae por eso. */
  agentSettingsError: { message: string } | null;
  /**
   * Tarea 5 (14/9/2026): lo que devuelve la RPC `agent_can_run` como
   * `error`, distinto de una respuesta genuina (`data: false`). Con esto en
   * `null` (de fábrica) la RPC se comporta como antes de esta tarea —
   * `{ data: aiGloballyEnabled && canRun, error: null }`. Con un mensaje, el
   * turno tiene que LANZAR en vez de tratar el corte de base como si el
   * interruptor estuviera apagado (`stillEnabled`/apertura de `runAgentTurn`).
   */
  agentCanRunError: { message: string } | null;
  /** El error que devuelve el INSERT de `agent_turns` (logTurn). `null` de fábrica: el turno nunca se cae por esto, pero sí deja rastro. */
  agentTurnInsertError: { message: string } | null;
  /** El error que devuelve el UPDATE de `conversations.intent`. `null` de fábrica. */
  intentUpdateError: { message: string } | null;
  /**
   * Tarea 4 (14/9/2026): la ÚLTIMA fila de `conversation_handoffs` que
   * `escalationOpen` (handoffs.ts) consulta antes de la guarda de cortesía.
   * `null` de fábrica — sin ningún traspaso previo, `escalationOpen` da
   * `false` y la guarda nunca se activa en los tests que no la ejercitan.
   */
  lastHandoffRow: { reason: string; created_at: string } | null;
  /** Si viene con mensaje, la consulta de `conversation_handoffs` de `escalationOpen` falla. */
  lastHandoffError: { message: string } | null;
  /** Mensajes de asesor (`sender_type = 'agent'`) posteriores al último traspaso — lo que mira `escalationOpen`. */
  agentMessagesAfterHandoff: { id: string }[];
  /** Si viene con mensaje, esa segunda consulta de `escalationOpen` falla. */
  agentMessagesAfterHandoffError: { message: string } | null;
  /**
   * H2b, plan "Seba atiende el mostrador" (18/9/2026): la fila más reciente
   * de `conversation_handoffs` con `reason = "reabierta_por_cliente"` que
   * `reopenedAtIfGraceWouldFire` (human-handled.ts) consulta cuando la
   * cláusula de gracia iba a disparar — ver el docblock de esa función y el
   * de `humanClaimsChat`. `null` de fábrica: "nunca se reabrió", que es el
   * comportamiento de todos los tests de este archivo escritos antes de H2.
   */
  reopenedByCustomerRow: { created_at: string } | null;
  /** Si viene con mensaje, esa consulta falla — se trata como "no hay reapertura" (falla cerrado, igual que el resto de human-handled.ts). */
  reopenedByCustomerError: { message: string } | null;
  /**
   * T2b, plan "Seba atiende el mostrador" (18/9/2026): qué devuelve el
   * reclamo de `claimPresentation` (`UPDATE ... WHERE id = ? AND
   * welcome_sent_at IS NULL ... SELECT id`). `true` de fábrica: la mayoría
   * de los turnos de esta suite tienen `welcome_sent_at` ya sellado, así que
   * ni siquiera llegan a preguntar esto — solo importa en los tests que
   * ponen `welcome_sent_at: null`.
   */
  presentationClaimWins: boolean;
  /** Si viene con mensaje, el UPDATE del reclamo de presentación falla. */
  presentationClaimError: { message: string } | null;
  /**
   * Hallazgo G, corrección de la Tanda 1 (20/9/2026): si viene con mensaje,
   * el UPDATE de REVERSA (`rollbackPresentation`, `{ welcome_sent_at: null
   * }`) falla — para probar que ese fallo no tapa el error ORIGINAL que
   * disparó el rollback (G-2). `null` de fábrica: el resto de la suite
   * revierte el sello sin problema.
   */
  presentationRollbackError: { message: string } | null;
  /**
   * Gancho que corre justo DESPUÉS de que el reclamo de presentación gana
   * (la consulta ya devolvió éxito), para simular una carrera: algo cambia
   * en el estado justo en el hueco entre el reclamo y el siguiente guardián
   * de `deliver()` — mismo patrón que el resto de la suite usa para las
   * carreras del turno (flip de estado dentro de un mock que corre en el
   * punto exacto), pero acá no hay un `generateMock` al que engancharse
   * porque el reclamo pasa ANTES de clasificar y redactar. `null` de
   * fábrica: no hace nada salvo que un test lo ponga.
   */
  onPresentationClaimed: (() => void) | null;
  /**
   * T5, plan "Seba atiende el mostrador" (18/9/2026): lo que devuelven las
   * dos consultas de `fetchTurnLessons` (lessons.ts) — vacías de fábrica,
   * igual que el resto de esta suite antes de esta tarea, para que ningún
   * test viejo tenga que enterarse de que ahora existe una cuarta consulta.
   */
  globalLessons: string[];
  chatLessons: string[];
  /** Si viene con mensaje, las dos consultas de `ai_lessons` fallan (fetchTurnLessons nunca lanza: se cae a vacío + log.warn). */
  lessonsError: { message: string } | null;
  /**
   * T3, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026):
   * lo que devuelve `fetchActiveCatalogLinks` (data.ts), la quinta consulta
   * del `Promise.all` de apertura, junto a `business_hours`. Vacío de
   * fábrica: ningún test viejo de este archivo usa marcadores de catálogo, y
   * con `[]` `playbookMessageText`/`matchPlaybook` se comportan byte a byte
   * como antes de esta tarea.
   */
  catalogLinkRows: {
    id: string;
    key: string;
    label: string;
    url: string;
    sort_order: number;
    is_active: boolean;
    updated_by: string | null;
    created_at: string;
    updated_at: string;
  }[];
  /** Si viene con mensaje, la consulta de `catalog_links` falla (fetchActiveCatalogLinks nunca lanza: se cae a `[]`). */
  catalogLinksError: { message: string } | null;
  /**
   * T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026): el
   * `id` que el INSERT de `agent_turns` devuelve (`.select("id").single()`,
   * lo que `logTurnCalls` necesita como `turn_id`). Fijo de fábrica —ningún
   * test viejo de este archivo mira qué id sale, así que uno solo alcanza
   * para toda la suite.
   */
  agentTurnInsertedId: string;
  /** Si viene con mensaje, el INSERT de `agent_turn_calls` (logTurnCalls) falla — nunca lanza, deja `turno_llamadas_no_escritas`. */
  agentTurnCallsInsertError: { message: string } | null;
  /**
   * T2, plan "Seba no habla de más mientras el cliente espera al asesor"
   * (22-23/9/2026): lo que devuelve la relectura de
   * `conversations.last_customer_message_at` que hace `shouldCedeDraft`
   * (turn-cession.ts) en los dos puntos de "borrador cedido". `null` de
   * fábrica: sin fecha, `decideCession` nunca cede (ver su docblock), así
   * que ningún test viejo de este archivo se entera de esta relectura
   * nueva a menos que la ponga a mano.
   */
  cessionLastCustomerMessageAt: string | null;
  /** Si viene con mensaje, esa relectura falla — `shouldCedeDraft` no cede y deja `turno_cesion_no_consultable`. */
  cessionLastCustomerMessageAtError: { message: string } | null;
  /**
   * T5, plan "Seba no habla de más mientras el cliente espera al asesor"
   * (22-23/9/2026): el error que devuelve el `INSERT` de la nota interna que
   * deja el camino "espera abierta" cuando ningún escenario informativo
   * calza (`supabase.from("messages").insert(...)`, directo desde
   * `runTurnPhases`, agent.ts). `null` de fábrica: la nota se escribe sin
   * problema salvo que un test la ponga.
   */
  noteInsertError: { message: string } | null;
}

const state: FakeState = {
  aiGloballyEnabled: true,
  canRun: true,
  conversation: null,
  history: [],
  historyOrderAscending: null,
  enabledToolKeys: [],
  tagUpsertError: null,
  humanMessages: [],
  humanMessagesError: null,
  turnLockRenewResult: { data: true, error: null },
  lastInboundWamid: "wamid.ULTIMO_ENTRANTE",
  messageUpdateError: null,
  agentSettingsBusinessHours: undefined,
  agentSettingsError: null,
  agentCanRunError: null,
  conversationError: null,
  agentTurnInsertError: null,
  intentUpdateError: null,
  lastHandoffRow: null,
  lastHandoffError: null,
  agentMessagesAfterHandoff: [],
  agentMessagesAfterHandoffError: null,
  reopenedByCustomerRow: null,
  reopenedByCustomerError: null,
  presentationClaimWins: true,
  presentationClaimError: null,
  presentationRollbackError: null,
  onPresentationClaimed: null,
  globalLessons: [],
  chatLessons: [],
  lessonsError: null,
  catalogLinkRows: [],
  catalogLinksError: null,
  agentTurnInsertedId: "agent-turn-1",
  agentTurnCallsInsertError: null,
  cessionLastCustomerMessageAt: null,
  cessionLastCustomerMessageAtError: null,
  noteInsertError: null,
};
const conversationUpdates: Record<string, unknown>[] = [];
/** Tarea 3 (14/9/2026): columnas pedidas en cada `select()` sobre `conversations`, para probar que trae display_name/profile_name. */
const conversationSelectColumns: string[] = [];
const agentTurnInserts: Record<string, unknown>[] = [];
/**
 * T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026): cada
 * llamada a `.from("agent_turn_calls").insert(rows)` (`logTurnCalls`,
 * agent.ts) — un elemento por INSERT, cada uno el arreglo de filas completo
 * que le llegó (una por llamada al proveedor que hizo el turno).
 */
const agentTurnCallsInserts: Record<string, unknown>[][] = [];
const contactTagUpserts: { rows: unknown; options: unknown }[] = [];
/**
 * Anexo B2 (5/9/2026): cada UPDATE sobre `messages` (marcar `is_auto_reply`
 * en la despedida de un escenario que escaló sin asesores), con los valores y
 * los filtros que le llegaron encadenados.
 */
const messageUpdates: { values: Record<string, unknown>; filters: [string, unknown][] }[] = [];
/**
 * T5, plan "Seba no habla de más mientras el cliente espera al asesor"
 * (22-23/9/2026): cada `INSERT` directo sobre `messages` que hace
 * `runTurnPhases` (agent.ts) — hoy, solo la nota interna del camino "espera
 * abierta" cuando ningún escenario informativo calza.
 */
const messageInserts: Record<string, unknown>[] = [];
/** Cada llamada a la RPC `record_handoff`, con los parámetros que le llegaron. */
const handoffCalls: Record<string, unknown>[] = [];
/**
 * Bitácora del orden real de los tres pasos del escenario. El requisito no es
 * solo que las tres cosas pasen: es que la etiqueta esté puesta ANTES de que
 * el asesor reciba el caso.
 */
const pasos: string[] = [];

function createFakeSupabase() {
  return {
    rpc(fn: string, params?: Record<string, unknown>) {
      // Igual que la función SQL: junta el interruptor global y el tope de gasto.
      if (fn === "agent_can_run") {
        // Tarea 5 (14/9/2026): un error de la RPC es distinto de que la RPC
        // conteste "no" — se simula por separado de `canRun`.
        if (state.agentCanRunError) return Promise.resolve({ data: null, error: state.agentCanRunError });
        return Promise.resolve({ data: state.aiGloballyEnabled && state.canRun, error: null });
      }
      // Lock por conversación (conversation-lock.ts): siempre libre, siempre
      // se puede renovar y soltar. Este archivo prueba UN solo turno a la
      // vez, así que el lock nunca es el protagonista acá.
      if (fn === "ai_turn_lock_acquire") return Promise.resolve({ data: true, error: null });
      if (fn === "ai_turn_lock_renew") {
        return state.turnLockRenewResult.error
          ? Promise.reject(new Error(state.turnLockRenewResult.error.message))
          : Promise.resolve({ data: state.turnLockRenewResult.data, error: null });
      }
      if (fn === "ai_turn_lock_release") return Promise.resolve({ data: true, error: null });
      // Bitácora de traspasos (handoffs.ts). La mayoría de las salidas de
      // este archivo solo necesitan que esto NO explote —qué fila escribe
      // cada salida silenciosa se prueba a fondo en handoffs.test.ts—, pero
      // T0.3 sí necesita mirar los parámetros acá: la salida
      // `rechazado_por_meta` (rechazo de Meta en el camino de escenario) es
      // más natural de cubrir en este archivo, que ya tiene el escenario
      // encendido con `matchPlaybookMock`. Si este caso faltara, el fake
      // lanza por la línea de abajo, `recordHandoff` se traga la excepción
      // —es su contrato— y deja un `traspaso_no_registrado` en el registro.
      if (fn === "record_handoff") {
        handoffCalls.push(params ?? {});
        return Promise.resolve({ data: "handoff-1", error: null });
      }
      throw new Error(`Fake Supabase: rpc no soportada: ${fn}`);
    },
    from(table: string) {
      if (table === "agent_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: state.agentSettingsError
                  ? null
                  : { ai_globally_enabled: state.aiGloballyEnabled, business_hours: state.agentSettingsBusinessHours },
                error: state.agentSettingsError,
              }),
            }),
          }),
        };
      }

      if (table === "conversations") {
        return {
          select: (columns: string) => {
            // T2, plan "Seba no habla de más mientras el cliente espera al
            // asesor" (22-23/9/2026): `shouldCedeDraft` (turn-cession.ts)
            // relee la conversación con este SELECT angosto, en los dos
            // puntos de `runTurnPhases` — un tercer consumidor de
            // `.from("conversations").select(...).eq(...).maybeSingle()`,
            // distinto de la apertura del turno (que trae display_name/
            // profile_name, ver el test de esa forma exacta más abajo) y
            // distinto del reclamo de presentación (que es un `.update`,
            // más abajo). Se distingue por columnas para no ensuciar
            // `conversationSelectColumns` -- ese arreglo solo le importa a
            // la apertura del turno -- ni obligar a los ~220 tests
            // existentes a enterarse de esta relectura nueva.
            if (columns === "last_customer_message_at") {
              return {
                eq: () => ({
                  maybeSingle: async () => ({
                    data: state.cessionLastCustomerMessageAtError
                      ? null
                      : { last_customer_message_at: state.cessionLastCustomerMessageAt },
                    error: state.cessionLastCustomerMessageAtError,
                  }),
                }),
              };
            }
            conversationSelectColumns.push(columns);
            return {
              eq: () => ({
                maybeSingle: async () => ({ data: state.conversation, error: state.conversationError }),
              }),
            };
          },
          // T2b, plan "Seba atiende el mostrador" (18/9/2026): el turno usa
          // `.update(...).eq(...)` de dos formas -- un `await` directo (la
          // mayoría: journey_stage, intent, el revert de welcome_sent_at) y
          // el reclamo de presentación (`claimPresentation`, agent.ts:
          // `.eq("id", id).is("welcome_sent_at", null).select("id")`). El
          // objeto que devuelve `.eq()` tiene que servir para las dos --
          // "thenable" para el primer caso, encadenable con `.is()` +
          // `.select()` para el segundo -- mismo patrón que ya usa
          // welcome-race.test.ts para `claimWelcome` (route.ts).
          update: (values: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => {
              const builder = {
                is: (_isCol: string, _isVal: unknown) => ({
                  select: async (_cols: string) => {
                    if (state.presentationClaimError) {
                      return { data: null, error: state.presentationClaimError };
                    }
                    if (!state.presentationClaimWins) {
                      // El claim pierde: otra corrida ya selló
                      // welcome_sent_at (o simplemente no calzó). 0 filas,
                      // sin aplicar el patch.
                      return { data: [], error: null };
                    }
                    conversationUpdates.push(values);
                    state.onPresentationClaimed?.();
                    return { data: [{ id }], error: null };
                  },
                }),
                then: (resolve: (value: { data: null; error: unknown }) => void) => {
                  conversationUpdates.push(values);
                  // Tarea 5 (14/9/2026): solo el UPDATE que toca `intent`
                  // puede fallar en estos tests — es el único que agent.ts
                  // revisa. Hallazgo G (20/9/2026): sumado el UPDATE de
                  // reversa del sello de presentación (`rollbackPresentation`,
                  // `{ welcome_sent_at: null }`), el otro que agent.ts sí
                  // mira el `error` de vuelta.
                  const error =
                    "intent" in values
                      ? state.intentUpdateError
                      : values.welcome_sent_at === null
                        ? state.presentationRollbackError
                        : null;
                  resolve({ data: null, error });
                },
              };
              return builder;
            },
          }),
        };
      }

      if (table === "messages") {
        return {
          // T5, plan "Seba no habla de más mientras el cliente espera al
          // asesor" (22-23/9/2026): `INSERT` directo de la nota interna del
          // camino "espera abierta" — `.insert({...})` sin encadenar nada
          // más, `await`-ado directo por `runTurnPhases` (agent.ts).
          insert: (row: Record<string, unknown>) => {
            messageInserts.push(row);
            return Promise.resolve({ data: null, error: state.noteInsertError });
          },
          // Anexo B2 (5/9/2026): el UPDATE que marca `is_auto_reply` en la
          // despedida de un escenario que escaló sin asesores. La cadena real
          // termina en `.gt("created_at", ...)`, así que ahí se registra el
          // update completo (valores + filtros acumulados) y se devuelve lo
          // único que hace falta que sea `await`-able.
          update: (values: Record<string, unknown>) => {
            const filters: [string, unknown][] = [];
            const builder = {
              eq: (col: string, val: unknown) => {
                filters.push([col, val]);
                return builder;
              },
              gt: (col: string, val: unknown) => {
                filters.push([col, val]);
                messageUpdates.push({ values, filters: [...filters] });
                return Promise.resolve({ data: null, error: state.messageUpdateError });
              },
            };
            return builder;
          },
          select: (columns: string) => ({
            eq: () => ({
              // Se guarda cómo se pidió el orden: la IA tiene que leer los
              // mensajes MÁS RECIENTES, no los más antiguos.
              order: (_col: string, opts: { ascending: boolean }) => {
                state.historyOrderAscending = opts.ascending;
                return { limit: async () => ({ data: state.history }) };
              },
              // Segundo .eq(): dos consumidores distintos comparten esta forma
              // (conversation_id + un segundo filtro) y se distinguen por las
              // columnas que pidieron en select() — humanHasWritten (T7,
              // 8/9/2026) pide "created_at" y encadena `.order().limit()`
              // (antes pedía "id" y terminaba en `.limit()` sin `order()`, sin
              // ventana de tiempo que comparar); `lastInboundWamid` (T3.1,
              // 4/9/2026) pide "whatsapp_message_id" y sigue con
              // `.order().limit().maybeSingle()`. Se lee `state` en el momento
              // de la llamada, no al construir el fake: es lo que deja que un
              // asesor "entre" a mitad de turno.
              eq: () => {
                if (columns === "created_at") {
                  return {
                    order: () => ({
                      limit: async () => ({
                        data: state.humanMessagesError ? null : state.humanMessages,
                        error: state.humanMessagesError,
                      }),
                    }),
                  };
                }
                // Tarea 4 (14/9/2026): `escalationOpen` (handoffs.ts) pide
                // "id" y encadena `.eq("sender_type", "agent").gt("created_at",
                // ...).limit(1)` — un tercer consumidor de esta misma forma
                // de select, distinguido por columna igual que los otros dos.
                if (columns === "id") {
                  return {
                    gt: () => ({
                      limit: async () => ({
                        data: state.agentMessagesAfterHandoffError ? null : state.agentMessagesAfterHandoff,
                        error: state.agentMessagesAfterHandoffError,
                      }),
                    }),
                  };
                }
                return {
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({
                        data: state.lastInboundWamid ? { whatsapp_message_id: state.lastInboundWamid } : null,
                        error: null,
                      }),
                    }),
                  }),
                };
              },
            }),
          }),
        };
      }

      if (table === "agent_tools") {
        return {
          select: () => ({
            eq: async () => ({ data: state.enabledToolKeys.map((key) => ({ key })), error: null }),
          }),
        };
      }

      if (table === "contact_tags") {
        return {
          upsert: (rows: unknown, options: unknown) => {
            contactTagUpserts.push({ rows, options });
            pasos.push("etiquetar");
            return Promise.resolve({ data: null, error: state.tagUpsertError });
          },
        };
      }

      if (table === "agent_turns") {
        return {
          // T4, plan "Nada se pierde en un corte ni en un deploy"
          // (21-22/9/2026): `logTurn` pasó de `await .insert(row)` a
          // `.insert(row).select("id").single()` — el `id` que devuelve es
          // el `turn_id` que `logTurnCalls` necesita para las filas de
          // `agent_turn_calls`.
          insert: (row: Record<string, unknown>) => {
            agentTurnInserts.push(row);
            return {
              select: (_cols: string) => ({
                single: async () =>
                  state.agentTurnInsertError
                    ? { data: null, error: state.agentTurnInsertError }
                    : { data: { id: state.agentTurnInsertedId }, error: null },
              }),
            };
          },
        };
      }

      // T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026):
      // `logTurnCalls` (agent.ts) vuelca acá las llamadas al proveedor que
      // `turnCallsSnapshot()` (turn-telemetry.ts) acumuló durante el turno.
      // Con el mock de `ai` de este archivo (`ToolLoopAgent`/`generateText`
      // fingidos, ver más abajo), el middleware REAL de telemetría no corre
      // — `@/lib/ai/model` también está mockeado —, así que en la enorme
      // mayoría de los tests este INSERT nunca se llama (`logTurnCalls` sale
      // temprano con un arreglo vacío). Solo lo ejercitan los tests que
      // seedean el registro a mano (ver el describe de telemetría).
      if (table === "agent_turn_calls") {
        return {
          insert: (rows: Record<string, unknown>[]) => {
            agentTurnCallsInserts.push(rows);
            return Promise.resolve({ data: null, error: state.agentTurnCallsInsertError });
          },
        };
      }

      // Tarea 4 (14/9/2026): `escalationOpen` (handoffs.ts) — la guarda de
      // cortesía tras una escalada abierta la consulta ANTES de fase 0.
      // Tarea 5 (14/9/2026): la consulta real sumó un `.not("reason", "in",
      // …)` entre `.eq()` y `.order()` (excluye las razones que no cambian
      // de dueño). Este fake ya trae `state.lastHandoffRow` RESUELTO -- no
      // filtra una lista, es `agent.test.ts` el que arma el escenario -- así
      // que `.not()` es un passthrough: el filtro de verdad, sobre filas
      // crudas, lo ejercita `handoffs.test.ts` (mini PostgREST genérico).
      // H2b, plan "Seba atiende el mostrador" (18/9/2026): esta tabla ahora
      // tiene DOS consumidores con la misma raíz `.select().eq(...)` — se
      // distinguen por el método que encadenan después del primer `.eq()`
      // (`conversation_id`), no por el valor, porque este fake no captura qué
      // se pidió en cada `.eq()`: `escalationOpen` sigue con `.not(...)`
      // (Tarea 4/5, 14/9/2026) y termina en `.maybeSingle()`;
      // `reopenedAtIfGraceWouldFire` (human-handled.ts) encadena un segundo
      // `.eq("reason", "reabierta_por_cliente")` y termina en `.limit(1)`
      // SIN `.maybeSingle()` — la consulta real trae una lista.
      if (table === "conversation_handoffs") {
        return {
          select: () => ({
            eq: () => ({
              not: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: state.lastHandoffError ? null : state.lastHandoffRow,
                      error: state.lastHandoffError,
                    }),
                  }),
                }),
              }),
              eq: () => ({
                order: () => ({
                  limit: async () => ({
                    data: state.reopenedByCustomerError
                      ? null
                      : state.reopenedByCustomerRow
                        ? [state.reopenedByCustomerRow]
                        : [],
                    error: state.reopenedByCustomerError,
                  }),
                }),
              }),
            }),
          }),
        };
      }

      // T5, plan "Seba atiende el mostrador" (18/9/2026): `fetchTurnLessons`
      // (lessons.ts) hace DOS consultas contra esta misma tabla, distinguidas
      // por el filtro `scope` — el fake acumula los `.eq()` que le lleguen
      // (en cualquier orden, cualquier cantidad) y recién resuelve en
      // `.order().limit()`, así no queda pegado a la forma exacta de la
      // cadena real.
      if (table === "ai_lessons") {
        return {
          select: () => {
            const filters: Record<string, unknown> = {};
            const builder = {
              eq: (col: string, val: unknown) => {
                filters[col] = val;
                return builder;
              },
              order: () => ({
                limit: async () => {
                  if (state.lessonsError) return { data: null, error: state.lessonsError };
                  const rows = filters.scope === "conversacion" ? state.chatLessons : state.globalLessons;
                  return { data: rows.map((content) => ({ content })), error: null };
                },
              }),
            };
            return builder;
          },
        };
      }

      // T3, plan "Nada sin leer, un solo catálogo y la factura Saint"
      // (18/9/2026): `fetchActiveCatalogLinks` (data.ts) hace
      // `.select(...).eq("is_active", true).order("sort_order")` y devuelve
      // el resultado directo de `.order()` (sin `.limit()`/`.maybeSingle()`).
      if (table === "catalog_links") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({
                data: state.catalogLinksError ? null : state.catalogLinkRows,
                error: state.catalogLinksError,
              }),
            }),
          }),
        };
      }

      throw new Error(`Fake Supabase: tabla no soportada: ${table}`);
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createFakeSupabase() }));

/**
 * T1, plan "Seba no habla de más mientras el cliente espera al asesor"
 * (22-23/9/2026): fake de Redis PROPIO para la marca "visto hasta"
 * (`turn-seen.ts`) — no el `FakeRedis` de fake-redis.ts, que es de la cola y
 * otra tarea en paralelo (T3 del mismo plan) lo toca. Un `Map` en memoria
 * detrás de `get`/`set` alcanza: acá interesa qué queda escrito bajo
 * `turno:visto:<id>`, no la semántica de los scripts Lua de la cola.
 */
const redisSeenStore = new Map<string, string>();
/**
 * T2, mismo plan (22-23/9/2026): el contador de "borrador cedido"
 * (`turn-cession.ts`) comparte esta misma conexión falsa — `incr`/`expire`/
 * `del` sobre un segundo `Map`, `turno:cedido:<id>`. La lógica FINA del tope
 * (INCR + EXPIRE exactos, el corte en 2, Redis caído) ya la prueba
 * `turn-cession.test.ts` con su propio espía; acá solo hace falta que estos
 * tres métodos EXISTAN y se comporten (si no, cada cesión evaluada deja
 * `turno_cesion_redis_no_disponible`/`turno_cesion_contador_no_borrado` en
 * el log de cada test de este archivo, aunque el resultado —"no cede"— sea
 * el mismo por otra vía).
 */
const redisCedidoStore = new Map<string, number>();
/**
 * T6, plan "Seba no habla de más mientras el cliente espera al asesor"
 * (22-23/9/2026): apagador único para simular un Redis caído -- ningún test
 * de este archivo, antes de esta tarea, necesitaba tumbar la conexión falsa
 * ENTERA (turn-seen.test.ts/turn-cession.test.ts tienen su propio `fallaCon`
 * porque prueban esos módulos aislados). `claimGreetingWait` sí necesita un
 * caso "sin Redis" en `agent.test.ts` porque su tercera salida
 * (`"sin_redis"`) decide si el TURNO difiere o sigue de largo -- eso solo se
 * puede ver corriendo `runAgentTurn` de punta a punta.
 */
let redisFailing = false;
vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    get: async (key: string) => {
      if (redisFailing) throw new Error("Redis no disponible (test)");
      return redisSeenStore.get(key) ?? null;
    },
    // T6, plan "Seba no habla de más mientras el cliente espera al asesor"
    // (22-23/9/2026): `claimGreetingWait` (greeting-wait.ts) reclama su
    // rastro con `SET ... NX` sobre esta misma conexión falsa (comparte
    // `redisSeenStore`: el prefijo de su clave, `turno:saludo_suelto:`,
    // nunca choca con `turno:visto:`) — sin honrar `NX` de verdad, el
    // segundo intento volvería a "ganar" el `SET` y jamás se distinguiría
    // del primero. `writeSeen` (turn-seen.ts) nunca manda `NX`, así que su
    // comportamiento de siempre —sobrescribir sin condición— no cambia.
    set: async (key: string, value: string, ..._args: unknown[]) => {
      if (redisFailing) throw new Error("Redis no disponible (test)");
      const nx = _args.some((arg) => typeof arg === "string" && arg.toUpperCase() === "NX");
      if (nx && redisSeenStore.has(key)) return null;
      redisSeenStore.set(key, value);
      return "OK" as const;
    },
    incr: async (key: string) => {
      if (redisFailing) throw new Error("Redis no disponible (test)");
      const next = (redisCedidoStore.get(key) ?? 0) + 1;
      redisCedidoStore.set(key, next);
      return next;
    },
    expire: async () => {
      if (redisFailing) throw new Error("Redis no disponible (test)");
      return 1;
    },
    // `del` limpia en las DOS reservas falsas: el contador de cesiones
    // (`turno:cedido:<id>`) y ahora también `redisSeenStore` —de donde
    // `clearGreetingWait` borra su rastro (`turno:saludo_suelto:<id>`)—. Los
    // prefijos de clave nunca se pisan entre sí, así que borrar de las dos a
    // la vez es inofensivo para quien solo usaba una.
    del: async (key: string) => {
      const existedInCedido = redisCedidoStore.delete(key);
      const existedInSeen = redisSeenStore.delete(key);
      return existedInCedido || existedInSeen ? 1 : 0;
    },
  }),
}));

const matchPlaybookMock = vi.fn();
const fetchActivePlaybooksMock = vi.fn(async () => [] as Playbook[]);
/** Si este escenario ya salió en este chat dentro de la ventana de repetición. */
const playbookSentRecentlyMock = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => false);
/**
 * `ZERO_USAGE` (8/9/2026, T2): agent.ts la usa como el "sin escenario, sin
 * costo" cuando salta `matchPlaybook` porque la última línea del cliente es
 * un marcador de media — el mock necesita exportar el mismo nombre, aunque
 * el valor exacto no importa para estos tests (nunca se suma a un total que
 * el test verifique).
 */
vi.mock("@/lib/ai/playbooks", () => ({
  matchPlaybook: (...args: unknown[]) => matchPlaybookMock(...args),
  fetchActivePlaybooks: () => fetchActivePlaybooksMock(),
  playbookSentRecently: (...args: unknown[]) => playbookSentRecentlyMock(...args),
  ZERO_USAGE: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
}));

type AnyMock = (...args: unknown[]) => Promise<unknown>;

/**
 * T0.3: `sendAgentText`/`sendPlaybookReply` dejaron de ser `Promise<void>` —
 * devuelven el `DeliveryOutcome` que agent.ts mira para saber si Meta
 * rechazó el envío. Un mock que resolviera `undefined` haría que `deliver()`
 * tratara CUALQUIER envío como bloqueado por una guarda (`if (!salida)
 * return`), así que el valor por defecto tiene que ser un outcome de verdad
 * — el mismo que produce un canal simulado (`whatsapp_status: null`, ni
 * enviado ni rechazado).
 */
const OUTCOME_NO_ENVIADO = {
  whatsapp_message_id: null,
  whatsapp_status: null as "sent" | "failed" | null,
  whatsapp_error_code: null,
  whatsapp_error_detail: null,
  origenDelFallo: null as "meta" | "red" | null,
};
const sendPlaybookReplyMock = vi.fn<AnyMock>(async () => OUTCOME_NO_ENVIADO);
const sendAgentTextMock = vi.fn<AnyMock>(async () => OUTCOME_NO_ENVIADO);
// Los envíos se fingen; `playbookMessageText` no. Es lo que compone el texto
// que sale, y el turno lo usa para reconocer su propio mensaje en el
// historial: fingirlo acá sería escribir dos veces la misma regla y probar la
// copia. Ver alreadySentPlaybook en agent.ts.
vi.mock("@/lib/ai/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/send")>()),
  sendPlaybookReply: (...args: unknown[]) => sendPlaybookReplyMock(...args),
  sendAgentText: (...args: unknown[]) => sendAgentTextMock(...args),
}));

interface FakeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokenDetails?: { noCacheTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /**
   * T4b, plan "La escalada se hace una vez y la búsqueda responde"
   * (21/9/2026): igual que `inputTokenDetails` de arriba, opcional y con sus
   * dos campos también opcionales — así un mock puede mandar el objeto sin
   * `reasoningTokens` (el caso real de un proveedor que separa texto de
   * razonamiento pero no siempre reporta el segundo) sin que TypeScript se
   * queje, y `tokensFromUsage` (agent.ts) tiene que leerlo con `?? 0` de
   * todos modos.
   */
  outputTokenDetails?: { textTokens?: number; reasoningTokens?: number };
}

/**
 * Forwarding de argumentos (8/9/2026, T2): antes el wrapper de `vi.mock`
 * llamaba a `classifyIntentMock()` sin pasarle nada, así que ningún test
 * podía mirar QUÉ historial le llegó al clasificador — hacía falta para
 * probar que un audio sin texto SÍ le llega como línea `user` con el
 * marcador exacto (ver "solo un audio ya no deja el historial vacío" en el
 * describe de historial).
 */
const classifyIntentMock = vi.fn<(...args: unknown[]) => Promise<{ intent: Intent; usage: FakeUsage }>>(async () => ({
  intent: "consulta_disponibilidad",
  usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
}));
vi.mock("@/lib/ai/classify", () => ({ classifyIntent: (...args: unknown[]) => classifyIntentMock(...args) }));

const escalateConversationMock = vi.fn<AnyMock>(async () => ({ escalated: true, assignedAgentName: "María" }));
vi.mock("@/lib/ai/escalate", () => ({
  escalateConversation: (...args: unknown[]) => escalateConversationMock(...args),
  RECLAMO_CATEGORIES: ["Envío", "Pago", "Producto", "Atención", "Garantía"],
}));

/** `steps` es lo que el turno mira para saber cuántos pasos gastó de verdad. */
const generateMock = vi.fn<() => Promise<{ text: string; usage: FakeUsage; steps: unknown[] }>>(
  async () => ({
    text: "respuesta redactada por el modelo",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    steps: [{}, {}],
  })
);
/**
 * Opciones con las que se construyó el ToolLoopAgent: es donde viajan las
 * instrucciones. Tarea K, "El resguardo antes del push" (20/9/2026): suma
 * `prepareStep` (opcional, como en el SDK real) para poder verificar, sin
 * romper ninguno de los tests que ya miraban `instructions`/`tools`, que el
 * paso 0 del tool loop fuerza `buscarRepuesto` en `consulta_disponibilidad`
 * — la función real vive en `tool-choice.ts` y se prueba sola ahí; acá solo
 * se verifica que `agent.ts` la conecta con las opciones correctas.
 *
 * T1, plan "La escalada se hace una vez y la búsqueda responde" (21/9/2026):
 * `prepareStep` ensancha su tipo de retorno para admitir `toolChoice: "none"`
 * (`stepToolChoice`, tool-choice.ts, tras escalar); suma `maxOutputTokens` y
 * `stopWhen` para poder afirmar el techo de tokens de salida y que el turno
 * que NO escala conserva el freno de `MAX_STEPS` de siempre.
 */
const agentOptions: {
  instructions: string;
  tools: Record<string, unknown>;
  prepareStep?: (options: {
    stepNumber: number;
  }) => { toolChoice?: { type: string; toolName: string } | "none" } | undefined;
  maxOutputTokens?: number;
  stopWhen?: (options: { steps: unknown[] }) => boolean | Promise<boolean>;
}[] = [];
/**
 * Guarda de identidad (6/9/2026): la ÚNICA reescritura que hace
 * `applyIdentityGuard` usa `generateText` (no `ToolLoopAgent` — las
 * herramientas ya corrieron). Default: un texto limpio que no vuelve a
 * calzar ningún patrón de `identity-guard.ts`, para que los tests que NO
 * disparan la guarda no tengan que preocuparse por este mock.
 */
const generateTextMock = vi.fn<
  (args: Record<string, unknown>) => Promise<{ text: string; usage: FakeUsage }>
>(async () => ({
  text: "texto reescrito limpio",
  usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
}));
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  ToolLoopAgent: class {
    constructor(options: {
      instructions: string;
      tools: Record<string, unknown>;
      prepareStep?: (options: {
        stepNumber: number;
      }) => { toolChoice?: { type: string; toolName: string } | "none" } | undefined;
      maxOutputTokens?: number;
      stopWhen?: (options: { steps: unknown[] }) => boolean | Promise<boolean>;
    }) {
      agentOptions.push(options);
    }
    generate = generateMock;
  },
  generateText: (...args: unknown[]) => generateTextMock(args[0] as Record<string, unknown>),
}));

/** Con qué `effort` se llamó `getAgentModel` en cada turno: lo usa el describe de la guarda de identidad para afirmar que la reescritura pide "low". */
const getAgentModelCalls: unknown[] = [];
vi.mock("@/lib/ai/model", () => ({
  getAgentModel: (effort?: unknown) => {
    getAgentModelCalls.push(effort);
    return { model: "modelo-falso" };
  },
  currentAgentModelLabel: () => "fake/modelo",
}));

/**
 * Anexo B2 (5/9/2026), test (e): `runPlaybook` acepta `lastCustomerMessageAt:
 * string | null` porque el TIPO lo permite, pero en un turno real nunca llega
 * nulo — `withinFreeformWindow(convo.last_customer_message_at)` ya lo exige
 * ANTES de que `runAgentTurn` llegue a abrir el lock. Para probar la rama
 * defensiva de todos modos, este mock deja pasar el `import` real de
 * `@/lib/dashboard` sin tocar nada salvo que un test puntual instale un
 * override — así se fuerza la ventana abierta con `last_customer_message_at:
 * null` sin mentirle a ningún otro test de este archivo (el describe de
 * "ventana de 24 h" sigue usando el comportamiento real).
 */
const withinFreeformWindowOverride: {
  fn: ((lastCustomerMessageAt: string | null, now?: number) => boolean) | null;
} = { fn: null };
vi.mock("@/lib/dashboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dashboard")>();
  return {
    ...actual,
    withinFreeformWindow: (lastCustomerMessageAt: string | null, now?: number) =>
      withinFreeformWindowOverride.fn
        ? withinFreeformWindowOverride.fn(lastCustomerMessageAt, now)
        : actual.withinFreeformWindow(lastCustomerMessageAt, now),
  };
});

/**
 * `buildEscalateTool` real (`tools.ts`) es lo que copia `result.unassigned`
 * al `outcome` cuando el MODELO invoca la herramienta durante el tool loop.
 * Acá el tool loop entero está fingido (`generateMock` no ejecuta ninguna
 * herramienta de verdad), así que para simular "el modelo llamó a
 * `escalarAAsesor`" un test puntual sobrescribe este mock para que mute el
 * `outcome` que le llega — el mismo objeto que `runTurnPhases` construye
 * ANTES de invocar `agent.generate()`, así que mutarlo acá tiene el mismo
 * efecto observable que si la herramienta hubiera corrido de verdad
 * (anexo A1, 5/9/2026).
 */
/**
 * T2, plan "La escalada se hace una vez y la búsqueda responde" (21/9/2026):
 * `buildEscalateTool` ganó un tercer parámetro (`{ restrictedToPurchase }`)
 * que `agent.ts` pasa cuando el chat ya tiene asesor — el mock lo reenvía
 * para que los tests de este archivo puedan comprobar CON QUÉ opciones
 * `agent.ts` arma la herramienta, sin tener que levantar el `tools.ts` real.
 */
const buildEscalateToolMock = vi.fn<
  (deps: unknown, outcome: Record<string, unknown>, opciones?: Record<string, unknown>) => Record<string, never>
>(() => ({}));
/**
 * T3, "Seba atiende el mostrador" (18/9/2026): mismo patrón que
 * `buildEscalateToolMock`, pero para el catálogo. `buildCatalogTool` real
 * (`tools.ts`) es lo que llena `CatalogOutcome` cuando el MODELO invoca
 * `buscarRepuesto` durante el tool loop; acá el tool loop está fingido, así
 * que un test puntual sobrescribe este mock para mutar el `catalogOutcome`
 * que le llega —el mismo objeto que `runTurnPhases` construye ANTES de
 * invocar `agent.generate()`— simulando que el modelo consultó el catálogo,
 * sin correr la herramienta real. Default: no hace nada (`catalogOutcome.ran`
 * queda `false`), igual que la mayoría de los tests de este archivo, que no
 * ejercitan la red de seguridad del catálogo.
 */
const buildCatalogToolMock = vi.fn<(deps: unknown, catalogOutcome: Record<string, unknown>) => Record<string, never>>(
  () => ({})
);
vi.mock("@/lib/ai/tools", () => ({
  buildCatalogTool: (deps: unknown, catalogOutcome: Record<string, unknown>) =>
    buildCatalogToolMock(deps, catalogOutcome),
  buildEscalateTool: (deps: unknown, outcome: Record<string, unknown>, opciones?: Record<string, unknown>) =>
    buildEscalateToolMock(deps, outcome, opciones),
  buildOrderHistoryTool: () => ({}),
}));

vi.mock("@/lib/ai/knowledge", () => ({
  buildKnowledgeTool: () => ({}),
}));

/** "Escribiendo…" hacia Meta (T3.1, 4/9/2026): nunca lanza, así que el mock tampoco. */
const sendTypingIndicatorMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/whatsapp/meta-client", () => ({
  sendTypingIndicator: (...args: unknown[]) => sendTypingIndicatorMock(...args),
}));

import { DESPEDIDA_MEDIA, DESPEDIDA_SIN_ASESOR, despedidaConAsesor, runAgentTurn } from "@/lib/ai/agent";
import { OFF_TOPIC_REPLY, SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { revealsIdentity } from "@/lib/ai/identity-guard";
import { playbookMessageText } from "@/lib/ai/send";
import {
  sebaGreeting,
  sebaGreetingFollowUp,
  TEXTO_CONFIRMAR_INVENTARIO,
  TEXTO_NO_IDENTIFICADO,
  TEXTO_SIN_STOCK,
} from "@/lib/ai/seba";
import { GreetingAwaitsQuestionError } from "@/lib/ai/greeting-wait";
import { log } from "@/lib/log";
/**
 * T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026): SIN
 * mockear -- a diferencia de `@/lib/ai/model` (mockeado más abajo), este
 * archivo prueba `turn-telemetry.ts` de verdad. `runAgentTurn` (real, no
 * mockeado) abre el registro con `conTelemetriaDeTurno`; el mock de
 * `ToolLoopAgent.generate` de este archivo invoca este middleware a mano
 * (ver el describe "telemetría por llamada") para simular, con params
 * realistas, lo que el SDK real haría en cada paso -- el mock de
 * `@/lib/ai/model` de más abajo hace que el middleware NUNCA corra por su
 * cuenta a través del tool loop fingido.
 */
import { telemetryMiddleware } from "@/lib/ai/turn-telemetry";

function playbook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: "pb-1",
    name: "Catálogo general",
    triggerDescription: "el cliente pide el catálogo",
    responseText: "Claro, por acá te dejo el catálogo:",
    attachmentUrl: null,
    attachmentType: null,
    afterSend: "wait",
    isActive: true,
    cedeAlInventario: false,
    tags: [],
    ...overrides,
  };
}

const NO_USAGE = { inputTokens: 3, outputTokens: 1, totalTokens: 4 };

/**
 * La despedida fija CON asesor cuando `status` es `undefined` — el caso de
 * "compatibilidad" de `despedidaConAsesor` (agent.ts): es exactamente lo que
 * devuelve `escalateConversationMock` por defecto en este archivo (el mock
 * no trae `businessStatus`), así que es el texto que hay que esperar en
 * cualquier test que no arme su propio `businessStatus` a mano. Pura y sin
 * reloj: calcularla acá una sola vez no depende de la hora a la que corra la
 * suite (Tarea 5, "La voz cercana y la espera visible", 14/9/2026).
 */
const DESPEDIDA_CON_ASESOR_ABIERTA = despedidaConAsesor(undefined);

beforeEach(() => {
  state.aiGloballyEnabled = true;
  state.canRun = true;
  state.conversation = {
    id: "conv-1",
    contact_id: "contact-1",
    ai_enabled: true,
    assigned_agent_id: null,
    welcome_sent_at: "2026-08-22T10:00:00Z",
    last_customer_message_at: new Date().toISOString(),
    // `null` de fábrica: la mayoría de las conversaciones de la suite nunca
    // pasaron por una devolución manual. Tarea 3, "La IA no vuelve a pedir
    // lo que ya pidió" (16/9/2026) — ver el describe de más abajo.
    ai_resume_cutoff_at: null,
    // "none" de fábrica (T2, "La escalada se hace una vez y la búsqueda
    // responde", 21/9/2026): la mayoría de las conversaciones de la suite
    // nunca pasaron por una intención de compra ya marcada — ver el describe
    // de más abajo para los tests que la ponen en "in_progress".
    deal_status: "none",
    contact: { phone_number: "+584121112233" },
    channel: { phone_number_id: null, status: "demo" },
  };
  state.history = [{ sender_type: "customer", content: "hola quiero accesorios", is_internal_note: false }];
  state.historyOrderAscending = null;
  state.enabledToolKeys = ["buscar_repuesto", "buscar_historial_compras", "consultar_biblioteca"];
  state.tagUpsertError = null;
  state.humanMessages = [];
  state.humanMessagesError = null;
  state.turnLockRenewResult = { data: true, error: null };
  state.lastInboundWamid = "wamid.ULTIMO_ENTRANTE";
  state.messageUpdateError = null;
  state.agentSettingsBusinessHours = undefined;
  state.agentSettingsError = null;
  state.agentCanRunError = null;
  state.conversationError = null;
  state.agentTurnInsertError = null;
  state.intentUpdateError = null;
  state.lastHandoffRow = null;
  state.lastHandoffError = null;
  state.agentMessagesAfterHandoff = [];
  state.agentMessagesAfterHandoffError = null;
  state.reopenedByCustomerRow = null;
  state.reopenedByCustomerError = null;
  state.presentationClaimWins = true;
  state.presentationClaimError = null;
  state.presentationRollbackError = null;
  state.onPresentationClaimed = null;
  state.globalLessons = [];
  state.chatLessons = [];
  state.lessonsError = null;
  state.catalogLinkRows = [];
  state.catalogLinksError = null;
  state.agentTurnInsertedId = "agent-turn-1";
  state.agentTurnCallsInsertError = null;
  state.cessionLastCustomerMessageAt = null;
  state.cessionLastCustomerMessageAtError = null;
  state.noteInsertError = null;
  redisSeenStore.clear();
  redisCedidoStore.clear();
  redisFailing = false;
  withinFreeformWindowOverride.fn = null;
  sendTypingIndicatorMock.mockClear();
  conversationUpdates.length = 0;
  conversationSelectColumns.length = 0;
  agentTurnInserts.length = 0;
  agentTurnCallsInserts.length = 0;
  contactTagUpserts.length = 0;
  messageUpdates.length = 0;
  messageInserts.length = 0;
  pasos.length = 0;
  handoffCalls.length = 0;
  agentOptions.length = 0;
  getAgentModelCalls.length = 0;
  vi.clearAllMocks();
  fetchActivePlaybooksMock.mockResolvedValue([]);
  generateTextMock.mockResolvedValue({
    text: "texto reescrito limpio",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  });
  matchPlaybookMock.mockResolvedValue({ playbook: null, usage: NO_USAGE });
  playbookSentRecentlyMock.mockResolvedValue(false);
  // H1, "Seba atiende el mostrador" (18/9/2026): el default de fábrica era
  // "consulta_disponibilidad", y desde H1 esa intención hace que un
  // escenario calzado se CEDA al catálogo (ver `escenario_cedido_al_catalogo`
  // en agent.ts) en vez de mandarse — cambiar el default acá habría vuelto
  // rojos, sin ninguna razón real, los ~20 tests de escenarios de este
  // archivo que solo prueban la lógica de "calzó/no se repite/etiqueta" y
  // nunca les importó la intención. "otro" es el valor neutro del
  // clasificador (`classify.ts`: "ante la duda, otro") y no dispara ninguna
  // rama especial (ni cede el escenario, ni es fuera_de_tema/devolución/
  // queja), así que un escenario sigue saliendo tal cual salvo que un test
  // pida explícitamente `consulta_disponibilidad`.
  classifyIntentMock.mockResolvedValue({
    intent: "otro",
    usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
  });
  generateMock.mockResolvedValue({
    text: "respuesta redactada por el modelo",
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    steps: [{}, {}],
  });
  sendPlaybookReplyMock.mockImplementation(async () => {
    pasos.push("responder");
    return OUTCOME_NO_ENVIADO;
  });
  escalateConversationMock.mockImplementation(async () => {
    pasos.push("escalar");
    return { escalated: true, assignedAgentName: "María" };
  });
});

describe("runAgentTurn — historial", () => {
  /**
   * Con `ascending: true` y `limit(30)` se traían los TREINTA MÁS ANTIGUOS.
   * En un cliente recurrente eso significa que la IA lee la conversación de
   * hace semanas y nunca ve el mensaje al que tiene que responder.
   */
  it("lee los mensajes más recientes, no los primeros de la conversación", async () => {
    await runAgentTurn("conv-1");

    expect(state.historyOrderAscending).toBe(false);
  });

  it("se los pasa al modelo en orden cronológico, del más viejo al más nuevo", async () => {
    // Tal como los devuelve la consulta: del más nuevo al más viejo.
    state.history = [
      { sender_type: "customer", content: "para una Bera", is_internal_note: false },
      { sender_type: "customer", content: "tienen carburador", is_internal_note: false },
      { sender_type: "customer", content: "hola", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    const enviados = matchPlaybookMock.mock.calls[0][0] as { content: string }[];
    expect(enviados.map((m) => m.content)).toEqual(["hola", "tienen carburador", "para una Bera"]);
  });

  /**
   * T3.2 (5/9/2026): 'unsupported' es Meta avisando que hay algo que el CRM
   * no sabe representar (content ya queda null en la base para ese tipo,
   * pero el filtro es explícito por `message_type`, no por esa nulidad) — no
   * es contenido del cliente ni una respuesta nuestra, así que no debe
   * meterse en el contexto que lee el modelo.
   */
  it("salta los mensajes 'unsupported' del historial", async () => {
    // El fake simula la consulta DESCENDENTE (más nuevo primero), igual que
    // Postgres: loadHistory la invierte para pasarle al modelo el orden
    // cronológico. Se escribe acá en el mismo orden que devuelve la base.
    state.history = [
      { sender_type: "customer", content: "¿tienen aceite 20w50?", is_internal_note: false, message_type: "text" },
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "unsupported" },
      { sender_type: "customer", content: "hola", is_internal_note: false, message_type: "text" },
    ];

    await runAgentTurn("conv-1");

    const enviados = matchPlaybookMock.mock.calls[0][0] as { content: string }[];
    expect(enviados.map((m) => m.content)).toEqual(["hola", "¿tienen aceite 20w50?"]);
  });

  /**
   * Un pedido del catálogo (T3.2, 5/9/2026) entra al historial con el mismo
   * resumen en español que el webhook ya dejó en `content` — no hace falta
   * releer `payload` acá, el resumen ya es el texto que el modelo necesita.
   */
  it("usa el resumen en español de un pedido del catálogo", async () => {
    state.history = [
      {
        sender_type: "customer",
        content: "🛒 El cliente envió un pedido del catálogo (1 producto):\n- 2x SKU-1 (USD 10.00 c/u)\nTotal: USD 20.00",
        is_internal_note: false,
        message_type: "order",
      },
    ];

    await runAgentTurn("conv-1");

    const enviados = matchPlaybookMock.mock.calls[0][0] as { content: string }[];
    expect(enviados[0].content).toContain("Total: USD 20.00");
  });

  /**
   * T2 (8/9/2026, "La IA ve lo que llega", Bug 1 medido en producción el
   * 7/9/2026): antes `loadHistory` descartaba TODA fila sin `content`, y el
   * webhook guarda audio con `content = caption ?? null` — sin pie (el caso
   * normal: WhatsApp no deja ponerle pie a una nota de voz), el historial
   * quedaba vacío y el turno salía sin rastro (caso `cea69118…`, 30
   * reencolados). Este es el test de la prueba de mutación: si `historyLine`
   * volviera a devolver `null` para `audio`, este test se pone rojo.
   */
  it("solo un audio ya no deja el historial vacío: se clasifica y se redacta", async () => {
    state.history = [{ sender_type: "customer", content: null, is_internal_note: false, message_type: "audio" }];

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    const historialRecibido = classifyIntentMock.mock.calls[0][0] as { role: string; content: string }[];
    expect(historialRecibido).toEqual([
      { role: "user", content: "[El cliente envió una nota de voz; no puedes escucharla]" },
    ]);
    // El turno no se queda callado: sin escenario que calce, cae al flujo
    // genérico y redacta.
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Caso `7631718e-52bc-4448-99f2-586789c073ff` (7/9/2026): una foto con pie
   * entra al contexto del modelo con su pie, no solo como "llegó una foto".
   */
  it("una foto con pie entra con su pie", async () => {
    state.history = [
      {
        sender_type: "customer",
        content: "Cualquiera de estos en talla L",
        is_internal_note: false,
        message_type: "image",
      },
    ];

    await runAgentTurn("conv-1");

    const historialRecibido = classifyIntentMock.mock.calls[0][0] as { role: string; content: string }[];
    expect(historialRecibido).toEqual([
      { role: "user", content: "[El cliente envió una foto. Pie: Cualquiera de estos en talla L]" },
    ]);
  });
});

/**
 * S3 del plan (8/9/2026): si la última línea del CLIENTE en el historial es
 * un marcador de media, fase 0 (`matchPlaybook`) no corre — ningún
 * disparador de escenario calza contra "[El cliente envió una foto…]", así
 * que preguntarlo igual sería gastar una llamada de balde. La clasificación
 * de intención SÍ corre igual: define qué herramientas recibe el modelo, y
 * eso no depende de que el último mensaje traiga texto. El caso normal —un
 * texto DESPUÉS de una foto, caso `7631718e…`— sigue corriendo fase 0 con la
 * foto en contexto: ahí la última línea de cliente es texto, no marcador.
 */
describe("runAgentTurn — lo que llega sin texto", () => {
  it("un marcador como último mensaje no llama a matchPlaybook", async () => {
    const info = vi.spyOn(log, "info");
    // Descendente, como los devuelve la consulta: lo más reciente primero.
    state.history = [
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "image" },
      { sender_type: "customer", content: "hola, busco un repuesto", is_internal_note: false, message_type: "text" },
    ];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("turno_ultimo_mensaje_sin_texto", { conversationId: "conv-1" });
    // Nada con qué crear el escenario que faltó: la bitácora queda sin texto
    // de cliente, no con el marcador.
    expect(agentTurnInserts[0]).toMatchObject({ customer_message: null });
  });

  it("una foto seguida de texto sí corre fase 0 con la foto en contexto", async () => {
    // Descendente: lo más reciente (el texto) primero.
    state.history = [
      { sender_type: "customer", content: "Cualquiera de estos en talla L", is_internal_note: false, message_type: "text" },
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "image" },
    ];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).toHaveBeenCalledTimes(1);
    const enviados = matchPlaybookMock.mock.calls[0][0] as { role: string; content: string }[];
    expect(enviados.map((m) => m.content)).toEqual([
      "[El cliente envió una foto sin texto; no puedes verla]",
      "Cualquiera de estos en talla L",
    ]);
    expect(agentTurnInserts[0]).toMatchObject({ customer_message: "Cualquiera de estos en talla L" });
  });

  /**
   * Hallazgo 6 del plan (8/9/2026): `alreadySentPlaybook` salta los
   * marcadores salientes al buscar "nuestra última respuesta" — si el
   * asesor mandó una foto DESPUÉS del escenario, la red que evita repetirlo
   * seguía teniendo que reconocerlo.
   */
  it("la última respuesta nuestra para alreadySentPlaybook salta un marcador de foto del asesor", async () => {
    const info = vi.spyOn(log, "info");
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    // Descendente: lo más reciente primero. La foto del asesor es la última
    // respuesta "cronológica", pero la última respuesta con TEXTO sigue
    // siendo el escenario.
    state.history = [
      { sender_type: "ai", content: null, is_internal_note: false, message_type: "image" },
      { sender_type: "ai", content: playbookMessageText(pb, []), is_internal_note: false, message_type: "text" },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false, message_type: "text" },
    ];

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("escenario_no_se_repite", {
      conversationId: "conv-1",
      escenario: pb.name,
      motivo: "fue_la_ultima_respuesta",
    });
  });

  /**
   * T3, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026,
   * D3/D4): `alreadySentPlaybook` compara contra el texto YA RESUELTO — el
   * historial guarda lo que `sendPlaybookReply` mandó de verdad (la URL,
   * nunca el marcador crudo), así que la comparación tiene que resolver el
   * escenario contra los MISMOS catálogos que se leyeron al abrir el turno
   * para reconocer su propio mensaje.
   */
  it("no repite un escenario con marcador de catálogo ya enviado: compara el texto RESUELTO", async () => {
    const info = vi.spyOn(log, "info");
    const pb = playbook({ responseText: "Acá tienes: {{catalogo:cascos}}" });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    state.catalogLinkRows = [
      {
        id: "link-1",
        key: "cascos",
        label: "Cascos",
        url: "https://drive.google.com/cascos",
        sort_order: 1,
        is_active: true,
        updated_by: null,
        created_at: "2026-09-18T00:00:00.000Z",
        updated_at: "2026-09-18T00:00:00.000Z",
      },
    ];
    // El historial guarda el texto tal como salió la vez anterior: con la
    // URL ya resuelta, nunca con `{{catalogo:cascos}}` crudo.
    state.history = [
      {
        sender_type: "ai",
        content: "Acá tienes: https://drive.google.com/cascos",
        is_internal_note: false,
        message_type: "text",
      },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false, message_type: "text" },
    ];

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("escenario_no_se_repite", {
      conversationId: "conv-1",
      escenario: pb.name,
      motivo: "fue_la_ultima_respuesta",
    });
  });
});

/**
 * Corrección de la revisión `code-review high` del 19/9/2026, punto 6, sobre
 * T3 del plan "Nada sin leer, un solo catálogo y la factura Saint"
 * (18/9/2026): el turno lee los catálogos con `fetchTurnCatalogLinks`
 * (`ai/catalog-links.ts`), que avisa por `log.warn` en vez del
 * `console.error` de `fetchActiveCatalogLinks` (`data.ts`, que también usa
 * el navegador). Una lectura fallida no debe tumbar el turno: sigue con `[]`
 * catálogos, como si no hubiera ninguno cargado.
 */
describe("runAgentTurn — la lectura de catálogos puede fallar sin tumbar el turno", () => {
  it("con la consulta de catalog_links rota, deja turno_enlaces_no_legibles y sigue sin catálogos", async () => {
    const warn = vi.spyOn(log, "warn");
    state.catalogLinksError = { message: "conexión perdida" };

    await runAgentTurn("conv-1");

    expect(warn).toHaveBeenCalledWith(
      "turno_enlaces_no_legibles",
      expect.objectContaining({ conversationId: "conv-1", detail: "conexión perdida" })
    );
  });
});

describe("runAgentTurn — ventana de 24 h de Meta", () => {
  const HACE_25_HORAS = () => new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  /**
   * Fuera de la ventana Meta solo acepta una plantilla aprobada, y no hay
   * ninguna configurada. Sin esta guarda el turno corría completo —clasificar,
   * herramientas, redactar— para producir un mensaje que el cliente nunca ve
   * y una fila en `messages` diciendo que salió.
   */
  it("no atiende una conversación cuyo último mensaje del cliente tiene más de 24 h", async () => {
    state.conversation = { ...state.conversation, last_customer_message_at: HACE_25_HORAS() };

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * El caso que motiva que la guarda esté acá y no solo en la consulta que
   * elige a quién atender: el repaso del atraso encola de una vez y drena a lo
   * largo de una hora, así que una conversación puede cruzar el borde entre
   * que se encoló y que le toca el turno.
   */
  it("tampoco la atiende si un escenario coincidiría", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    state.conversation = { ...state.conversation, last_customer_message_at: HACE_25_HORAS() };

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /** Sin ningún mensaje del cliente no hay ventana abierta: falla cerrado. */
  it("no atiende una conversación sin ningún mensaje del cliente", async () => {
    state.conversation = { ...state.conversation, last_customer_message_at: null };

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  it("dentro de la ventana atiende con normalidad", async () => {
    state.conversation = {
      ...state.conversation,
      last_customer_message_at: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
    };

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Sin esto en el registro, un chat que se quedó fuera de ventana es
   * indistinguible de uno que la IA nunca intentó atender: el mismo silencio.
   */
  it("deja en el registro el evento turno_fuera_de_ventana", async () => {
    const warn = vi.spyOn(log, "warn");
    state.conversation = { ...state.conversation, last_customer_message_at: HACE_25_HORAS() };

    await runAgentTurn("conv-1");

    expect(warn).toHaveBeenCalledWith("turno_fuera_de_ventana", { conversationId: "conv-1" });
  });
});

/**
 * Salidas de apertura de `runAgentTurn`, previas a cualquier intento de
 * hablar con el cliente. Antes de la tarea "Ningún lead invisible" estas
 * corrían sin resguardo: nada impedía que otra tarea les cambiara el
 * comportamiento —loguear de más, loguear de menos, dejar de frenar— sin que
 * ninguna prueba se enterara. Cada caso deja constancia además del hecho que
 * más importa: que no se le mandó nada al cliente.
 */
describe("runAgentTurn — salidas silenciosas de apertura", () => {
  /**
   * La fila puede desaparecer entre que la cola encoló el id y que le tocó el
   * turno: un chat borrado, una migración de datos. Sin la fila no hay nada
   * que atender, y el turno no deja rastro porque no llegó a abrir nada.
   */
  it("si la conversación no existe, no hace nada y no lanza", async () => {
    state.conversation = null;

    await expect(runAgentTurn("conv-1")).resolves.toBeUndefined();

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * Antes era un `return` mudo: con la cola llena y la IA apagada, los turnos
   * se reclamaban y desaparecían sin dejar rastro de por qué (ver el
   * comentario de `runAgentTurn` en agent.ts). El evento es lo que distingue
   * "no había nada que responder" de "algo impidió responder".
   */
  it("con el interruptor global apagado, deja turno_saltado_ia_apagada en el registro", async () => {
    const info = vi.spyOn(log, "info");
    state.canRun = false;

    await runAgentTurn("conv-1");

    expect(info).toHaveBeenCalledWith("turno_saltado_ia_apagada", { conversationId: "conv-1" });
    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * Tarea 5 (14/9/2026), (d) del checklist: un ERROR de la RPC agent_can_run
   * al abrir el turno no es lo mismo que una respuesta que dice "no". Antes
   * de esta tarea, `{ data: canRun }` desestructuraba sin mirar `error`, así
   * que un corte de base dejaba `canRun` en `undefined` y el turno tomaba
   * exactamente el mismo camino que el test de arriba —
   * `turno_saltado_ia_apagada` + traspaso `agente_no_puede_correr`— cuando en
   * realidad no se pudo ni preguntar. Ahora lanza, y la cola reintenta un
   * fallo transitorio en vez de archivarlo como una decisión.
   */
  it("(d) con error en la RPC agent_can_run al ABRIR el turno: lanza y no hay traspaso agente_no_puede_correr", async () => {
    const info = vi.spyOn(log, "info");
    const error = vi.spyOn(log, "error");
    state.agentCanRunError = { message: "conexión perdida" };

    await expect(runAgentTurn("conv-1")).rejects.toThrow(/agent_can_run no consultable/);

    expect(error).toHaveBeenCalledWith(
      "turno_interruptor_no_consultable",
      expect.objectContaining({ conversationId: "conv-1", detail: "conexión perdida" })
    );
    expect(info).not.toHaveBeenCalledWith("turno_saltado_ia_apagada", expect.anything());
    expect(handoffCalls).toHaveLength(0);
    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  /**
   * T1, plan "Seba sale sin pisar a nadie" (19/9/2026, C2): antes de esta
   * tarea la lectura de `conversations` se desestructuraba con `{ data:
   * conversation }` a secas, así que un `error` acá (p. ej. un 400 de
   * PostgREST por faltar la migración `20260916010000`, columna
   * `ai_resume_cutoff_at`) dejaba `conversation` en `undefined` y el turno
   * tomaba la misma rama muda que "la conversación no existe" — sin
   * traspaso, sin log, la cola lo contaba como éxito. Mismo patrón que
   * `turno_interruptor_no_consultable`: ahora lanza ANTES de
   * `entrega.intentado = true`, así la cola reintenta sin riesgo de doble
   * envío.
   */
  it("con error al leer la conversación al ABRIR el turno: lanza y no hay traspaso", async () => {
    const error = vi.spyOn(log, "error");
    state.conversationError = { message: "conexión perdida" };

    await expect(runAgentTurn("conv-1")).rejects.toThrow(/conversación no consultable/);

    expect(error).toHaveBeenCalledWith(
      "turno_conversacion_no_consultable",
      expect.objectContaining({ conversationId: "conv-1", detail: "conexión perdida" })
    );
    expect(handoffCalls).toHaveLength(0);
    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * `!ai_enabled` es la única condición que corta el turno desde T4, "Seba
   * atiende el mostrador" (18/9/2026, D2) — hasta esa corrida, `ai_enabled`
   * (apagado en ESTE chat) y `assigned_agent_id` (chat ya de un asesor) eran
   * dos `if` separados; ahora están fusionados (`if (!convo.ai_enabled) {
   * ... }`) y `assigned_agent_id` solo decide, ADENTRO de esa rama, si el
   * traspaso es `asignada`/`human` o `pausada`/`unassigned` (ver
   * `handoffs.test.ts`). Ninguno de los dos deja nada en `log`: la bitácora
   * vive en `conversation_handoffs`. Este caso no tiene asesor asignado, así
   * que sigue cayendo en `pausada`/`unassigned` de siempre.
   */
  it("con ai_enabled=false en el chat, no corre nada y no deja ningún evento en el registro", async () => {
    const info = vi.spyOn(log, "info");
    const warn = vi.spyOn(log, "warn");
    const error = vi.spyOn(log, "error");
    state.conversation = { ...state.conversation, ai_enabled: false };

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  /**
   * T4, "Seba atiende el mostrador" (18/9/2026, D2): con asesor asignado y
   * `ai_enabled: false` (el mismo evento que apaga el trigger de la
   * migración 20260917010000 cuando el asesor escribe de verdad), el turno
   * sigue cortando — la fusión de las dos guardas viejas no cambió ESTE
   * comportamiento, solo el caso "asignado + IA encendida" (ver más abajo).
   */
  it("con asesor asignado y ai_enabled=false, no corre nada (traspaso 'asignada' en handoffs.test.ts)", async () => {
    state.conversation = { ...state.conversation, ai_enabled: false, assigned_agent_id: "agent-9" };

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * El cambio central de T4 (D2, requisito 6 del cliente): asignado + IA
   * ENCENDIDA ya NO corta el turno. Antes de esta corrida `assigned_agent_id`
   * por sí solo bastaba para silenciar a la IA (anexo A2, 5/9/2026); con la
   * escalada sin apagar `ai_enabled`, Seba tiene que seguir respondiendo en
   * un chat ya asignado hasta que el asesor escriba de verdad. La salida
   * final lleva `is_auto_reply: true` — el cliente le sigue hablando a Seba,
   * no a la persona que espera.
   */
  it("con asesor asignado y ai_enabled=true, el turno CORRE y la respuesta final sale is_auto_reply", async () => {
    state.conversation = { ...state.conversation, ai_enabled: true, assigned_agent_id: "agent-9" };

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "respuesta redactada por el modelo",
      expect.objectContaining({ isAutoReply: true })
    );
    // Ningún traspaso de apertura: el turno no se calló en ningún guardián.
    expect(handoffCalls).toHaveLength(0);
  });

  /**
   * `journey_stage` no puede caer a `null` a mitad de turno en un chat
   * asignado: la píldora "Escaladas" de la bandeja mira ese campo CRUDO
   * (`inbox-filters.ts`), sin cruzarlo con `ai_enabled`. `stageFor`
   * (agent.ts) hace que las seis escrituras de la etapa devuelvan siempre
   * `"assigned"` cuando hay dueño — acá se comprueba la del final del turno.
   */
  it("con asesor asignado, journey_stage queda 'assigned' al terminar el turno, nunca null", async () => {
    state.conversation = { ...state.conversation, ai_enabled: true, assigned_agent_id: "agent-9" };

    await runAgentTurn("conv-1");

    expect(conversationUpdates.some((u) => u.journey_stage === null)).toBe(false);
    expect(conversationUpdates).toContainEqual({ journey_stage: "assigned", active_tool: null });
  });

  /**
   * Mutación de verificación (resguardo antes del push, 20/9/2026, tarea
   * M1/T3-a: "`stageFor` revertido solo en 'classifying'/'tool_running'" de
   * la lista de sospechosas). El test de arriba solo mira el RESETEO final
   * (`stageFor(assignedAgentId, null)`); nunca comprobaba la escritura de
   * ARRANQUE de la clasificación (`stageFor(convo.assigned_agent_id,
   * "classifying")`, agent.ts). Escribir el literal `"classifying"` ahí en
   * vez de pasar por `stageFor` no rompía ningún test: el reseteo final
   * seguía dejando "assigned" igual, tapando el hueco de en medio. (La
   * escritura gemela de `"tool_running"` vive dentro de
   * `onToolExecutionStart` del `ToolLoopAgent` real, que el mock de este
   * archivo no invoca nunca — queda fuera del alcance de esta suite, no de
   * esta corrección.)
   */
  it("con asesor asignado, la escritura al empezar a clasificar tampoco deja el literal 'classifying'", async () => {
    state.conversation = { ...state.conversation, ai_enabled: true, assigned_agent_id: "agent-9" };

    await runAgentTurn("conv-1");

    expect(conversationUpdates.some((u) => u.journey_stage === "classifying")).toBe(false);
    expect(conversationUpdates).toContainEqual({ journey_stage: "assigned", active_tool: null });
  });

  /**
   * Un contacto sin teléfono utilizable —borrado entre la consulta y la
   * respuesta, o con un dato corrupto— es la identidad rota que buildTurnTarget
   * corta antes de que el turno corra entero para terminar en una llamada a
   * Meta con destinatario vacío. No se reintenta: una identidad rota no se
   * arregla sola, así que sale como NonRetryableTurnError.
   */
  it("si la identidad del turno no se puede verificar, no envía nada y sale como NonRetryableTurnError", async () => {
    const error = vi.spyOn(log, "error");
    state.conversation = { ...state.conversation, contact: { phone_number: "" } };

    await expect(runAgentTurn("conv-1")).rejects.toMatchObject({
      name: "NonRetryableTurnError",
      conversationId: "conv-1",
    });

    expect(error).toHaveBeenCalledWith(
      "turno_identidad_no_verificable",
      expect.objectContaining({ conversationId: "conv-1" })
    );
    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });
});

/**
 * Tarea 3, "La IA no vuelve a pedir lo que ya pidió" (16/9/2026). Caso real:
 * un cliente pide un asesor -> la IA escala y se despide ("te paso con un
 * asesor") -> un asesor desasigna y reactiva la IA a mano -> en menos de un
 * minuto el reconciliador reencola la conversación, y el turno corría sobre
 * el MISMO mensaje viejo, repitiendo la promesa. Reemplaza a la guarda
 * `awaiting_any_reply` del 15/9 (descartada: comparaba contra la última
 * SALIDA y por eso sufría la carrera de ráfaga — ver el Enfoque del plan del
 * 16/9). Corre ANTES de `humanHasWritten` (la guarda de abajo) y antes de
 * fase 0/clasificar: `matchPlaybookMock`/`classifyIntentMock` no deben
 * llamarse cuando esta guarda dispara.
 */
describe("runAgentTurn — no contesta lo que llegó antes de la devolución (Tarea 3, 16/9/2026)", () => {
  it("con last_customer_message_at igual al sello (el borde: la igualdad cuenta como previo), no llama a fase 0 ni al modelo, no envía nada y deja el traspaso mensaje_previo_a_devolucion a unassigned", async () => {
    const info = vi.spyOn(log, "info");
    // Reciente (no una fecha fija) para no chocar con `withinFreeformWindow`
    // -- esta guarda corre antes que esa, pero un `last_customer_message_at`
    // de hace más de 24 h sería un dato incoherente en la fila real.
    const sello = new Date(Date.now() - 60_000).toISOString();
    state.conversation = {
      ...state.conversation,
      ai_resume_cutoff_at: sello,
      last_customer_message_at: sello,
    };

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "mensaje_previo_a_devolucion",
    });
    expect(info).toHaveBeenCalledWith("turno_mensaje_previo_a_devolucion", { conversationId: "conv-1" });
  });

  /**
   * Mutación de verificación (resguardo antes del push, 20/9/2026, tarea
   * M1/T3-a: "orden `pausada`→sello" de la lista de sospechosas). El
   * comentario del código dice "Va DESPUÉS de `pausada`: con la IA apagada
   * en este chat, esa es la razón más específica y tiene que ganar aunque
   * también calce esta" -- pero hasta esta tarea ningún test tenía las DOS
   * condiciones a la vez (`ai_enabled=false` Y el sello cumplido) para
   * comprobarlo. Sin este test, invertir el orden de los dos `if` en
   * `agent.ts` no rompía nada: la conversación quedaba con el traspaso
   * `mensaje_previo_a_devolucion` en vez de `pausada`, la razón MENOS
   * específica ganando sobre la más específica.
   */
  it("con la IA apagada Y el sello cumplido a la vez, gana pausada (la razón más específica), no mensaje_previo_a_devolucion", async () => {
    const sello = new Date(Date.now() - 60_000).toISOString();
    state.conversation = {
      ...state.conversation,
      ai_enabled: false,
      assigned_agent_id: null,
      ai_resume_cutoff_at: sello,
      last_customer_message_at: sello,
    };

    await runAgentTurn("conv-1");

    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "pausada",
    });
  });

  it("con last_customer_message_at posterior al sello, el turno redacta y envía aunque el historial ya traiga una salida de la IA fechada después (la forma de la carrera de ráfaga no lo calla)", async () => {
    // A diferencia de la guarda vieja (`awaiting_any_reply`, comparaba
    // contra la última SALIDA hacia el cliente), esta guarda solo mira
    // cuándo se devolvió el chat: que ya haya salido una respuesta de la IA
    // fechada después del mensaje del cliente no importa, porque el sello no
    // se mueve con salidas.
    state.conversation = {
      ...state.conversation,
      ai_resume_cutoff_at: new Date(Date.now() - 60_000).toISOString(),
      last_customer_message_at: new Date(Date.now() - 55_000).toISOString(),
    };
    state.history = [
      { sender_type: "customer", content: "hola quiero accesorios", is_internal_note: false },
      { sender_type: "ai", content: "¡Claro! ¿Qué accesorio buscas?", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(handoffCalls.some((c) => c.p_reason === "mensaje_previo_a_devolucion")).toBe(false);
  });

  it("sin sello (ai_resume_cutoff_at=null, el caso normal: nunca hubo una devolución manual), el turno sigue el camino de siempre", async () => {
    state.conversation = { ...state.conversation, ai_resume_cutoff_at: null };

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(handoffCalls.some((c) => c.p_reason === "mensaje_previo_a_devolucion")).toBe(false);
  });
});

/**
 * Tarea 4, "La voz cercana y la espera visible" (14/9/2026), decisión 4: no
 * se despide de quien ya está esperando a un asesor. Corre ANTES de fase 0 —
 * `matchPlaybookMock`/`classifyIntentMock` no deben llamarse cuando la guarda
 * dispara.
 */
describe("runAgentTurn — guarda de cortesía tras una escalada abierta (Tarea 4, 14/9/2026)", () => {
  it("'Ok, muchas gracias' con una escalada abierta y sin asesor asignado: se calla, deja traspaso a 'unassigned'", async () => {
    const info = vi.spyOn(log, "info");
    state.history = [{ sender_type: "customer", content: "Ok, muchas gracias", is_internal_note: false }];
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-14T10:00:00.000Z" };
    state.agentMessagesAfterHandoff = [];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "cortesia_tras_escalada",
    });
    expect(info).toHaveBeenCalledWith("turno_cortesia_tras_escalada", { conversationId: "conv-1" });
    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({
      action: "answered",
      summary: "Cortesía con escalada abierta: no se respondió.",
      customer_message: "Ok, muchas gracias",
    });
    // journey_stage vuelve a null: no se queda pegado en "classifying".
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
  });

  /**
   * T4, "Seba atiende el mostrador" (18/9/2026, D2): esta rama DEJA de ser
   * defensiva/inalcanzable. La nota vieja (hasta esta corrida) decía que
   * `openTurn` cortaba el turno ANTES de llegar a `runTurnPhases` en cuanto
   * `assigned_agent_id` no era null, sin mirar `ai_enabled` — así que
   * `convo.assigned_agent_id` siempre llegaba `null` a esta guarda. Con D2
   * (la escalada ya no apaga la IA) la guarda de apertura se fusionó en
   * `if (!convo.ai_enabled)`, así que un chat asignado con `ai_enabled:
   * true` SÍ corre `runTurnPhases` completo, y esta rama —pedida tal cual
   * por el plan desde el 14/9/2026— por fin es alcanzable.
   */
  it("'Ok, muchas gracias' con una escalada abierta y CON asesor asignado: se calla, deja traspaso a 'human' con su toId", async () => {
    const info = vi.spyOn(log, "info");
    state.conversation = { ...state.conversation, ai_enabled: true, assigned_agent_id: "agent-9" };
    state.history = [{ sender_type: "customer", content: "Ok, muchas gracias", is_internal_note: false }];
    state.lastHandoffRow = { reason: "escalada", created_at: "2026-09-14T10:00:00.000Z" };
    state.agentMessagesAfterHandoff = [];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "human",
      p_to_id: "agent-9",
      p_reason: "cortesia_tras_escalada",
    });
    expect(info).toHaveBeenCalledWith("turno_cortesia_tras_escalada", { conversationId: "conv-1" });
    // journey_stage: un chat asignado nunca cae a null, queda "assigned"
    // (stageFor, agent.ts) — la píldora "Escaladas" no lo pierde.
    expect(conversationUpdates).toContainEqual({ journey_stage: "assigned", active_tool: null });
  });

  it("mismo mensaje, pero un asesor YA escribió después de la escalada: turno normal", async () => {
    state.history = [{ sender_type: "customer", content: "Ok, muchas gracias", is_internal_note: false }];
    state.lastHandoffRow = { reason: "escalada", created_at: "2026-09-14T10:00:00.000Z" };
    state.agentMessagesAfterHandoff = [{ id: "msg-asesor-1" }];

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(handoffCalls.some((c) => c.p_reason === "cortesia_tras_escalada")).toBe(false);
  });

  /**
   * Reescrito el 22-23/9/2026 (T5, plan "Seba no habla de más mientras el
   * cliente espera al asesor", opción (b) del operador): hasta esta tarea
   * "turno normal" significaba tool loop + clasificación + `sendAgentText`.
   * Con la escalada ya abierta eso dejó de ser el flujo genérico — ahora
   * "rines 17" no calza ningún escenario informativo, así que cae en la
   * nota interna del camino "espera abierta" (agent.ts). Lo que este test
   * protege sigue siendo lo mismo: la guarda de cortesía de arriba (que
   * calla el turno entero) NO se traga una pregunta real — acá se ve en que
   * NO deja `cortesia_tras_escalada` y en que la pregunta le llega al
   * asesor (como nota), no que se pierde.
   */
  it("'gracias, y ¿tienen rines 17?' no es solo cortesía: la pregunta real llega al asesor por nota, aunque la escalada siga abierta", async () => {
    state.history = [
      { sender_type: "customer", content: "gracias, y ¿tienen rines 17?", is_internal_note: false },
    ];
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-14T10:00:00.000Z" };
    state.agentMessagesAfterHandoff = [];

    await runAgentTurn("conv-1");

    expect(handoffCalls.some((c) => c.p_reason === "cortesia_tras_escalada")).toBe(false);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(messageInserts).toHaveLength(1);
    expect(messageInserts[0].content).toContain("gracias, y ¿tienen rines 17?");
  });

  it("mensaje de cortesía pero SIN ninguna escalada previa: turno normal", async () => {
    state.history = [{ sender_type: "customer", content: "gracias", is_internal_note: false }];
    state.lastHandoffRow = null;

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(handoffCalls.some((c) => c.p_reason === "cortesia_tras_escalada")).toBe(false);
  });
});

/**
 * T5, plan "Seba no habla de más mientras el cliente espera al asesor"
 * (22-23/9/2026, opción (b) del operador, "un solo acuse por espera").
 * Medido en producción el 22/9/2026: 27 % de los mensajes de Seba salían
 * con una escalada abierta, la mayoría puro relleno ("el asesor ya tiene
 * tu caso"), hasta 6 en la misma espera (caso SBR, ver el plan). Con la
 * escalada YA abierta (`escalationOpen`) y algo pendiente que la guarda de
 * cortesía de arriba no se tragó, `runTurnPhases` deja de correr el tool
 * loop y la clasificación: solo puede contestar con un escenario
 * INFORMATIVO ya calzado por `matchPlaybook`, o anotar lo pendiente para
 * el asesor sin mandarle nada nuevo al cliente.
 */
describe("runAgentTurn — camino 'espera abierta' con escalada abierta (T5, 22-23/9/2026)", () => {
  it("'Y luces traseras de cruce' sin ningún escenario que calce: no corre el tool loop ni clasifica, no hay sendAgentText, y se inserta una nota con el texto — agent_turns queda 'skipped'", async () => {
    state.history = [{ sender_type: "customer", content: "Y luces traseras de cruce", is_internal_note: false }];
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-22T09:14:26.000Z" };
    state.agentMessagesAfterHandoff = [];

    await runAgentTurn("conv-1");

    expect(generateMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(messageInserts).toHaveLength(1);
    expect(messageInserts[0]).toMatchObject({
      conversation_id: "conv-1",
      direction: "outbound",
      sender_type: "system",
      is_internal_note: true,
    });
    expect(messageInserts[0].content).toContain("Y luces traseras de cruce");
    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({ action: "skipped" });
    // Sin traspaso: el dueño no cambia, la nota es el rastro (ver el
    // comentario de esta rama en agent.ts contra "ningún lead invisible").
    expect(handoffCalls).toHaveLength(0);
  });

  it("'¿Dónde están ubicados?' con un escenario 'Ubicación' que calza: sale con is_auto_reply", async () => {
    const ubicacion = playbook({
      id: "pb-ubicacion",
      name: "Ubicación",
      responseText: "Estamos ubicados en la Av. Los Próceres, Barinas.",
    });
    fetchActivePlaybooksMock.mockResolvedValue([ubicacion]);
    matchPlaybookMock.mockResolvedValue({ playbook: ubicacion, usage: NO_USAGE });
    state.history = [{ sender_type: "customer", content: "¿Dónde están ubicados?", is_internal_note: false }];
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-22T09:14:26.000Z" };
    state.agentMessagesAfterHandoff = [];

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(sendPlaybookReplyMock.mock.calls[0][2]).toEqual(ubicacion);
    expect(sendPlaybookReplyMock.mock.calls[0][4]).toEqual({ isAutoReply: true });
    // Sin nota: el cliente SÍ recibió respuesta, no hace falta avisarle al
    // asesor que algo quedó pendiente.
    expect(messageInserts).toHaveLength(0);
  });

  it("el escenario de despedida y uno con after_send = escalate NO llegan como candidatos a matchPlaybook", async () => {
    const despedida = playbook({
      id: "pb-gracias",
      name: "Gracias",
      responseText: "¡Muchas gracias por preferirnos!🥰 Esperamos poder servirte nuevamente.🎊",
    });
    const reclamoQueEscala = playbook({
      id: "pb-reclamo",
      name: "Reclamo",
      responseText: "Vamos a revisar tu caso con el equipo.",
      afterSend: "escalate",
    });
    const ubicacion = playbook({
      id: "pb-ubicacion",
      name: "Ubicación",
      responseText: "Estamos ubicados en la Av. Los Próceres, Barinas.",
    });
    fetchActivePlaybooksMock.mockResolvedValue([despedida, reclamoQueEscala, ubicacion]);
    matchPlaybookMock.mockResolvedValue({ playbook: null, usage: NO_USAGE });
    state.history = [{ sender_type: "customer", content: "Y luces traseras de cruce", is_internal_note: false }];
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-22T09:14:26.000Z" };
    state.agentMessagesAfterHandoff = [];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).toHaveBeenCalledTimes(1);
    const candidatos = matchPlaybookMock.mock.calls[0][1] as Playbook[];
    expect(candidatos.map((p) => p.id)).toEqual(["pb-ubicacion"]);
  });

  /**
   * Secuencia EXACTA del caso SBR medido en producción el 22/9/2026 (ver el
   * plan): tres fragmentos del cliente después de escalar, cada uno en su
   * propio turno de la cola. Sin marca previa en Redis (T1), cada turno deja
   * su propia marca "visto hasta" al terminar (`marcarTurnoVisto`, llamada
   * también en la rama de nota) — por eso el historial de cada turno trae
   * `created_at`/`id`: sin fecha parseable la marca no se escribe y el turno
   * siguiente volvería a ver el fragmento ya anotado.
   */
  it("los tres fragmentos del caso SBR, uno por turno: cero mensajes al cliente y tres notas", async () => {
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-22T09:14:26.000Z" };
    state.agentMessagesAfterHandoff = [];
    matchPlaybookMock.mockResolvedValue({ playbook: null, usage: NO_USAGE });

    // Turno 1: "Y luces traseras de cruce" (09:14:30), del más nuevo al más
    // viejo, como se leen del historial.
    state.history = [
      {
        sender_type: "customer",
        content: "Y luces traseras de cruce",
        is_internal_note: false,
        created_at: "2026-09-22T09:14:30.000Z",
        id: "m-luces",
      },
      {
        sender_type: "customer",
        content: "El guarda fango trasero con su tapa negra",
        is_internal_note: false,
        created_at: "2026-09-22T09:14:22.000Z",
        id: "m-guardafango-1",
      },
      {
        sender_type: "customer",
        content: "Cuánto cuesta la parrilla de sbr",
        is_internal_note: false,
        created_at: "2026-09-22T09:14:11.000Z",
        id: "m-parrilla",
      },
    ];
    await runAgentTurn("conv-1");

    // Turno 2: "El guarda fango si puede azul oscuro brillante" (09:15:15).
    state.history = [
      {
        sender_type: "customer",
        content: "El guarda fango si puede azul oscuro brillante",
        is_internal_note: false,
        created_at: "2026-09-22T09:15:15.000Z",
        id: "m-guardafango-2",
      },
      ...state.history,
    ];
    await runAgentTurn("conv-1");

    // Turno 3: "¿Cuánto sale el envío a Barinas?" (09:15:40).
    state.history = [
      {
        sender_type: "customer",
        content: "¿Cuánto sale el envío a Barinas?",
        is_internal_note: false,
        created_at: "2026-09-22T09:15:40.000Z",
        id: "m-envio",
      },
      ...state.history,
    ];
    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(messageInserts).toHaveLength(3);
    expect(messageInserts[0].content).toContain("Y luces traseras de cruce");
    expect(messageInserts[1].content).toContain("El guarda fango si puede azul oscuro brillante");
    expect(messageInserts[2].content).toContain("¿Cuánto sale el envío a Barinas?");
  });

  it("si falla el insert de la nota, el turno lanza y no se escribe la marca 'visto hasta'", async () => {
    state.history = [
      {
        sender_type: "customer",
        content: "Y luces traseras de cruce",
        is_internal_note: false,
        created_at: "2026-09-22T09:14:30.000Z",
        id: "m-luces",
      },
    ];
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-22T09:14:26.000Z" };
    state.agentMessagesAfterHandoff = [];
    matchPlaybookMock.mockResolvedValue({ playbook: null, usage: NO_USAGE });
    state.noteInsertError = { message: "conexión perdida" };

    await expect(runAgentTurn("conv-1")).rejects.toThrow(/nota de espera/);

    expect(redisSeenStore.has("turno:visto:conv-1")).toBe(false);
    expect(agentTurnInserts).toHaveLength(0);
  });

  it("sin escalada abierta, un mensaje real sigue el flujo genérico de siempre (tool loop y clasificación)", async () => {
    state.history = [{ sender_type: "customer", content: "Y luces traseras de cruce", is_internal_note: false }];
    state.lastHandoffRow = null;

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(messageInserts).toHaveLength(0);
  });
});

/**
 * Tarea 6, "La voz cercana y la espera visible" (14/9/2026), decisión 5: 494
 * fotos y 117 audios en 72 h, la IA repitiendo "¿qué repuesto buscas?" hasta
 * 10 veces. Corre ANTES de fase 0 y de clasificar — `matchPlaybookMock`/
 * `classifyIntentMock` no deben llamarse cuando la guarda dispara.
 *
 * El historial se escribe DESCENDENTE (más reciente primero), igual que el
 * resto del archivo — `loadHistory` lo invierte a cronológico antes de que
 * `mediaStreakWithoutText` lo lea.
 */
describe("runAgentTurn — al segundo adjunto sin texto, la IA pasa el caso (Tarea 6, 14/9/2026)", () => {
  it("(a) foto → la IA pregunta → foto: escala con 'seguimiento' y manda DESPEDIDA_MEDIA con is_auto_reply", async () => {
    state.history = [
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "image" },
      { sender_type: "ai", content: "¿De qué moto es el repuesto que buscas?", is_internal_note: false },
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "image" },
    ];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(escalateConversationMock.mock.calls[0][1]).toMatchObject({
      conversationId: "conv-1",
      contactId: "contact-1",
      motivo: "seguimiento",
      businessHours: DEFAULT_BUSINESS_HOURS,
    });
    expect((escalateConversationMock.mock.calls[0][1] as { resumen: string }).resumen).toContain("2 adjuntos");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      DESPEDIDA_MEDIA,
      { isAutoReply: true }
    );

    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({ intent: null, action: "escalated" });
  });

  it("(b) foto → foto, SIN que la IA haya respondido en medio: turno normal", async () => {
    state.history = [
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "image" },
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "image" },
    ];

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });

  it("(c) sticker → sticker: un sticker no es un pedido, turno normal", async () => {
    state.history = [
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "sticker" },
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "sticker" },
    ];

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).toHaveBeenCalled();
  });

  it("(d) DESPEDIDA_MEDIA pasa la guarda de identidad", () => {
    expect(revealsIdentity(DESPEDIDA_MEDIA)).toBeNull();
  });
});

describe("runAgentTurn — escenarios predeterminados", () => {
  /**
   * Lo que el escenario ahorra es la parte cara: redactar con el tool loop.
   *
   * La clasificación de intención ya no se ahorra, y es a propósito — sale en
   * paralelo con el reconocimiento de escenario para no encadenar dos esperas
   * de dos segundos. En el camino de escenario esa llamada se desperdicia; son
   * unos centavos a cambio de dos segundos en TODOS los turnos.
   */
  it("cuando un escenario coincide, responde con él y no llama al modelo redactor", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(sendPlaybookReplyMock.mock.calls[0][2]).toEqual(pb);
    expect(generateMock).not.toHaveBeenCalled();
  });

  /**
   * El escenario se manda una vez, no una por mensaje.
   *
   * El reconocimiento mira el hilo entero y elige el escenario que calza con
   * la conversación, así que mientras se siga hablando del catálogo el mismo
   * escenario vuelve a ganar en cada turno. Sin guarda, el cliente recibía el
   * mismo texto una y otra vez: preguntaba algo, le llegaba otra vez el
   * catálogo, repreguntaba, y otra vez.
   *
   * Es la misma guarda que ya tenía la redirección de fuera de tema, con la
   * misma regla: si nuestra última respuesta fue ESA, no se repite.
   */
  it("no repite el escenario que acaba de mandar: sigue por el flujo genérico", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    // Del más nuevo al más viejo, como los devuelve la consulta.
    state.history = [
      { sender_type: "customer", content: "y tienen para una AX100?", is_internal_note: false },
      { sender_type: "ai", content: pb.responseText, is_internal_note: false },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    // No se queda callado: el cliente preguntó algo y el turno lo contesta.
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  /**
   * El caso que la guarda del historial NO alcanza a ver, y que es justo el
   * que produce el bucle.
   *
   * Frenar el escenario hace que el turno caiga al flujo genérico y conteste
   * con otra cosa. En el turno siguiente, nuestra última respuesta ya no es el
   * catálogo sino esa otra cosa — así que el historial dice "no lo mandé" y el
   * escenario vuelve a salir. Catálogo, genérico, catálogo, genérico. La
   * ventana de seis horas es la que corta eso, porque no mira la última
   * respuesta sino si el escenario salió hace poco.
   */
  it("no lo manda si ya salió hace poco, aunque en el medio hayamos dicho otra cosa", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    playbookSentRecentlyMock.mockResolvedValue(true);
    // Del más nuevo al más viejo, como los devuelve la consulta.
    state.history = [
      { sender_type: "customer", content: "Talla s", is_internal_note: false },
      { sender_type: "ai", content: "Tenemos varios modelos, ¿cuál te interesa?", is_internal_note: false },
      { sender_type: "customer", content: "Precio y si hay talla s", is_internal_note: false },
      { sender_type: "ai", content: pb.responseText, is_internal_note: false },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    // Y el cliente no se queda sin respuesta: contesta el flujo genérico.
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("pregunta por la ventana con el escenario y la conversación de este turno", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(playbookSentRecentlyMock).toHaveBeenCalledWith(expect.anything(), "conv-1", pb.id);
  });

  /**
   * La consulta cuesta un viaje a la base y el historial ya está en memoria:
   * si el propio hilo ya delata la repetición, no hace falta preguntar.
   */
  it("no gasta la consulta cuando el historial ya delata la repetición", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    state.history = [
      { sender_type: "customer", content: "y tienen para una AX100?", is_internal_note: false },
      { sender_type: "ai", content: pb.responseText, is_internal_note: false },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(playbookSentRecentlyMock).not.toHaveBeenCalled();
  });

  /**
   * Ninguna de las dos redes es "una vez por conversación". Pasada la ventana,
   * el cliente que vuelve a pedir el catálogo lo está pidiendo de verdad y
   * tiene que recibirlo —con su adjunto, que es lo único que el flujo
   * genérico no sabe mandar—.
   */
  it("fuera de la ventana sí lo manda de nuevo", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    state.history = [
      { sender_type: "customer", content: "me lo pasas otra vez?", is_internal_note: false },
      { sender_type: "ai", content: "Sí, tenemos ese filtro en stock.", is_internal_note: false },
      { sender_type: "customer", content: "tienen filtro de aceite?", is_internal_note: false },
      { sender_type: "ai", content: pb.responseText, is_internal_note: false },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Con adjunto de tipo enlace, lo que sale por WhatsApp es el texto MÁS la
   * URL pegada abajo — eso es lo que queda guardado en el historial, y es
   * contra eso que hay que comparar. Comparando solo contra `responseText`,
   * la guarda no reconocía su propio mensaje y el catálogo salía otra vez.
   */
  it("reconoce su mensaje aunque el escenario lleve un enlace pegado", async () => {
    const pb = playbook({
      attachmentType: "link",
      attachmentUrl: "https://sbk.example/catalogo",
    });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    state.history = [
      { sender_type: "customer", content: "gracias!", is_internal_note: false },
      {
        sender_type: "ai",
        content: `${pb.responseText}\n\n${pb.attachmentUrl}`,
        is_internal_note: false,
      },
      { sender_type: "customer", content: "me pasas el catálogo?", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  it("clasifica en paralelo en vez de esperar a saber si hay escenario", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
  });

  /**
   * El riesgo de lanzarlas juntas: clasificar SÍ lanza ante un fallo del
   * proveedor, y su excepción no puede llevarse por delante un escenario que
   * el otro brazo reconoció perfectamente. En serie no podía pasar —el
   * escenario ya había ganado el turno—, así que es un modo de fallo nuevo.
   */
  it("un fallo al clasificar no tumba el escenario que sí se reconoció", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    classifyIntentMock.mockRejectedValue(new Error("429 del proveedor"));

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(agentTurnInserts[0]).toMatchObject({ playbook_id: "pb-1", action: "answered" });
  });

  it("registra en la bitácora qué escenario resolvió el turno y con qué mensaje del cliente", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({
      playbook_id: "pb-1",
      customer_message: "hola quiero accesorios",
      action: "answered",
      // Escenario + clasificación: la segunda ya se pagó aunque su resultado
      // no se use, y el panel de gasto tiene que verla.
      total_tokens: 10,
    });
  });

  it("un escenario con after_send 'escalate' pasa la conversación a un asesor", async () => {
    const pb = playbook({ afterSend: "escalate", name: "Guía de envío · Cashea" });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(escalateConversationMock.mock.calls[0][1]).toMatchObject({
      conversationId: "conv-1",
      motivo: "seguimiento",
      // Frente B4 (5/9/2026): el camino de escenario también enhebra el
      // horario hasta escalateConversation, no solo el tool loop genérico —
      // sin esto la despedida de un escenario sin asesores no podría decir
      // cuándo abre la tienda.
      businessHours: DEFAULT_BUSINESS_HOURS,
    });
    expect(agentTurnInserts[0]).toMatchObject({ action: "escalated" });
  });

  it("un escenario con after_send 'wait' deja la conversación libre, sin escalar", async () => {
    const pb = playbook({ afterSend: "wait" });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(conversationUpdates).toContainEqual(expect.objectContaining({ journey_stage: null }));
  });

  /**
   * T0.3: hasta ahora un rechazo de Meta en el camino de escenario no frenaba
   * nada — el turno etiquetaba, escalaba (si tocaba) y escribía `agent_turns`
   * como si el cliente hubiera recibido el catálogo, aunque `messages` ya
   * dijera `whatsapp_status: 'failed'`. Con la respuesta del tool loop se
   * cubre en `handoffs.test.ts`; esto cierra el otro consumidor nombrado en
   * el plan.
   *
   * A3 (5/9/2026): además, `rejectedByMeta` ahora limpia `journey_stage`/
   * `active_tool` — sin eso, esta conversación se quedaba pintada
   * "Clasificando" en el tablero de Atascados para siempre, porque el
   * `return` salía antes de que el escenario llegara a resetear su propia
   * etapa.
   */
  it("rechazado_por_meta: el escenario sale rechazado por Meta, no se etiqueta ni se escala", async () => {
    const warn = vi.spyOn(log, "warn");
    const pb = playbook({
      afterSend: "escalate",
      tags: [{ id: "tag-envio", label: "Envio", color: "accent" as const }],
    });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    sendPlaybookReplyMock.mockImplementation(async () => ({
      whatsapp_message_id: null,
      whatsapp_status: "failed" as const,
      whatsapp_error_code: 131047,
      whatsapp_error_detail: "Meta rechazó el envío",
      origenDelFallo: "meta" as const,
    }));

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    // Ni la etiqueta ni el escalamiento acompañan a un mensaje que no salió.
    expect(contactTagUpserts).toHaveLength(0);
    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(agentTurnInserts).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("turno_rechazado_por_meta", {
      conversationId: "conv-1",
      codigo: 131047,
    });
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "rechazado_por_meta",
    });
    // La etapa no se queda congelada en "classifying": el rechazo la libera
    // igual que lo haría una respuesta que sí hubiera salido.
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
  });

  it("sin escenarios cargados, el turno sigue por el flujo genérico de siempre", async () => {
    fetchActivePlaybooksMock.mockResolvedValue([]);

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });

  it("cuando ningún escenario coincide, suma los tokens del reconocimiento a los del turno", async () => {
    fetchActivePlaybooksMock.mockResolvedValue([playbook()]);
    matchPlaybookMock.mockResolvedValue({ playbook: null, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(generateMock).toHaveBeenCalledTimes(1);
    // 4 (reconocimiento) + 6 (clasificación) + 28 (redacción)
    expect(agentTurnInserts[0]).toMatchObject({ total_tokens: 38, playbook_id: null });
  });

  it("no reconoce escenarios si la IA está apagada globalmente", async () => {
    state.aiGloballyEnabled = false;
    fetchActivePlaybooksMock.mockResolvedValue([playbook()]);

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * El tope de gasto vive en la base (agent_can_run) para que la respuesta
   * sea la misma sin importar quién pregunte. Alcanzado el tope, el turno no
   * llama al modelo: ni para reconocer escenario ni para clasificar.
   */
  it("no corre el turno cuando ya se alcanzó el tope de gasto del día", async () => {
    state.canRun = false;
    fetchActivePlaybooksMock.mockResolvedValue([playbook()]);

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  /**
   * T4, "Seba atiende el mostrador" (18/9/2026, D2): hasta esta corrida un
   * chat ya asignado ni siquiera llegaba a fase 0 — la apertura de
   * `runAgentTurn` cortaba el turno en cuanto veía `assigned_agent_id`, sin
   * mirar `ai_enabled` (anexo A2, 5/9/2026). Con la escalada sin apagar la
   * IA, Seba sigue reconociendo escenarios en un chat asignado: el título
   * viejo ("no reconoce escenarios si la conversación ya tiene un asesor
   * asignado") describía justo lo contrario de lo que el requisito 6 del
   * cliente pide. `runPlaybook` marca `is_auto_reply: true` desde el mismo
   * envío (`esperandoAsesor`, ver `send.ts`), porque el cliente le sigue
   * hablando a Seba, no a la persona que espera.
   */
  it("un escenario reconocido en un chat YA asignado SÍ se manda, marcado is_auto_reply", async () => {
    state.conversation = { ...state.conversation, ai_enabled: true, assigned_agent_id: "agent-9" };
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).toHaveBeenCalled();
    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    // T3, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026):
    // `sendPlaybookReply` gana el parámetro `links` entre `playbook` y `opciones`.
    expect(sendPlaybookReplyMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), pb, [], {
      isAutoReply: true,
    });
  });

  /**
   * Anexo B2 (5/9/2026): un escenario con `afterSend: "escalate"` manda su
   * texto ANTES de escalar (T0.3 exige ese orden: nada acompaña a un mensaje
   * que Meta ya rechazó), así que sale con `is_auto_reply = false` sin saber
   * todavía si iba a hacer falta un asesor. El turno marca ese mensaje con un
   * UPDATE después — el trigger que sumó B1 (migración 20260905070000) es
   * quien recalcula `last_reply_at`/`awaiting_reply` en la base; estos tests
   * solo miran que el UPDATE salga (o no) y con qué filtros.
   *
   * Tarea 5 ("La voz cercana y la espera visible", 14/9/2026): hasta esta
   * tarea el UPDATE solo corría SIN asesor (`result.unassigned`); ahora corre
   * siempre que `result.escalated` —que `escalateConversation` deja en
   * `true` en TODAS sus salidas—, porque la promesa de un asesor tampoco es
   * una respuesta real. El test (b), que hasta acá probaba "con asesor,
   * ningún UPDATE", pasa a probar justo lo contrario.
   */
  describe("anexo B2 + Tarea 5: marca is_auto_reply cuando el escenario escala", () => {
    it("(a) escalate sin asesores: un UPDATE con is_auto_reply true, filtrado por la conversación y por created_at > el último mensaje del cliente", async () => {
      const pb = playbook({ afterSend: "escalate", name: "Guía de envío · Cashea" });
      fetchActivePlaybooksMock.mockResolvedValue([pb]);
      matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
      escalateConversationMock.mockImplementation(async () => {
        pasos.push("escalar");
        return { escalated: true, assignedAgentName: null, unassigned: true };
      });

      await runAgentTurn("conv-1");

      expect(messageUpdates).toHaveLength(1);
      expect(messageUpdates[0].values).toEqual({ is_auto_reply: true });
      expect(messageUpdates[0].filters).toEqual([
        ["conversation_id", "conv-1"],
        ["direction", "outbound"],
        ["sender_type", "ai"],
        ["is_internal_note", false],
        ["created_at", (state.conversation as { last_customer_message_at: string }).last_customer_message_at],
      ]);
    });

    it("(b) escalate CON asesor asignado: el UPDATE corre igual (Tarea 5, 14/9/2026)", async () => {
      const info = vi.spyOn(log, "info");
      const pb = playbook({ afterSend: "escalate", name: "Guía de envío · Cashea" });
      fetchActivePlaybooksMock.mockResolvedValue([pb]);
      matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
      // El beforeEach ya deja escalateConversationMock devolviendo un asesor
      // (María), sin `unassigned`.

      await runAgentTurn("conv-1");

      expect(escalateConversationMock).toHaveBeenCalledTimes(1);
      expect(messageUpdates).toHaveLength(1);
      expect(messageUpdates[0].values).toEqual({ is_auto_reply: true });
      // Renombrado de turno_escenario_sin_asesor_marcado (Tarea 5, 14/9/2026):
      // el evento ya no es exclusivo del caso sin asesor.
      expect(info).toHaveBeenCalledWith(
        "turno_escenario_escalado_marcado",
        expect.objectContaining({ conversationId: "conv-1" })
      );
    });

    it("(c) escenario 'wait' (no escala): ningún UPDATE", async () => {
      const pb = playbook({ afterSend: "wait" });
      fetchActivePlaybooksMock.mockResolvedValue([pb]);
      matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

      await runAgentTurn("conv-1");

      expect(escalateConversationMock).not.toHaveBeenCalled();
      expect(messageUpdates).toHaveLength(0);
    });

    it("(d) el UPDATE falla: log.error con el evento y el turno termina igual (agent_turns con action escalated)", async () => {
      const error = vi.spyOn(log, "error");
      const pb = playbook({ afterSend: "escalate", name: "Guía de envío · Cashea" });
      fetchActivePlaybooksMock.mockResolvedValue([pb]);
      matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
      escalateConversationMock.mockImplementation(async () => {
        pasos.push("escalar");
        return { escalated: true, assignedAgentName: null, unassigned: true };
      });
      state.messageUpdateError = { message: "permiso denegado" };

      await runAgentTurn("conv-1");

      expect(error).toHaveBeenCalledWith("turno_escenario_despedida_no_marcada", {
        conversationId: "conv-1",
        detail: "permiso denegado",
      });
      expect(agentTurnInserts[0]).toMatchObject({ action: "escalated" });
    });

    /**
     * Rama defensiva: en un turno real esto no ocurre —
     * `withinFreeformWindow(convo.last_customer_message_at)` ya exige la
     * fecha para que el turno llegue hasta acá—, pero el tipo de
     * `runPlaybook` la admite. Se fuerza la ventana abierta con
     * `withinFreeformWindowOverride` para poder ejercer la rama sin mentirle
     * a ningún otro test del archivo.
     */
    it("(e) sin last_customer_message_at (forzado): log.warn y no marca nada", async () => {
      const warn = vi.spyOn(log, "warn");
      withinFreeformWindowOverride.fn = () => true;
      const pb = playbook({ afterSend: "escalate", name: "Guía de envío · Cashea" });
      fetchActivePlaybooksMock.mockResolvedValue([pb]);
      matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
      escalateConversationMock.mockImplementation(async () => {
        pasos.push("escalar");
        return { escalated: true, assignedAgentName: null, unassigned: true };
      });
      state.conversation = { ...state.conversation, last_customer_message_at: null };

      await runAgentTurn("conv-1");

      expect(messageUpdates).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith("turno_escenario_sin_fecha_cliente", { conversationId: "conv-1" });
    });
  });
});

/**
 * H1, "Seba atiende el mostrador" (18/9/2026): escenario a mano del 18/9
 * contra la base local — "¿tienen pastillas de freno?" y "tienen pastillas
 * de freno para bera sbr 2020?" calzaron el escenario del panel "Catálogo
 * general" 2 de 2 veces y el turno mandó "Claro que sí, por acá te dejo
 * nuestro catálogo 👇" sin consultar `products`, sin la pregunta de filtro
 * (exigencia 5 del cliente) y sin escalar — `agent_turns.summary` quedó
 * `Escenario "Catálogo general".`. Decisión del operador: "el repuesto
 * manda": con un escenario calzado, si la intención clasificada (que corre
 * en paralelo con fase 0, no después) es `consulta_disponibilidad`, el
 * escenario se cede al tool loop en vez de mandarse.
 *
 * Tarea 3, plan "El catálogo configurado sale siempre" (21/9/2026): H1 solo
 * miraba esa intención, y el reporte de solo lectura de producción del
 * 21/9 midió "CATALOGO CASCOS"/"Catálogo general" como el 30 % de las
 * respuestas de escenario en 15 días — con `buscar_repuesto` APAGADO desde
 * el 25/8/2026, desplegar H1 tal cual habría cedido esos pedidos a un
 * inventario mudo. Ahora hacen falta las CUATRO condiciones de
 * `debeCederAlInventario` (`catalog-request.ts`): la intención, la
 * herramienta del catálogo encendida, que el cliente no haya pedido el
 * catálogo como documento, y que el escenario esté marcado
 * (`cedeAlInventario`). Si la clasificación falló o la intención es otra,
 * el escenario sale como siempre, sin loguear motivo (ni siquiera es un
 * caso de "el repuesto manda"); si la intención SÍ es
 * `consulta_disponibilidad` pero una de las otras tres falla, el escenario
 * también sale tal cual pero deja `escenario_no_cedido` con su motivo,
 * para poder medirlo en producción.
 */
describe("runAgentTurn — el repuesto manda (H1, 18/9/2026 + T3 del 21/9/2026)", () => {
  function conDisponibilidad(mensajeCliente: string) {
    state.history = [{ sender_type: "customer", content: mensajeCliente, is_internal_note: false }];
    classifyIntentMock.mockResolvedValue({
      intent: "consulta_disponibilidad",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
  }

  it("(a) herramienta del catálogo apagada + escenario marcado: sale el escenario, motivo catalogo_apagado", async () => {
    const info = vi.spyOn(log, "info");
    const pb = playbook({ cedeAlInventario: true });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    state.enabledToolKeys = ["buscar_historial_compras", "consultar_biblioteca"]; // sin "buscar_repuesto"
    conDisponibilidad("¿tienen pastillas de freno?");

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(generateMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("escenario_no_cedido", {
      conversationId: "conv-1",
      escenario: pb.name,
      motivo: "catalogo_apagado",
    });
    expect(info).not.toHaveBeenCalledWith("escenario_cedido_al_catalogo", expect.anything());
  });

  it("(b) encendida + marcado + el cliente pidió el catálogo: sale el escenario, motivo cliente_pidio_catalogo", async () => {
    const info = vi.spyOn(log, "info");
    const pb = playbook({ cedeAlInventario: true });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    conDisponibilidad("Me puedes enviar el catálogo de los cascos");

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(generateMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("escenario_no_cedido", {
      conversationId: "conv-1",
      escenario: pb.name,
      motivo: "cliente_pidio_catalogo",
    });
    expect(info).not.toHaveBeenCalledWith("escenario_cedido_al_catalogo", expect.anything());
  });

  it("(c) encendida + escenario NO marcado: sale el escenario, motivo escenario_no_marcado", async () => {
    const info = vi.spyOn(log, "info");
    const pb = playbook(); // cedeAlInventario: false, el default
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    conDisponibilidad("Hola precios de los cascos");

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(generateMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("escenario_no_cedido", {
      conversationId: "conv-1",
      escenario: pb.name,
      motivo: "escenario_no_marcado",
    });
    expect(info).not.toHaveBeenCalledWith("escenario_cedido_al_catalogo", expect.anything());
  });

  it("(d) encendida + marcado + sin pedir el catálogo: cede, no manda el escenario, corre el tool loop y deja el log", async () => {
    const info = vi.spyOn(log, "info");
    const pb = playbook({ cedeAlInventario: true });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    conDisponibilidad("¿tienen pastillas de freno?");

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    // El camino de escenario ahorra justo esto (ver el test de arriba "no
    // llama al modelo redactor"); acá el ahorro no aplica porque el turno
    // sigue por el flujo genérico — el tool loop SÍ corre.
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("escenario_cedido_al_catalogo", {
      conversationId: "conv-1",
      escenario: pb.name,
    });
    expect(info).not.toHaveBeenCalledWith("escenario_no_cedido", expect.anything());
  });

  it("escenario calzado + intención otro: se manda el escenario como siempre, sin loguear motivo", async () => {
    const info = vi.spyOn(log, "info");
    const pb = playbook({ cedeAlInventario: true });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    classifyIntentMock.mockResolvedValue({
      intent: "otro",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(generateMock).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalledWith("escenario_cedido_al_catalogo", expect.anything());
    expect(info).not.toHaveBeenCalledWith("escenario_no_cedido", expect.anything());
  });

  it("escenario calzado + clasificación fallida: se manda el escenario como siempre, sin loguear motivo", async () => {
    const info = vi.spyOn(log, "info");
    const pb = playbook({ cedeAlInventario: true });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    classifyIntentMock.mockRejectedValue(new Error("429 del proveedor"));

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalledWith("escenario_cedido_al_catalogo", expect.anything());
    expect(info).not.toHaveBeenCalledWith("escenario_no_cedido", expect.anything());
  });
});

describe("runAgentTurn — etiquetas del escenario", () => {
  const ENVIO = { id: "tag-envio", label: "Envio", color: "accent" as const };
  const PENDIENTE = { id: "tag-pendiente", label: "pendiente-venta", color: "warning" as const };

  function conEtiquetas(tags: { id: string; label: string; color: "accent" | "warning" }[], afterSend: "wait" | "escalate" = "wait") {
    const pb = playbook({ tags, afterSend });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    return pb;
  }

  it("etiqueta el contacto con todas las etiquetas del escenario", async () => {
    conEtiquetas([ENVIO, PENDIENTE]);

    await runAgentTurn("conv-1");

    expect(contactTagUpserts).toHaveLength(1);
    expect(contactTagUpserts[0].rows).toEqual([
      { contact_id: "contact-1", tag_id: "tag-envio" },
      { contact_id: "contact-1", tag_id: "tag-pendiente" },
    ]);
  });

  /**
   * El escenario puede dispararse muchas veces con el mismo contacto. Sin
   * esto, cada repetición le pisaría la fecha a una etiqueta que ya estaba.
   */
  it("no pisa una etiqueta que el contacto ya tenía", async () => {
    conEtiquetas([ENVIO]);

    await runAgentTurn("conv-1");

    expect(contactTagUpserts[0].options).toEqual({ ignoreDuplicates: true });
  });

  /**
   * Lo pidió el cliente en estos términos: "etiquetar el chat antes de
   * pasarlo a un asesor". Si el orden se invierte, el asesor abre el caso sin
   * clasificar y lo ve cambiar después.
   */
  it("etiqueta ANTES de escalar, y ambas cosas después de responder", async () => {
    conEtiquetas([ENVIO], "escalate");

    await runAgentTurn("conv-1");

    expect(pasos).toEqual(["responder", "etiquetar", "escalar"]);
  });

  it("un escenario en 'wait' también etiqueta: no hace falta que escale", async () => {
    conEtiquetas([ENVIO], "wait");

    await runAgentTurn("conv-1");

    expect(pasos).toEqual(["responder", "etiquetar"]);
    expect(escalateConversationMock).not.toHaveBeenCalled();
  });

  /** El escenario que existía antes de esta función tiene que seguir funcionando igual. */
  it("un escenario sin etiquetas no toca contact_tags", async () => {
    conEtiquetas([]);

    await runAgentTurn("conv-1");

    expect(contactTagUpserts).toHaveLength(0);
    expect(sendPlaybookReplyMock).toHaveBeenCalledTimes(1);
  });

  /**
   * El mensaje al cliente ya salió cuando esto corre. Un fallo etiquetando no
   * puede impedir que el caso llegue a un humano — eso sería cambiar una
   * marca de color por un cliente sin atender.
   */
  it("si el etiquetado falla, el escalamiento sigue adelante igual", async () => {
    state.tagUpsertError = { message: "permiso denegado" };
    conEtiquetas([ENVIO], "escalate");

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(agentTurnInserts[0].action).toBe("escalated");
  });

  /** Un id en la bitácora no le dice nada a quien la lee: van los nombres. */
  it("deja en la bitácora del turno qué etiquetas puso", async () => {
    conEtiquetas([ENVIO, PENDIENTE]);

    await runAgentTurn("conv-1");

    expect(agentTurnInserts[0].summary).toContain("Etiquetas: Envio, pendiente-venta.");
  });
});

/**
 * La carrera del 27 de agosto de 2026, reconstruida con los tiempos medidos
 * ese día en producción.
 *
 * Conversación c2b0a79b:
 *
 *   16:30:26.892  ASESOR  «Nos queda 1 talla ese»
 *   16:30:29.585  IA      «Catálogo cascos 🪖 …»   ← 2,7 s después, encima
 *
 * `runAgentTurn` preguntaba `humanHasWritten` al ABRIR el turno y no volvía a
 * preguntarlo nunca. Entre esa mirada y el envío pasan de 3 a 10 segundos
 * (`turno_tiempos` de ese día: clasificar 2,2–3,5 s, redactar 3,5–6,5 s,
 * entregar 0,83–1,14 s). El asesor entró justo ahí.
 *
 * El reloj se controla a mano para que los tramos duren lo que duraron: sin
 * eso la prueba diría "el asesor escribió en algún momento", que es una
 * afirmación mucho más débil que "escribió dentro del hueco real".
 */
describe("runAgentTurn — un asesor se mete mientras el turno corre", () => {
  const APERTURA = Date.parse("2026-08-27T16:30:19.900Z");
  /** Fin de la clasificación: 2,2 s, el tramo más rápido que se midió. */
  const FIN_CLASIFICACION = APERTURA + 2_200;
  /** El instante exacto en que el asesor mandó «Nos queda 1 talla ese». */
  const ASESOR_ESCRIBE = Date.parse("2026-08-27T16:30:26.892Z");
  /** Fin de la redacción: 6,5 s, el tramo más lento que se midió. */
  const FIN_REDACCION = APERTURA + 8_700;

  let reloj = APERTURA;

  beforeEach(() => {
    reloj = APERTURA;
    vi.spyOn(Date, "now").mockImplementation(() => reloj);
  });

  // El reloj vuelve a ser el de verdad al salir: un `Date.now` congelado que
  // se filtre al resto del archivo rompe las pruebas de tiempos del turno.
  afterEach(() => {
    vi.mocked(Date.now).mockRestore();
  });

  /** El asesor escribe en medio de la redacción, como pasó de verdad. */
  function elAsesorEntraRedactando() {
    generateMock.mockImplementation(async () => {
      reloj = ASESOR_ESCRIBE;
      // Conversando en el momento (caso 3 de human-handled.test.ts): el
      // `created_at` es el instante real en que el asesor escribió, muy
      // reciente frente al `now` que verá `deliver()` — lo bloquea la
      // cláusula de gracia, no la de `last_customer_message_at`.
      state.humanMessages = [{ created_at: new Date(reloj).toISOString() }];
      reloj = FIN_REDACCION;
      return {
        text: "Claro, tenemos varios cascos disponibles.",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });
  }

  function laClasificacionTarda() {
    classifyIntentMock.mockImplementation(async () => {
      reloj = FIN_CLASIFICACION;
      return {
        intent: "consulta_disponibilidad" as const,
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      };
    });
  }

  it("no envía el texto redactado: el asesor escribió dentro del hueco", async () => {
    laClasificacionTarda();
    elAsesorEntraRedactando();

    await runAgentTurn("conv-1");

    // Que el modelo SÍ haya redactado es la mitad que importa: prueba que el
    // turno llegó hasta el envío y se frenó ahí, no que murió al abrirse por
    // la guarda que ya existía.
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  /** Sin asesor de por medio el mismo turno, con los mismos tiempos, sí habla. */
  it("con el hueco vacío el mismo turno sí envía", async () => {
    laClasificacionTarda();
    generateMock.mockImplementation(async () => {
      reloj = FIN_REDACCION;
      return {
        text: "Claro, tenemos varios cascos disponibles.",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });

  /**
   * El evento va aparte de `turno_chat_de_una_persona` —el frenado al abrir—
   * porque cuentan cosas distintas: aquel cuenta chats que la IA no tocó, este
   * cuenta carreras perdidas. Es el número con el que se mide si el hueco
   * sigue abierto.
   */
  it("deja en el registro un evento propio, distinto del frenado al abrir", async () => {
    const warn = vi.spyOn(log, "warn");
    laClasificacionTarda();
    elAsesorEntraRedactando();

    await runAgentTurn("conv-1");

    expect(warn).toHaveBeenCalledWith("turno_persona_se_adelanto", {
      conversationId: "conv-1",
      fase: "redaccion",
    });
    expect(warn).not.toHaveBeenCalledWith("turno_chat_de_una_persona", expect.anything());
  });

  /** El camino más corto del turno tiene la misma puerta que el más largo. */
  it("tampoco sale el escenario si el asesor se adelantó mientras se reconocía", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockImplementation(async () => {
      reloj = ASESOR_ESCRIBE;
      // Conversando en el momento (caso 3 de human-handled.test.ts): el
      // `created_at` es el instante real en que el asesor escribió, muy
      // reciente frente al `now` que verá `deliver()` — lo bloquea la
      // cláusula de gracia, no la de `last_customer_message_at`.
      state.humanMessages = [{ created_at: new Date(reloj).toISOString() }];
      return { playbook: pb, usage: NO_USAGE };
    });

    await runAgentTurn("conv-1");

    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    // Ni etiqueta ni escala: todo eso acompaña a un mensaje que no salió.
    expect(contactTagUpserts).toHaveLength(0);
    expect(escalateConversationMock).not.toHaveBeenCalled();
  });

  it("tampoco sale la redirección de fuera de tema", async () => {
    classifyIntentMock.mockImplementation(async () => {
      reloj = ASESOR_ESCRIBE;
      // Conversando en el momento (caso 3 de human-handled.test.ts): el
      // `created_at` es el instante real en que el asesor escribió, muy
      // reciente frente al `now` que verá `deliver()` — lo bloquea la
      // cláusula de gracia, no la de `last_customer_message_at`.
      state.humanMessages = [{ created_at: new Date(reloj).toISOString() }];
      return {
        intent: "fuera_de_tema" as const,
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      };
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });

  /**
   * Misma regla que la comprobación de apertura: si no se puede preguntar, no
   * se escribe. El costo de los dos lados no se parece — no contestar deja a
   * un cliente esperando un rato más; contestar encima de un asesor le escribe
   * a alguien que está a mitad de una venta.
   */
  it("si no se puede comprobar quién escribió, no envía", async () => {
    laClasificacionTarda();
    generateMock.mockImplementation(async () => {
      state.humanMessagesError = { message: "connection reset" };
      reloj = FIN_REDACCION;
      return {
        text: "Claro, tenemos varios cascos disponibles.",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await runAgentTurn("conv-1");

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
  });
});

/**
 * T7 (8/9/2026): hasta esta corrida, "escribió un humano" preguntaba "¿ALGUNA
 * VEZ?" y no "¿AHORA?" — caso real `3b654d2c-3cf8-4eef-8638-bc75e45cb10a`, un
 * "a" de un supervisor el 28/8/2026 dejaba muda a la IA para un cliente que
 * escribió el 7/9. Estas pruebas cubren el efecto en `runAgentTurn`: un
 * mensaje de asesor viejo, anterior al último mensaje del cliente y fuera de
 * la gracia, ya no frena el turno; y "Reactivar IA"/"Desasignar" —que solo
 * tocan `ai_enabled`/`assigned_agent_id`, nunca `messages`— vuelven a dejar
 * pasar el turno una vez que el cliente escribió después de esa gracia.
 */
describe("runAgentTurn — la guarda de humanos ya no es vitalicia (T7, 8/9/2026)", () => {
  it("un humano que escribió antes del último mensaje del cliente y hace más de G no frena el turno", async () => {
    const warn = vi.spyOn(log, "warn");
    // El "a" del 28/8: mucho antes del último mensaje del cliente (el
    // `last_customer_message_at` por defecto del beforeEach) y a años luz de
    // los 30 minutos de gracia por default.
    state.humanMessages = [{ created_at: "2026-08-28T00:00:00.000Z" }];

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith("turno_chat_de_una_persona", expect.anything());
    expect(handoffCalls.some((call) => call.p_reason === "humano_intervino")).toBe(false);
  });

  /**
   * `setAiEnabled(true)` y `unassign` (mutations.ts) escriben exactamente
   * `{ ai_enabled: true }` y `{ assigned_agent_id: null }` — nunca tocan
   * `messages`. Antes de T7 eso no alcanzaba para que la IA volviera a
   * hablar si alguna vez había escrito un asesor; ahora sí, en cuanto el
   * cliente escribió algo nuevo después de la gracia.
   */
  it("reactivar la IA y desasignar devuelven el chat", async () => {
    state.conversation = { ...state.conversation, ai_enabled: true, assigned_agent_id: null };
    // Humano viejo, muy anterior al último mensaje del cliente y a la gracia.
    state.humanMessages = [{ created_at: "2026-08-28T00:00:00.000Z" }];

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalled();
  });
});

/**
 * H2, plan "Seba atiende el mostrador" (18/9/2026, D2): un chat REABIERTO por
 * el cliente arranca de cero — un mensaje de asesor de ANTES de esa
 * reapertura no cuenta como "conversando ahora mismo" para la cláusula de
 * gracia, aunque esté a minutos de `now`. Ver el docblock de
 * `reopenedAtIfGraceWouldFire`/`humanClaimsChat` en human-handled.ts.
 */
describe("runAgentTurn — la reapertura por el cliente salta la gracia (H2, 18/9/2026)", () => {
  it("asesor hace 5 min, reapertura hace 1 min, cliente escribe después: no sale por humano_intervino", async () => {
    const ahora = Date.now();
    state.conversation = {
      ...state.conversation,
      last_customer_message_at: new Date(ahora).toISOString(),
    };
    // El asesor escribió ANTES del último mensaje del cliente, pero hace solo
    // 5 min — dentro de los 30 min de gracia por default, así que sin la
    // reapertura la cláusula de gracia bloquearía el turno.
    state.humanMessages = [{ created_at: new Date(ahora - 5 * 60_000).toISOString() }];
    // La reapertura es POSTERIOR al mensaje del asesor: descuenta ese mensaje
    // viejo y la gracia no dispara.
    state.reopenedByCustomerRow = { created_at: new Date(ahora - 1 * 60_000).toISOString() };

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalled();
    expect(handoffCalls.some((call) => call.p_reason === "humano_intervino")).toBe(false);
  });
});

/**
 * `lease.confirmar()` es la guarda más nueva de `deliver()`, y va PRIMERO:
 * si el lock ya no es nuestro, la conversación puede ser de otro turno (o de
 * uno resucitado tras un TTL vencido) y ni siquiera tiene sentido preguntar
 * el interruptor o si un asesor se metió.
 */
describe("runAgentTurn — el turno confirma que el lock sigue siendo suyo antes de hablar", () => {
  it("no envía nada si el lock ya no es suyo", async () => {
    state.turnLockRenewResult = { data: false, error: null };

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(agentTurnInserts.some((row) => row.action === "answered")).toBe(false);
  });

  /**
   * Falla cerrado, igual que el resto de las guardas del envío: ante la duda
   * de si el lock sigue siendo nuestro, no se sigue hablando. El error se
   * deja pasar (con `.catch`) porque, a diferencia del `data: false` de
   * arriba, acá el RPC mismo revienta: `confirmar()` no lo atrapa, así que
   * el turno vuelve a la cola como reintentable — lo que sí importa acá es
   * que no llegó a enviar nada.
   */
  it("un fallo al confirmar el lock tampoco envía", async () => {
    state.turnLockRenewResult = { data: null, error: { message: "conexión perdida" } };

    await runAgentTurn("conv-1").catch(() => undefined);

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
  });

  /**
   * El evento es lo que permite distinguir, leyendo el registro, "el lock ya
   * no era nuestro" de cualquier otra guarda de `deliver()` que también
   * termina en un envío que no salió. `fase` dice en qué tramo del turno
   * pasó — acá "redaccion", porque el flujo por defecto de las pruebas de
   * este archivo no calza ningún escenario.
   */
  it("deja en el registro el evento turno_lock_perdido_sin_enviar con la fase donde se perdió", async () => {
    const warn = vi.spyOn(log, "warn");
    state.turnLockRenewResult = { data: false, error: null };

    await runAgentTurn("conv-1");

    expect(warn).toHaveBeenCalledWith("turno_lock_perdido_sin_enviar", {
      conversationId: "conv-1",
      fase: "redaccion",
    });
  });
});

/**
 * Guarda (b) de `deliver()`: la misma pregunta del interruptor que se hizo al
 * abrir el turno (`agent_can_run`), repetida justo antes de hablar. Entre
 * abrir el turno y llegar acá pasan de tres a diez segundos —clasificar,
 * redactar—, y apagar el interruptor en ese hueco tiene que frenar el envío
 * igual que lo frena si se apaga antes de empezar.
 */
describe("runAgentTurn — el interruptor se vuelve a revisar justo antes de enviar", () => {
  it("si se apaga mientras el turno redacta, no envía nada", async () => {
    const warn = vi.spyOn(log, "warn");
    generateMock.mockImplementation(async () => {
      // Igual que la carrera del asesor: el interruptor cambia DESPUÉS de
      // abrir el turno, mientras el modelo todavía está redactando.
      state.canRun = false;
      return {
        text: "respuesta redactada por el modelo",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await runAgentTurn("conv-1");

    // El modelo sí redactó: el turno llegó hasta el envío y se frenó ahí,
    // no antes por la guarda de apertura que ya existía.
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("turno_abortado_por_interruptor", { conversationId: "conv-1" });
  });

  /**
   * Tarea 5 (14/9/2026), (c) del checklist: acá la RPC NO contesta "no" — no
   * se puede ni consultar (mismo corte de red que ya cubre el test de
   * apertura de arriba, pero éste pasa DENTRO de `deliver()`, justo antes de
   * enviar). Antes de esta tarea `stillEnabled` atrapaba cualquier error y
   * devolvía `false`, así que este caso quedaba indistinguible de "se apagó
   * de verdad": `deliver()` escribía `agente_no_puede_correr` como si fuera
   * una decisión, y el turno NO se reintentaba porque no lanzaba nada. Ahora
   * `stillEnabled` relanza: `deliver()` no lo atrapa, `entrega.intentado`
   * nunca llega a `true`, y el `catch` de `runAgentTurn` (ver más abajo en
   * el archivo) reencola el turno en vez de archivarlo.
   */
  it("(c) si la RPC agent_can_run no se puede consultar justo antes de enviar (dentro de deliver), el turno lanza y no hay traspaso agente_no_puede_correr", async () => {
    const error = vi.spyOn(log, "error");
    generateMock.mockImplementation(async () => {
      // Mismo patrón que el test de arriba: el fallo aparece DESPUÉS de abrir
      // el turno, mientras el modelo redacta.
      state.agentCanRunError = { message: "red caída" };
      return {
        text: "respuesta redactada por el modelo",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await expect(runAgentTurn("conv-1")).rejects.toThrow();

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "turno_interruptor_no_consultable",
      expect.objectContaining({ conversationId: "conv-1", detail: "red caída" })
    );
    expect(handoffCalls.filter((h) => h.p_reason === "agente_no_puede_correr")).toHaveLength(0);
  });
});

/**
 * Tarea 5 ("La voz cercana y la espera visible", 14/9/2026), (e) del
 * checklist: hasta esta tarea `logTurn` y el UPDATE de `conversations.intent`
 * ignoraban su propio `error` — por eso ningún `fuera_de_tema` había quedado
 * jamás en la bitácora pese a que el camino ya existía: si el INSERT fallaba,
 * nadie se enteraba. Ninguno de los dos puede tumbar el turno: el cliente ya
 * recibió su respuesta (o el turno ya decidió, correctamente, callarse), así
 * que un fallo acá es observabilidad perdida, no un mensaje sin enviar.
 */
describe("runAgentTurn — la bitácora registra sus propios fallos (Tarea 5, 14/9/2026)", () => {
  it("(e) si el INSERT de agent_turns falla, deja turno_bitacora_no_escrita en el registro y el turno no lanza", async () => {
    const error = vi.spyOn(log, "error");
    state.agentTurnInsertError = { message: "permiso denegado" };

    await expect(runAgentTurn("conv-1")).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      "turno_bitacora_no_escrita",
      expect.objectContaining({ conversationId: "conv-1", action: "answered" })
    );
    // El turno sigue igual pese al fallo: el mensaje sí salió.
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });

  it("si el UPDATE de conversations.intent falla, deja turno_intencion_no_guardada en el registro y el turno sigue igual", async () => {
    const error = vi.spyOn(log, "error");
    state.intentUpdateError = { message: "conexión perdida" };

    await runAgentTurn("conv-1");

    expect(error).toHaveBeenCalledWith(
      "turno_intencion_no_guardada",
      expect.objectContaining({ conversationId: "conv-1", detail: "conexión perdida" })
    );
    // Tampoco es una barrera: el turno sigue hasta enviar la respuesta.
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });
});

describe("runAgentTurn — mensajes fuera de tema", () => {
  /**
   * Antes esto caía en "otro", que arranca el tool loop: el turno más caro
   * que existe, gastado en alguien que no es un cliente. Ahora termina en la
   * clasificación y el texto sale de una constante, sin costo de salida.
   */
  it("responde con el texto fijo y no llama al modelo redactor", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "fuera_de_tema",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });

    await runAgentTurn("conv-1");

    expect(generateMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe(OFF_TOPIC_REPLY);
    expect(agentTurnInserts[0]).toMatchObject({ intent: "fuera_de_tema", action: "answered" });
    // Tarea C6, plan "El resguardo antes del push" (20/9/2026): la PRIMERA
    // vez sí contesta — no hay nada de qué "callarse", así que no escribe el
    // traspaso `fuera_de_tema_repetido` (ese caso es solo para la segunda
    // insistencia, más abajo).
    expect(handoffCalls).toHaveLength(0);
  });

  /**
   * T4, "Seba atiende el mostrador" (18/9/2026, D2, requisito 6 del
   * cliente): en un chat YA asignado esta redirección tampoco es una
   * respuesta real -el cliente le sigue hablando a Seba, no a la persona que
   * espera- así que sale marcada `is_auto_reply: true` desde el mismo envío.
   * Tarea C6 (20/9/2026) suma esta prueba: hasta acá ningún test miraba las
   * opciones de `sendAgentText`, solo el texto.
   */
  it("con asesor asignado, la PRIMERA redirección sale marcada is_auto_reply", async () => {
    state.conversation = { ...state.conversation, ai_enabled: true, assigned_agent_id: "agent-9" };
    classifyIntentMock.mockResolvedValue({
      intent: "fuera_de_tema",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe(OFF_TOPIC_REPLY);
    expect(sendAgentTextMock.mock.calls[0][3]).toMatchObject({ isAutoReply: true });
    expect(handoffCalls).toHaveLength(0);
  });

  /**
   * Si alguien insiste, repetir la misma línea es un ping-pong que puede
   * durar indefinidamente — y del otro lado bien puede haber otro bot. Se
   * contesta una vez; a la segunda se calla, pero el turno igual queda en la
   * bitácora para que se vea en el panel.
   *
   * Tarea C6, plan "El resguardo antes del push" (20/9/2026, anexo de la
   * Tanda 1, extensión del hallazgo A): hasta esta tarea ese `return` no
   * dejaba ningún traspaso -violaba la invariante "ningún lead invisible" de
   * CLAUDE.md y dejaba a `reconcileOrphanTurns` reencolando la conversación
   * cada minuto durante hasta 24 h-. Ahora deja `fuera_de_tema_repetido`
   * sobre el MISMO dueño que ya tenía la conversación (sin asesor:
   * `unassigned`).
   */
  it("no vuelve a contestar si su última respuesta ya fue la redirección, y deja el traspaso fuera_de_tema_repetido a 'unassigned'", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "fuera_de_tema",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    // Del más nuevo al más viejo, como los devuelve la consulta.
    state.history = [
      { sender_type: "customer", content: "dale va, ayúdame igual", is_internal_note: false },
      { sender_type: "ai", content: OFF_TOPIC_REPLY, is_internal_note: false },
      { sender_type: "customer", content: "escríbeme un poema", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(agentTurnInserts).toHaveLength(1);
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "fuera_de_tema_repetido",
    });
  });

  /**
   * Mismo caso, pero con un asesor ya asignado: el traspaso tiene que quedar
   * sobre ESE dueño (`human` + su id), no `unassigned` — el silencio no le
   * entrega el chat a nadie nuevo, solo reafirma a quien ya lo tenía.
   */
  it("segunda insistencia con asesor asignado: deja el traspaso fuera_de_tema_repetido a 'human' con su id", async () => {
    state.conversation = { ...state.conversation, ai_enabled: true, assigned_agent_id: "agent-9" };
    classifyIntentMock.mockResolvedValue({
      intent: "fuera_de_tema",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    state.history = [
      { sender_type: "customer", content: "dale va, ayúdame igual", is_internal_note: false },
      { sender_type: "ai", content: OFF_TOPIC_REPLY, is_internal_note: false },
      { sender_type: "customer", content: "escríbeme un poema", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "human",
      p_to_id: "agent-9",
      p_reason: "fuera_de_tema_repetido",
    });
  });

  /**
   * Corrección 5/9/2026: T0.3 conectó `rejectedByMeta()` en el escenario de
   * fase 0 y en la respuesta final del tool loop, pero se le olvidó el
   * tercer consumidor de `sendAgentText` — esta redirección. Era un `return`
   * que abandonaba la conversación sin traspaso: exactamente el bug que la
   * invariante de CLAUDE.md prohíbe.
   */
  it("rechazado_por_meta: la redirección de fuera de tema sale rechazada por Meta, sin segundo envío", async () => {
    const warn = vi.spyOn(log, "warn");
    classifyIntentMock.mockResolvedValue({
      intent: "fuera_de_tema",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    sendAgentTextMock.mockResolvedValueOnce({
      whatsapp_message_id: null,
      whatsapp_status: "failed" as const,
      whatsapp_error_code: 131047,
      whatsapp_error_detail: "Meta rechazó el envío",
      origenDelFallo: "meta" as const,
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    // El turno termina en el rechazo: no llega a escribir agent_turns.
    expect(agentTurnInserts).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("turno_rechazado_por_meta", {
      conversationId: "conv-1",
      codigo: 131047,
    });
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "rechazado_por_meta",
    });
    // A3 (5/9/2026): mismo reseteo que en el camino de escenario — sin él, el
    // tablero de Atascados veía esta conversación congelada en "Clasificando".
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
  });
});

describe("runAgentTurn — instrucciones que recibe el modelo", () => {
  it("le pasa el bloque estático como prefijo exacto, para que el caché lo reconozca", async () => {
    await runAgentTurn("conv-1");

    expect(agentOptions).toHaveLength(1);
    expect(agentOptions[0].instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
  });

  /**
   * 18/9/2026 (T2b, plan "Seba atiende el mostrador"): reemplaza a "manda
   * saludar cuando la conversación nunca recibió bienvenida" / "no manda
   * saludar si la bienvenida ya salió" — el modelo YA NO redacta ningún
   * saludo. Con `welcome_sent_at` sellado (el estado por defecto de
   * `state.conversation`), el turno no manda la presentación de Seba y el
   * sufijo dice "no te presentes de nuevo" (`introducedThisTurn: false`).
   */
  it("con welcome_sent_at ya sellado, el sufijo dice que Seba ya se presentó antes", async () => {
    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(agentOptions[0].instructions.slice(SYSTEM_PROMPT.length)).toMatch(
      /ya te presentaste como seba en esta conversación/i
    );
  });

  /**
   * Frente B3 (5/9/2026): el horario que lee `runAgentTurn` de
   * `agent_settings.business_hours` tiene que llegar hasta las instrucciones
   * del turno, no quedarse en la variable. Con la tienda cerrada los siete
   * días la aserción no depende de a qué hora corra la suite: sin ninguna
   * franja en toda la semana, `businessStatus` siempre da CERRADA sin
   * "abre tal día", así que la salida es la misma corra cuando corra.
   */
  it("lee el horario de agent_settings y lo pasa a las instrucciones del turno", async () => {
    state.agentSettingsBusinessHours = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

    await runAgentTurn("conv-1");

    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toContain("cerrado todos los días");
    expect(sufijo).toContain("Ahora mismo: CERRADA.");
  });

  /** El mismo horario le llega también a `matchPlaybook` (fase 0), no solo al flujo genérico. */
  it("le pasa el mismo horario a matchPlaybook", async () => {
    const horario = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    state.agentSettingsBusinessHours = horario;

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock.mock.calls[0][3]).toEqual(horario);
  });

  /**
   * T3, plan "Nada sin leer, un solo catálogo y la factura Saint" (18/9/2026):
   * los catálogos ACTIVOS se leen junto con `business_hours` (misma consulta
   * en paralelo) y llegan también a `matchPlaybook` — es lo que le permite a
   * fase 0 descartar un escenario con marcador sin resolver.
   */
  it("le pasa los catálogos activos a matchPlaybook", async () => {
    state.catalogLinkRows = [
      {
        id: "link-1",
        key: "cascos",
        label: "Cascos",
        url: "https://drive.google.com/cascos",
        sort_order: 1,
        is_active: true,
        updated_by: null,
        created_at: "2026-09-18T00:00:00.000Z",
        updated_at: "2026-09-18T00:00:00.000Z",
      },
    ];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock.mock.calls[0][4]).toEqual([
      expect.objectContaining({ key: "cascos", url: "https://drive.google.com/cascos" }),
    ]);
  });

  /** Una fila rota (forma inválida) no tumba el turno: cae al horario por defecto. */
  it("con agent_settings.business_hours roto, cae al horario por defecto sin romper el turno", async () => {
    state.agentSettingsBusinessHours = { esto: "no es un horario válido" };

    await runAgentTurn("conv-1");

    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toContain("lunes a viernes de 8:00 am a 6:00 pm");
  });

  /** Un fallo leyendo agent_settings tampoco tumba el turno: horario por defecto y log.warn. */
  it("si agent_settings no se puede leer, sigue con el horario por defecto y avisa por log", async () => {
    const warn = vi.spyOn(log, "warn");
    state.agentSettingsError = { message: "conexión perdida" };

    await runAgentTurn("conv-1");

    expect(agentOptions).toHaveLength(1);
    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toContain("lunes a viernes de 8:00 am a 6:00 pm");
    expect(warn).toHaveBeenCalledWith("turno_horario_no_legible", {
      conversationId: "conv-1",
      detail: "conexión perdida",
    });
  });

  /**
   * Tarea 3 (14/9/2026): `display_name`/`profile_name` tienen que viajar en
   * la misma fila que ya trae `phone_number`, para que `customerFirstName`
   * (customer-name.ts) tenga con qué trabajar sin una segunda consulta.
   */
  it("el select del turno pide display_name y profile_name del contacto", async () => {
    await runAgentTurn("conv-1");

    expect(conversationSelectColumns).toHaveLength(1);
    expect(conversationSelectColumns[0]).toContain("display_name");
    expect(conversationSelectColumns[0]).toContain("profile_name");
  });

  /**
   * `buildInstructions` (prompt.ts) recibe el nombre ya resuelto por
   * `customerFirstName`: con un nombre de persona en `display_name`, el
   * sufijo lo nombra; con un teléfono guardado ahí y sin `profile_name`, no
   * hay nada que parezca un nombre y el sufijo no lo menciona.
   */
  it("pasa customerName a las instrucciones cuando el contacto tiene nombre", async () => {
    state.conversation = {
      ...state.conversation,
      contact: { phone_number: "+584121112233", display_name: "Ana Pérez", profile_name: null },
    };

    await runAgentTurn("conv-1");

    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toContain("El cliente se llama Ana");
  });

  it("no menciona ningún nombre cuando lo guardado es un teléfono", async () => {
    state.conversation = {
      ...state.conversation,
      contact: { phone_number: "+584121112233", display_name: "+584121112233", profile_name: null },
    };

    await runAgentTurn("conv-1");

    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).not.toMatch(/El cliente se llama/);
  });
});

/**
 * T2b, plan "Seba atiende el mostrador" (18/9/2026): el turno presenta a
 * Seba por código, en un mensaje aparte, ANTES de cualquier redacción del
 * modelo — `welcome_sent_at IS NULL` es la condición completa (reemplaza a
 * `needsGreeting`, que miraba el historial). `presentationClaimWins: true`
 * de fábrica (`beforeEach`) es lo que deja pasar de largo a TODA la suite
 * anterior a esta tarea sin que le importe el reclamo.
 */
describe("runAgentTurn — la presentación de Seba (T2b, 18/9/2026)", () => {
  afterEach(() => {
    // El reloj vuelve a ser el de verdad al salir: un reloj congelado que se
    // filtre al resto del archivo rompe cualquier prueba que dependa de la
    // hora real (mismo motivo que el `afterEach` de "tiempos del turno").
    vi.useRealTimers();
  });

  /**
   * Chat nuevo (`welcome_sent_at: null`) con una pregunta de verdad detrás
   * del saludo: el turno manda DOS mensajes, en orden — la presentación
   * literal de Seba primero (marcada `is_auto_reply: true`, porque sigue una
   * redacción real detrás y `awaiting_reply` no puede apagarse antes de
   * tiempo) y la respuesta redactada después (sin `is_auto_reply`, la
   * respuesta real). El texto de la presentación es el EXACTO que arma
   * `sebaGreeting` para la franja del `now` fijo del test — nunca el reloj
   * real (trampa de CLAUDE.md, "nunca dejar un test que dependa del reloj
   * real").
   */
  it("chat nuevo + pregunta: dos envíos en orden saludo → respuesta, is_auto_reply distinto en cada uno", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T00:30:00Z")); // 8:30 pm en Caracas → franja "noche"

    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.history = [
      { sender_type: "customer", content: "hola, tienen pastillas de freno", is_internal_note: false },
    ];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(2);
    expect(sendAgentTextMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      sebaGreeting("noche"),
      expect.objectContaining({ isAutoReply: true })
    );
    expect(sendAgentTextMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      "respuesta redactada por el modelo",
      expect.objectContaining({ isAutoReply: false })
    );
    // El sello de presentación quedó puesto (el reclamo se ve en el UPDATE).
    expect(conversationUpdates).toContainEqual(
      expect.objectContaining({ welcome_sent_at: expect.any(String) })
    );
    // Sí llegó a clasificar y a redactar: la presentación no reemplazó el
    // resto del turno, lo precedió.
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  /**
   * "hola" pelado: el saludo de Seba YA es la respuesta completa del turno.
   * Un solo envío, marcado `is_auto_reply: false` (apaga `awaiting_reply`
   * como cualquier respuesta real), y sin gastar fase 0, fase 1 ni el tool
   * loop — tres llamadas al proveedor que un "hola" no necesitaba.
   */
  it("chat nuevo + 'hola': un solo envío con is_auto_reply false, sin clasificar ni redactar", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.history = [{ sender_type: "customer", content: "hola", is_internal_note: false }];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ isAutoReply: false })
    );
    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({
      action: "answered",
      summary: "Seba se presentó; el cliente solo saludó.",
    });
  });

  /**
   * Si el reclamo pierde —otra corrida ya selló `welcome_sent_at` antes de
   * que esta llegara a intentarlo— el turno no manda ninguna presentación:
   * sigue de largo como si el sello ya hubiera estado puesto desde el
   * principio.
   */
  it("si el reclamo pierde (0 filas), no saluda y sigue directo a la redacción", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.presentationClaimWins = false;

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "respuesta redactada por el modelo",
      expect.anything()
    );
    expect(agentOptions[0].instructions.slice(SYSTEM_PROMPT.length)).toMatch(
      /ya te presentaste como seba en esta conversación/i
    );
  });

  /**
   * Tanda 3, tarea M1c (20/9/2026), ítem 1: la rama de ERROR de
   * `claimPresentation` — un fallo del UPDATE contra la base (no un "0
   * filas", sino la consulta misma fallando) tiene que tratarse IGUAL que un
   * reclamo perdido: no hay garantía de que el sello haya quedado puesto, así
   * que mandar el saludo igual arriesgaría una presentación sin
   * `welcome_sent_at` reflejando la realidad (o, peor, un `.select()`
   * después de un `.update()` que ni siquiera corrió). `claimPresentation`
   * devuelve `false` en el catch de error, mismo camino que "el reclamo
   * pierde (0 filas)" de arriba: sin saludo, directo a la redacción, y con
   * el log de diagnóstico puesto.
   */
  it("si el UPDATE de claimPresentation falla (error de la base), no saluda, sigue directo a la redacción y deja el log", async () => {
    const errorSpy = vi.spyOn(log, "error");
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.presentationClaimError = { message: "conexión perdida" };

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "respuesta redactada por el modelo",
      expect.anything()
    );
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "turno_presentacion_reclamo_fallido",
      expect.objectContaining({ conversationId: "conv-1", detail: "conexión perdida" })
    );
  });

  /**
   * La guarda de `deliver()` frena DESPUÉS de que el reclamo ya selló
   * `welcome_sent_at` — acá, el interruptor global apagándose justo en el
   * hueco entre el reclamo y el siguiente guardián de `deliver()` (mismo
   * tipo de carrera que ya cubre "el interruptor se vuelve a revisar justo
   * antes de enviar", más arriba, pero ANTES de clasificar/redactar). El
   * sello no puede quedar puesto sin que haya salido nada: se revierte a
   * `null` para que el próximo mensaje del cliente encuentre otra vez
   * `welcome_sent_at IS NULL` y Seba se presente de verdad.
   */
  it("si deliver() frena justo después del reclamo, el sello vuelve a null y no sigue redactando", async () => {
    const warn = vi.spyOn(log, "warn");
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.onPresentationClaimed = () => {
      state.canRun = false;
    };

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(conversationUpdates).toContainEqual({ welcome_sent_at: null });
    expect(warn).toHaveBeenCalledWith("turno_abortado_por_interruptor", { conversationId: "conv-1" });
  });

  /**
   * Meta rechaza el envío de la presentación (Meta SÍ respondió, con un
   * código de error): mismo criterio que el caso de arriba — sin
   * presentación real, el sello vuelve a `null`. El turno no sigue de largo
   * hacia la redacción: `deliveryFailed` corta el camino ahí mismo.
   */
  it("si Meta rechaza el envío de la presentación, el sello vuelve a null y el turno no sigue redactando", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    sendAgentTextMock.mockResolvedValueOnce({
      whatsapp_message_id: null,
      whatsapp_status: "failed",
      whatsapp_error_code: 131047,
      whatsapp_error_detail: "rechazado por Meta",
      origenDelFallo: "meta",
    });

    await runAgentTurn("conv-1");

    // Un solo intento: el de la presentación. El turno no llegó a clasificar
    // ni a redactar una segunda respuesta.
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(conversationUpdates).toContainEqual({ welcome_sent_at: null });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({ p_conversation_id: "conv-1", p_to_kind: "unassigned", p_reason: "rechazado_por_meta" })
    );
  });

  /**
   * Hallazgo G, corrección de la Tanda 1 (20/9/2026), test G-1: hasta esta
   * corrección el rollback de `welcome_sent_at` SOLO cubría `!salida` y
   * `deliveryFailed` — si `deliver()` mismo LANZABA (acá, `stillEnabled`
   * relanzando porque `agent_can_run` no es consultable, la misma carrera de
   * "el interruptor se vuelve a revisar justo antes de enviar" pero
   * ANTES de clasificar/redactar) la excepción salía con el sello YA puesto.
   * `state.onPresentationClaimed` dispara justo en el hueco entre el reclamo
   * (que ya selló `welcome_sent_at`) y el siguiente guardián de `deliver()`
   * — mismo patrón que el test de arriba ("si deliver() frena justo después
   * del reclamo"), pero acá el guardián LANZA en vez de devolver `false`.
   */
  it("G-1: si deliver() de la presentación LANZA, el sello vuelve a null y el error original se propaga", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.onPresentationClaimed = () => {
      state.agentCanRunError = { message: "conexión perdida" };
    };

    await expect(runAgentTurn("conv-1")).rejects.toThrow(/agent_can_run no consultable/);

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(conversationUpdates).toContainEqual({ welcome_sent_at: null });
  });

  /**
   * Test G-2: si ADEMÁS el UPDATE de reversa falla, el error que se propaga
   * sigue siendo el ORIGINAL (`agent_can_run no consultable`), no el del
   * rollback — `rollbackPresentation` nunca lanza por su cuenta, deja
   * `log.error` y vuelve.
   */
  it("G-2: si el rollback del sello también falla, se propaga el error ORIGINAL y queda el log", async () => {
    const errorSpy = vi.spyOn(log, "error");
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.onPresentationClaimed = () => {
      state.agentCanRunError = { message: "conexión perdida" };
    };
    state.presentationRollbackError = { message: "no se pudo revertir" };

    await expect(runAgentTurn("conv-1")).rejects.toThrow(/agent_can_run no consultable/);

    expect(errorSpy).toHaveBeenCalledWith(
      "turno_presentacion_reclamo_no_revertido",
      expect.objectContaining({ conversationId: "conv-1" })
    );
  });
});

/**
 * T3, plan "Seba sale sin pisar a nadie" (19/9/2026, hallazgo nuevo de la
 * inspección pre-despliegue, fila A3): la cola agrupa ráfagas de mensajes
 * seguidos antes de correr un turno (CLAUDE.md, "La respuesta llega en
 * siete segundos") — `soloSaludo` (T2b) y la guarda de cortesía tras
 * escalada (Tarea 4, 14/9/2026) miraban SOLO la última línea del cliente, y
 * las dos se comían una pregunta real que había llegado antes en la misma
 * ráfaga. Las dos ahora usan `customerBurst` (history-line.ts): toda la
 * ráfaga tiene que ser saludo/cortesía, no solo la última línea.
 *
 * `state.history` se escribe DESCENDENTE (más reciente primero), igual que
 * el resto de este archivo.
 */
describe("runAgentTurn — el saludo y la cortesía miran la ráfaga entera (T3, 19/9/2026)", () => {
  it("'Precio del casco LS2' + 'Buenas tardes' (ráfaga, chat nuevo): no es solo saludo, el turno llega a clasificar", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    // Un minuto de diferencia (corrección 19/9/2026, hallazgo 4): dentro del
    // hueco de CUSTOMER_BURST_GAP_MINUTES, así que las dos líneas siguen
    // siendo la MISMA ráfaga.
    state.history = [
      { sender_type: "customer", content: "Buenas tardes", is_internal_note: false, created_at: "2026-09-19T10:01:00.000Z" },
      { sender_type: "customer", content: "Precio del casco LS2", is_internal_note: false, created_at: "2026-09-19T10:00:00.000Z" },
    ];

    await runAgentTurn("conv-1");

    // Dos envíos: la presentación de Seba primero (no reemplaza el turno,
    // la pregunta sigue sin contestar) y la redacción real después.
    expect(sendAgentTextMock).toHaveBeenCalledTimes(2);
    expect(sendAgentTextMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ isAutoReply: true })
    );
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("'hola' + 'buenas' (ráfaga, ambas saludo): sigue siendo solo saludo, sin fase 0/1", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.history = [
      { sender_type: "customer", content: "buenas", is_internal_note: false, created_at: "2026-09-19T10:01:00.000Z" },
      { sender_type: "customer", content: "hola", is_internal_note: false, created_at: "2026-09-19T10:00:00.000Z" },
    ];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ isAutoReply: false })
    );
    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("foto sin pie + 'hola': no es solo saludo (el marcador de media en la ráfaga no es saludo ni cortesía)", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.history = [
      { sender_type: "customer", content: "hola", is_internal_note: false, created_at: "2026-09-19T10:01:00.000Z" },
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "image", created_at: "2026-09-19T10:00:00.000Z" },
    ];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(2);
    expect(sendAgentTextMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ isAutoReply: true })
    );
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Reescrito el 22-23/9/2026 (T5, plan "Seba no habla de más mientras el
   * cliente espera al asesor", opción (b) del operador): la ráfaga entera
   * ["¿tienen la bomba de aceite?", "gracias"] no es pura cortesía (la
   * primera línea es una pregunta real), así que la guarda de arriba no se
   * traga la ráfaga — eso sigue siendo lo que este test protege. Pero "el
   * turno NO se calla" hasta esta tarea quería decir tool loop +
   * clasificación + `sendAgentText`; con la escalada abierta ninguna de las
   * dos líneas calza un escenario informativo, así que ahora "no se calla"
   * significa que la pregunta le llega al asesor por nota, no al cliente.
   */
  it("'¿tienen la bomba de aceite?' + 'gracias' (ráfaga) con una escalada abierta: la pregunta llega al asesor por nota, el turno NO se calla", async () => {
    state.history = [
      { sender_type: "customer", content: "gracias", is_internal_note: false, created_at: "2026-09-19T10:01:00.000Z" },
      { sender_type: "customer", content: "¿tienen la bomba de aceite?", is_internal_note: false, created_at: "2026-09-19T10:00:00.000Z" },
    ];
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-14T10:00:00.000Z" };
    state.agentMessagesAfterHandoff = [];

    await runAgentTurn("conv-1");

    expect(handoffCalls.some((c) => c.p_reason === "cortesia_tras_escalada")).toBe(false);
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(messageInserts).toHaveLength(1);
    expect(messageInserts[0].content).toContain("¿tienen la bomba de aceite?");
  });

  it("'gracias' sola (ráfaga de una línea) con escalada abierta: se sigue callando como hoy", async () => {
    state.history = [{ sender_type: "customer", content: "gracias", is_internal_note: false }];
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-14T10:00:00.000Z" };
    state.agentMessagesAfterHandoff = [];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({ p_reason: "cortesia_tras_escalada" });
  });

  /**
   * Corrección del 19/9/2026 (`code-review high`, hallazgo 4): la primera
   * versión de `customerBurst` no acotaba por tiempo, solo por "hay una
   * respuesta del CRM en el medio". Caso real: "¿ya me atienden?" se quedó
   * sin contestar (`pausada`), el chat se cerró; DÍAS después el cliente
   * reabre con "hola". Sin el corte por hueco, la ráfaga habría sido
   * ["¿ya me atienden?", "hola"] — no solo saludo — y Seba habría redactado
   * sobre una pregunta de hace tres días que quedó sin responder a
   * propósito. Con el corte, la línea vieja queda fuera y sigue siendo solo
   * saludo.
   */
  it("'¿ya me atienden?' de hace 3 días + 'hola' ahora: el hueco corta la ráfaga, sigue siendo solo saludo", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.history = [
      { sender_type: "customer", content: "hola", is_internal_note: false, created_at: "2026-09-19T10:00:00.000Z" },
      {
        sender_type: "customer",
        content: "¿ya me atienden?",
        is_internal_note: false,
        created_at: "2026-09-16T10:00:00.000Z",
      },
    ];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ isAutoReply: false })
    );
    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  /**
   * Corrección del 19/9/2026 (`code-review high`, hallazgo 8): un sticker
   * hacía fallar el `every(isCourtesyOnly)` de la guarda de cortesía —
   * "gracias" + sticker de pulgar con una escalada abierta ya no la callaba,
   * y la IA mandaba una segunda despedida encima de la primera. El sticker
   * se salta al armar la ráfaga: ["gracias"] sigue siendo pura cortesía.
   */
  it("'gracias' + sticker (ráfaga) con una escalada abierta: el sticker se ignora, el turno se calla igual", async () => {
    state.history = [
      { sender_type: "customer", content: null, message_type: "sticker", is_internal_note: false, created_at: "2026-09-19T10:01:00.000Z" },
      { sender_type: "customer", content: "gracias", is_internal_note: false, created_at: "2026-09-19T10:00:00.000Z" },
    ];
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-14T10:00:00.000Z" };
    state.agentMessagesAfterHandoff = [];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({ p_reason: "cortesia_tras_escalada" });
  });
});

/**
 * T1, plan "Seba no habla de más mientras el cliente espera al asesor"
 * (22-23/9/2026, "lo ya respondido no se vuelve a responder"): la marca
 * "visto hasta" en Redis (`turn-seen.ts`) reemplaza a `customerBurst` a
 * secas cuando existe — `pendingCustomerLines` recupera TODAS las líneas de
 * cliente más nuevas que la marca, aunque el historial termine en una
 * respuesta del asistente.
 *
 * Secuencia EXACTA del caso real medido en producción el 22/9/2026 (hora
 * VET): cliente "Color *" (15:24:44), "Vale" (15:24:53), "Gracias"
 * (15:24:54); Seba responde (15:24:59). El turno de las 15:25:06 carga el
 * historial YA TERMINADO en esa respuesta — sin la marca, `customerBurst`
 * da `[]` y la guarda de cortesía tras escalada no dispara (el bug real).
 */
describe("runAgentTurn — la marca 'visto hasta' (T1, 22-23/9/2026)", () => {
  const HISTORIAL_CASO_1 = [
    { sender_type: "ai", content: "¡Un gusto ayudarte!", is_internal_note: false, created_at: "2026-09-22T15:24:59.000Z" },
    { sender_type: "customer", content: "Gracias", is_internal_note: false, created_at: "2026-09-22T15:24:54.000Z", id: "m-gracias" },
    { sender_type: "customer", content: "Vale", is_internal_note: false, created_at: "2026-09-22T15:24:53.000Z", id: "m-vale" },
    { sender_type: "customer", content: "Color *", is_internal_note: false, created_at: "2026-09-22T15:24:44.000Z", id: "m-color" },
  ];

  function seedMarker(hasta: string, ids: string[]) {
    redisSeenStore.set("turno:visto:conv-1", JSON.stringify({ hasta, ids }));
  }

  it("marca en 'Color *' (ya visto): recupera ['Vale', 'Gracias'] pendientes → dispara cortesia_tras_escalada, sin llamar a matchPlaybook", async () => {
    state.history = HISTORIAL_CASO_1;
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-14T10:00:00.000Z" };
    state.agentMessagesAfterHandoff = [];
    seedMarker("2026-09-22T15:24:44.000Z", ["m-color"]);

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({ p_reason: "cortesia_tras_escalada" });
  });

  it("marca en 'Gracias' (todo ya visto): no queda nada pendiente → turno_sin_mensaje_nuevo, sin modelo ni traspaso", async () => {
    state.history = HISTORIAL_CASO_1;
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-14T10:00:00.000Z" };
    state.agentMessagesAfterHandoff = [];
    seedMarker("2026-09-22T15:24:54.000Z", ["m-gracias"]);
    const info = vi.spyOn(log, "info");

    await runAgentTurn("conv-1");

    expect(info).toHaveBeenCalledWith("turno_sin_mensaje_nuevo", { conversationId: "conv-1" });
    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    // No cambia de dueño: lo que el cliente dijo ya lo contestó el turno
    // anterior — no hay ningún `record_handoff` que escribir acá.
    expect(handoffCalls).toHaveLength(0);
  });

  it("sin marca (Redis nunca la escribió, o el turno anterior nunca llegó a escribirla): comportamiento de hoy", async () => {
    state.history = HISTORIAL_CASO_1;
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-14T10:00:00.000Z" };
    state.agentMessagesAfterHandoff = [];
    // redisSeenStore queda vacío (beforeEach ya lo limpia): sin marca, la
    // ráfaga vuelve a ser `customerBurst`, que da `[]` porque el historial
    // termina en la respuesta de Seba — la guarda de cortesía no dispara y
    // el turno sigue de largo a fase 0/1, tal como se comportaba ANTES de
    // esta tarea.
    await runAgentTurn("conv-1");

    expect(handoffCalls.some((c) => c.p_reason === "cortesia_tras_escalada")).toBe(false);
    expect(classifyIntentMock).toHaveBeenCalled();
  });

  it("una respuesta final entregada sin falla deja la marca en Redis con el created_at y el id más nuevos del historial cargado", async () => {
    state.history = [
      {
        sender_type: "customer",
        content: "hola, tienen cascos?",
        is_internal_note: false,
        created_at: "2026-09-22T12:00:00.000Z",
        id: "m-1",
      },
    ];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalled();
    const raw = redisSeenStore.get("turno:visto:conv-1");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual({ hasta: "2026-09-22T12:00:00.000Z", ids: ["m-1"] });
  });

  it("cuando la entrega falla (fallo de red), la marca NO se escribe", async () => {
    state.history = [
      {
        sender_type: "customer",
        content: "hola, tienen cascos?",
        is_internal_note: false,
        created_at: "2026-09-22T12:00:00.000Z",
        id: "m-1",
      },
    ];
    sendAgentTextMock.mockResolvedValueOnce({
      whatsapp_message_id: null,
      whatsapp_status: "failed" as const,
      whatsapp_error_code: null,
      whatsapp_error_detail: "fetch failed",
      origenDelFallo: "red" as const,
    });

    await runAgentTurn("conv-1");

    expect(redisSeenStore.has("turno:visto:conv-1")).toBe(false);
  });
});

/**
 * T4, plan "Seba no habla de más mientras el cliente espera al asesor"
 * (22-23/9/2026, "el historial viejo marcado"). Secuencia EXACTA del caso
 * real medido en producción el 22/9/2026 (hora VET): la última pregunta del
 * cliente antes de ese día fue "¿Tienen retrovisores de RK200?" (3/9/2026),
 * ya respondida por un asesor ("se nos agotaron"). El 22/9 el cliente
 * escribió "Buenas tardes" (15:24:14, ya visto por el turno anterior) y,
 * segundos después, "Llegaron las tapas de la Rk 200" (15:24:24), "?"
 * (15:24:26) y "Coño negro" (15:24:28). El turno que ve esos tres como
 * pendientes tomó, sin este prompt, la pregunta vieja de los retrovisores
 * como la consulta actual.
 */
describe("runAgentTurn — el sufijo trae los pendientes y marca la conversación anterior (T4, 22-23/9/2026)", () => {
  it("'tapas' aparece entre los pendientes del sufijo; 'retrovisores' nunca aparece", async () => {
    state.history = [
      { sender_type: "customer", content: "Coño negro", is_internal_note: false, created_at: "2026-09-22T15:24:28.000Z", id: "m-negro" },
      { sender_type: "customer", content: "?", is_internal_note: false, created_at: "2026-09-22T15:24:26.000Z", id: "m-signo" },
      { sender_type: "customer", content: "Llegaron las tapas de la Rk 200", is_internal_note: false, created_at: "2026-09-22T15:24:24.000Z", id: "m-tapas" },
      { sender_type: "customer", content: "Buenas tardes", is_internal_note: false, created_at: "2026-09-22T15:24:14.000Z", id: "m-tardes" },
      { sender_type: "agent", content: "se nos agotaron", is_internal_note: false, created_at: "2026-09-03T14:05:00.000Z", id: "m-agotaron" },
      { sender_type: "customer", content: "Tienen retrovisores de RK200 ?", is_internal_note: false, created_at: "2026-09-03T14:00:00.000Z", id: "m-retro" },
    ];
    // El turno anterior ya vio hasta "Buenas tardes": los pendientes de ESTE
    // turno son "Llegaron las tapas de la Rk 200", "?" y "Coño negro".
    redisSeenStore.set("turno:visto:conv-1", JSON.stringify({ hasta: "2026-09-22T15:24:14.000Z", ids: ["m-tardes"] }));

    await runAgentTurn("conv-1");

    expect(agentOptions).toHaveLength(1);
    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toMatch(/mensajes nuevos/i);
    expect(sufijo).toContain("Llegaron las tapas de la Rk 200");
    expect(sufijo).toContain("?");
    expect(sufijo).toContain("Coño negro");
    expect(sufijo).not.toMatch(/retrovisor/i);
    // La conversación de los retrovisores queda marcada como "anterior,
    // atendida": el corte es "Buenas tardes", el mensaje que separa la
    // conversación vieja de la ráfaga del 22/9.
    expect(sufijo).toMatch(/conversación anterior/i);
  });
});

describe("runAgentTurn — interruptores de herramientas", () => {
  it("con todo encendido, una consulta lleva catálogo, biblioteca y escalamiento", async () => {
    await runAgentTurn("conv-1");

    expect(Object.keys(agentOptions[0].tools).sort()).toEqual([
      "buscarRepuesto",
      "consultarBiblioteca",
      "escalarAAsesor",
    ]);
  });

  /**
   * El pedido que motivó los interruptores: apagar la consulta de productos
   * sin apagar la IA. El turno corre, pero sin la herramienta — y con la
   * instrucción explícita de no cotizar de memoria, que es el riesgo real.
   */
  it("con el catálogo apagado, el turno corre sin esa herramienta y avisa al modelo", async () => {
    state.enabledToolKeys = ["buscar_historial_compras", "consultar_biblioteca"];

    await runAgentTurn("conv-1");

    expect(agentOptions[0].tools).not.toHaveProperty("buscarRepuesto");
    expect(agentOptions[0].instructions.slice(SYSTEM_PROMPT.length)).toMatch(/catálogo está apagada/);
  });

  it("con la biblioteca apagada, la herramienta no viaja", async () => {
    state.enabledToolKeys = ["buscar_repuesto", "buscar_historial_compras"];

    await runAgentTurn("conv-1");

    expect(agentOptions[0].tools).not.toHaveProperty("consultarBiblioteca");
    expect(agentOptions[0].tools).toHaveProperty("buscarRepuesto");
  });

  /** Escalar no tiene interruptor: es la única salida hacia un humano. */
  it("escalar a un asesor viaja siempre, aunque todo lo demás esté apagado", async () => {
    state.enabledToolKeys = [];

    await runAgentTurn("conv-1");

    expect(agentOptions[0].tools).toHaveProperty("escalarAAsesor");
    expect(Object.keys(agentOptions[0].tools)).toHaveLength(1);
  });

  it("en una devolución, el historial de compras respeta su interruptor", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "devolucion",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    state.enabledToolKeys = ["buscar_repuesto", "consultar_biblioteca"];

    await runAgentTurn("conv-1");

    expect(agentOptions[0].tools).not.toHaveProperty("buscarHistorialCompras");
    expect(agentOptions[0].tools).toHaveProperty("escalarAAsesor");
  });

  /**
   * Tarea K, "El resguardo antes del push" (20/9/2026): caso real
   * `db8d3120…`, "Precio del casco LS2" cotizado de memoria porque el
   * modelo contestó en un paso sin llamar a `buscarRepuesto`. Acá no se
   * ejercita `firstStepToolChoice` en sí (tiene sus propios tests puros en
   * `tool-choice.test.ts`): solo que `agent.ts` la conecta al `prepareStep`
   * del `ToolLoopAgent` con los argumentos correctos.
   */
  describe("forzar el catálogo en el primer paso (T. 'El resguardo antes del push', 20/9/2026)", () => {
    it("con consulta_disponibilidad y el catálogo encendido, el paso 0 fuerza buscarRepuesto", async () => {
      classifyIntentMock.mockResolvedValue({
        intent: "consulta_disponibilidad",
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      });

      await runAgentTurn("conv-1");

      expect(agentOptions[0].prepareStep).toBeTypeOf("function");
      expect(agentOptions[0].prepareStep!({ stepNumber: 0 })).toEqual({
        toolChoice: { type: "tool", toolName: "buscarRepuesto" },
      });
    });

    it("del paso 1 en adelante, prepareStep no fuerza nada", async () => {
      classifyIntentMock.mockResolvedValue({
        intent: "consulta_disponibilidad",
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      });

      await runAgentTurn("conv-1");

      expect(agentOptions[0].prepareStep!({ stepNumber: 1 })).toBeUndefined();
    });

    it("con otra intención, prepareStep no fuerza nada ni en el paso 0", async () => {
      // El default del beforeEach ya es "otro" (ver el comentario de H1 más
      // arriba): no hace falta pisar el mock, alcanza con no pedir
      // "consulta_disponibilidad".
      await runAgentTurn("conv-1");

      expect(agentOptions[0].prepareStep!({ stepNumber: 0 })).toBeUndefined();
    });

    it("con el catálogo apagado, prepareStep no fuerza nada aunque la intención sea consulta_disponibilidad", async () => {
      classifyIntentMock.mockResolvedValue({
        intent: "consulta_disponibilidad",
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      });
      state.enabledToolKeys = ["buscar_historial_compras", "consultar_biblioteca"];

      await runAgentTurn("conv-1");

      expect(agentOptions[0].tools).not.toHaveProperty("buscarRepuesto");
      expect(agentOptions[0].prepareStep!({ stepNumber: 0 })).toBeUndefined();
    });
  });
});

/**
 * T1, plan "La escalada se hace una vez y la búsqueda responde" (21/9/2026).
 * Contexto medido en producción el 21/9/2026: los dos únicos turnos donde
 * `escalarAAsesor` se llamó DOS veces en el mismo turno gastaron 145.000
 * tokens de entrada y ~65.800 de salida cada uno (0,108 USD, 5 minutos de
 * redacción). D1 del operador: no se corta con `stopWhen` — se le quita al
 * modelo la posibilidad de volver a usar herramientas en el paso SIGUIENTE
 * a una escalada (`stepToolChoice`, tool-choice.ts) y se le pone un techo de
 * salida al `ToolLoopAgent` como última red.
 */
describe("runAgentTurn — techo de salida y freno a la escalada repetida (T1, 'La escalada se hace una vez y la búsqueda responde', 21/9/2026)", () => {
  it("el ToolLoopAgent se construye con maxOutputTokens: 1500 (literal, no el símbolo importado — trampa CLAUDE.md)", async () => {
    await runAgentTurn("conv-1");

    expect(agentOptions[0].maxOutputTokens).toBe(1500);
  });

  /**
   * Regresión: un turno que NO escala sigue topado en 5 pasos y sigue
   * recibiendo sus herramientas de siempre — D1 dejó `stopWhen` intacto a
   * propósito, el freno nuevo es solo sobre `toolChoice`.
   */
  it("un turno que no escala conserva stopWhen con el techo de 5 pasos y sus herramientas", async () => {
    await runAgentTurn("conv-1");

    expect(agentOptions[0].stopWhen).toBeTypeOf("function");
    expect(await agentOptions[0].stopWhen!({ steps: [{}, {}, {}, {}, {}] })).toBe(true);
    expect(await agentOptions[0].stopWhen!({ steps: [{}, {}, {}, {}] })).toBe(false);
    expect(agentOptions[0].tools).toHaveProperty("escalarAAsesor");
  });

  /**
   * `outcome.escalated` lo muta `execute` de `buildEscalateTool` (tools.ts)
   * cuando el modelo llama a la herramienta de verdad; acá el tool loop está
   * fingido (ver el comentario de `buildEscalateToolMock`, más arriba), así
   * que mutarlo desde el mock simula que la escalada ya corrió ANTES de que
   * `agent.ts` arme `prepareStep` — el mismo efecto observable que si
   * hubiera corrido dentro de `agent.generate()`.
   */
  it("tras escalar, el paso siguiente del tool loop recibe toolChoice: 'none' (D1: no se corta con stopWhen)", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "consulta_disponibilidad",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    buildEscalateToolMock.mockImplementationOnce((_deps, outcome) => {
      outcome.escalated = true;
      return {};
    });

    await runAgentTurn("conv-1");

    expect(agentOptions[0].prepareStep!({ stepNumber: 1 })).toEqual({ toolChoice: "none" });
  });

  it("antes de escalar, prepareStep se comporta como siempre (paso 0 con consulta_disponibilidad + catálogo encendido fuerza buscarRepuesto)", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "consulta_disponibilidad",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });

    await runAgentTurn("conv-1");

    expect(agentOptions[0].prepareStep!({ stepNumber: 0 })).toEqual({
      toolChoice: { type: "tool", toolName: "buscarRepuesto" },
    });
  });
});

/**
 * T4, plan "Nada se pierde en un corte ni en un deploy" (21-22/9/2026).
 *
 * `@/lib/ai/model` está mockeado entero en este archivo (`getAgentModel`
 * devuelve `{ model: "modelo-falso" }`), así que el middleware REAL de
 * telemetría (`telemetryMiddleware`, turn-telemetry.ts, compuesto en
 * `build()` de model.ts) nunca corre a través de `ToolLoopAgent`/
 * `generateText` fingidos de este archivo — probarlo de verdad, con
 * `params` reales, es trabajo de `model.test.ts` +
 * `turn-telemetry.test.ts` (middleware con `params: { maxOutputTokens:
 * 1500, toolChoice: { type: "none" } }` → fila con esos valores). Acá se
 * prueba la otra mitad, la que SÍ vive en `agent.ts`: que `runAgentTurn`
 * corre dentro de `conTelemetriaDeTurno` de verdad (turn-telemetry.ts NO
 * está mockeado en este archivo) y que `logTurn` vuelca lo que el registro
 * tenga al INSERT de `agent_turn_calls`, con el `turn_id` que acaba de
 * recibir de `agent_turns`.
 *
 * Para la prueba directa que pedía el informe del VPS (7.4:
 * "maxOutputTokens/toolChoice sin prueba directa") sin tener que levantar
 * el SDK de IA entero, el mock de `ToolLoopAgent.generate` invoca el
 * middleware de telemetría REAL (importado sin mockear) con los MISMOS
 * `params` que `agent.ts` le pasaría al SDK en el paso que corre justo
 * DESPUÉS de escalar (`agentOptions[0].maxOutputTokens`/
 * `agentOptions[0].prepareStep({ stepNumber: 1 })`, ya verificados byte a
 * byte por el describe de arriba) — es la opción más honesta entre las dos
 * que dejaba abiertas el plan: no inventa un valor nuevo, reusa el mismo
 * que el describe de arriba prueba que agent.ts construye de verdad.
 */
describe("runAgentTurn — telemetría por llamada (T4, 'Nada se pierde en un corte ni en un deploy', 21-22/9/2026)", () => {
  it("logTurn no llama a agent_turn_calls cuando el turno no registró ninguna llamada (el mock de ToolLoopAgent no invoca telemetría por defecto)", async () => {
    await runAgentTurn("conv-1");

    expect(agentTurnCallsInserts).toHaveLength(0);
  });

  it("la fila de la fase 'redactar' que corre TRAS escalar lleva max_output_tokens: 1500 (literal) y tool_choice: 'none'", async () => {
    // Mismo patrón que "tras escalar, el paso siguiente del tool loop recibe
    // toolChoice: 'none'" del describe de arriba: mutar `outcome.escalated`
    // desde `buildEscalateToolMock` simula que la escalada ya corrió ANTES
    // de que `agent.ts` arme `prepareStep`.
    buildEscalateToolMock.mockImplementationOnce((_deps, outcome) => {
      outcome.escalated = true;
      return {};
    });
    generateMock.mockImplementationOnce(async () => {
      // El paso 1 (el que sigue a la escalada) es justo el que
      // `agentOptions[0].prepareStep({ stepNumber: 1 })` ya prueba que
      // recibe `toolChoice: "none"` -- acá se invoca el middleware REAL con
      // esos mismos params, tal como el SDK real lo haría al ejecutar ese
      // paso.
      await telemetryMiddleware("redactar").wrapGenerate!({
        doGenerate: async () => ({
          content: [],
          warnings: [],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 900, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 40, text: undefined, reasoning: undefined },
          },
        }),
        doStream: async () => {
          throw new Error("no se usa en este test");
        },
        params: { maxOutputTokens: 1500, toolChoice: { type: "none" }, prompt: [] } as never,
        model: {} as never,
      });
      return {
        text: "listo, ya te escaló con un asesor",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await runAgentTurn("conv-1");

    // El paso 1 de verdad lleva ese `toolChoice` -- lo mismo que ya prueba
    // el describe de arriba, repetido acá para que el test sea legible sin
    // saltar de archivo.
    expect(agentOptions[0].maxOutputTokens).toBe(1500);
    expect(agentOptions[0].prepareStep!({ stepNumber: 1 })).toEqual({ toolChoice: "none" });

    expect(agentTurnCallsInserts).toHaveLength(1);
    const filas = agentTurnCallsInserts[0];
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      turn_id: "agent-turn-1",
      conversation_id: "conv-1",
      phase: "redactar",
      max_output_tokens: 1500,
      tool_choice: "none",
      input_tokens: 900,
      output_tokens: 40,
      finish_reason: "stop",
    });
  });

  it("no lanza si el INSERT de agent_turn_calls falla, y deja turno_llamadas_no_escritas en el registro", async () => {
    const error = vi.spyOn(log, "error");
    state.agentTurnCallsInsertError = { message: "tabla sin permisos" };
    generateMock.mockImplementationOnce(async () => {
      await telemetryMiddleware("redactar").wrapGenerate!({
        doGenerate: async () => ({
          content: [],
          warnings: [],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
        }),
        doStream: async () => {
          throw new Error("no se usa en este test");
        },
        params: { prompt: [] } as never,
        model: {} as never,
      });
      return {
        text: "respuesta redactada por el modelo",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await expect(runAgentTurn("conv-1")).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      "turno_llamadas_no_escritas",
      expect.objectContaining({ conversationId: "conv-1", turnId: "agent-turn-1", detail: "tabla sin permisos" })
    );
    // El turno siguió igual: el mensaje sí salió pese a que la fila de
    // detalle no se pudo escribir.
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });

  it("usa el turn_id que devolvió el INSERT de agent_turns, no uno fijo", async () => {
    state.agentTurnInsertedId = "turn-distinto-99";
    generateMock.mockImplementationOnce(async () => {
      await telemetryMiddleware("redactar").wrapGenerate!({
        doGenerate: async () => ({
          content: [],
          warnings: [],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: undefined, reasoning: undefined },
          },
        }),
        doStream: async () => {
          throw new Error("no se usa en este test");
        },
        params: { prompt: [] } as never,
        model: {} as never,
      });
      return {
        text: "respuesta redactada por el modelo",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}, {}],
      };
    });

    await runAgentTurn("conv-1");

    expect(agentTurnCallsInserts).toHaveLength(1);
    expect(agentTurnCallsInserts[0][0]).toMatchObject({ turn_id: "turn-distinto-99" });
  });
});

describe("runAgentTurn — tokens cacheados", () => {
  /**
   * La entrada cacheada se factura mucho más barata que la normal. Sin
   * guardarla, el panel de costos cobra todo a precio completo y no hay
   * forma de saber si el prompt está cacheando de verdad o si alguien lo
   * rompió al editarlo.
   */
  it("registra cuántos tokens de entrada vinieron del caché", async () => {
    generateMock.mockResolvedValue({
      text: "respuesta redactada por el modelo",
      usage: {
        inputTokens: 2000,
        outputTokens: 8,
        totalTokens: 2008,
        inputTokenDetails: { noCacheTokens: 400, cacheReadTokens: 1600, cacheWriteTokens: 0 },
      },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(agentTurnInserts[0]).toMatchObject({ cached_input_tokens: 1600 });
  });

  it("guarda cero cuando el proveedor no informa caché", async () => {
    await runAgentTurn("conv-1");

    expect(agentTurnInserts[0]).toMatchObject({ cached_input_tokens: 0 });
  });
});

/**
 * T4b, plan "La escalada se hace una vez y la búsqueda responde" (21/9/2026).
 *
 * Contexto: el 21/9/2026 dos turnos reales gastaron ~65.800 tokens de SALIDA
 * contra un mensaje visible al cliente de ~40 — la hipótesis es razonamiento
 * interno de `openai/gpt-5.6-luna` que ningún dato separaba de la redacción.
 * `agent_turns.reasoning_tokens` (migración 20260921020000, T4a) es la
 * columna; esto prueba que `tokensFromUsage`/`addTokens` (agent.ts) de verdad
 * lo extraen y lo suman a lo largo de las cuatro llamadas al proveedor que
 * un turno puede hacer (reconocimiento de escenario, clasificación,
 * redacción y —si dispara— la reescritura de la guarda de identidad).
 */
describe("runAgentTurn — tokens de razonamiento (T4b, 21/9/2026)", () => {
  it("registra los tokens de razonamiento que informa la redacción", async () => {
    generateMock.mockResolvedValueOnce({
      text: "respuesta redactada por el modelo",
      usage: {
        inputTokens: 20,
        outputTokens: 908,
        totalTokens: 928,
        outputTokenDetails: { textTokens: 8, reasoningTokens: 900 },
      },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    // El reconocimiento (NO_USAGE) y la clasificación (mock por defecto del
    // beforeEach) no traen outputTokenDetails: 0 + 0 + 900 (redacción) = 900.
    expect(agentTurnInserts[0]).toMatchObject({ reasoning_tokens: 900 });
  });

  it("guarda cero cuando el proveedor no informa outputTokenDetails en ninguna llamada", async () => {
    await runAgentTurn("conv-1");

    expect(agentTurnInserts[0]).toMatchObject({ reasoning_tokens: 0 });
  });

  it("guarda cero cuando outputTokenDetails viene sin el campo reasoningTokens", async () => {
    generateMock.mockResolvedValueOnce({
      text: "respuesta redactada por el modelo",
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
        // El proveedor separó texto de razonamiento pero no reportó cuánto
        // fue razonamiento — el campo directamente no viene, no viene en 0.
        outputTokenDetails: { textTokens: 8 },
      },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(agentTurnInserts[0]).toMatchObject({ reasoning_tokens: 0 });
  });

  it("suma los tokens de razonamiento del reconocimiento, la clasificación y la redacción", async () => {
    matchPlaybookMock.mockResolvedValueOnce({
      playbook: null,
      usage: {
        inputTokens: 3,
        outputTokens: 1,
        totalTokens: 4,
        outputTokenDetails: { textTokens: 1, reasoningTokens: 100 },
      },
    });
    classifyIntentMock.mockResolvedValueOnce({
      intent: "otro",
      usage: {
        inputTokens: 5,
        outputTokens: 1,
        totalTokens: 6,
        outputTokenDetails: { textTokens: 1, reasoningTokens: 50 },
      },
    });
    generateMock.mockResolvedValueOnce({
      text: "respuesta redactada por el modelo",
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
        outputTokenDetails: { textTokens: 8, reasoningTokens: 900 },
      },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    // 100 (reconocimiento) + 50 (clasificación) + 900 (redacción) = 1050.
    expect(agentTurnInserts[0]).toMatchObject({ reasoning_tokens: 1050 });
  });

  it("la reescritura de la guarda de identidad suma su propio razonamiento", async () => {
    generateMock.mockResolvedValueOnce({
      text: "¡Buenos días! Soy el asistente automatizado de SBK Motorcycles. El automático de la Horse está en 12$.",
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        totalTokens: 28,
        outputTokenDetails: { textTokens: 8, reasoningTokens: 40 },
      },
      steps: [{}, {}],
    });
    generateTextMock.mockResolvedValueOnce({
      text: "¡Buenos días! Acá en SBK el automático de la Horse está en 12$.",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        outputTokenDetails: { textTokens: 4, reasoningTokens: 15 },
      },
    });

    await runAgentTurn("conv-1");

    // 40 (redacción bloqueada por la guarda) + 15 (reescritura) = 55.
    expect(agentTurnInserts[0]).toMatchObject({ reasoning_tokens: 55 });
  });
});

// ---------------------------------------------------------------------------
// Tiempos del turno
//
// El dueño pide respuesta en cuatro segundos. Para discutir ese número hay que
// saber dónde se van los que se van, y hasta ahora averiguarlo era restar a
// mano dos columnas de `messages`, conversación por conversación.
// ---------------------------------------------------------------------------
describe("runAgentTurn — tiempos del turno", () => {
  /** La línea estructurada que emite el turno, ya parseada. */
  function leerTiempos(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> | null {
    for (const [linea] of spy.mock.calls) {
      if (typeof linea !== "string") continue;
      const evento = JSON.parse(linea) as Record<string, unknown>;
      if (evento.event === "turno_tiempos") return evento;
    }
    return null;
  }

  it("registra cuánto tardó cada tramo y cuántos pasos gastó", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentTurn("conv-1");

      const tiempos = leerTiempos(spy);
      expect(tiempos).not.toBeNull();
      expect(tiempos).toMatchObject({
        conversationId: "conv-1",
        // Dos pasos del mock, contra el techo de cinco: es el dato que
        // contesta si MAX_STEPS = 5 es generoso o justo.
        pasos: 2,
        maxPasos: 5,
        entregado: true,
      });
      expect(typeof tiempos?.clasificacionMs).toBe("number");
      expect(typeof tiempos?.redaccionMs).toBe("number");
      expect(typeof tiempos?.envioMs).toBe("number");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * `esperaMs` es la ventana de silencio más la cola: el tramo que no se ve
   * desde dentro del turno y donde se fue casi todo el tiempo de la primera
   * noche (media de 4.521 s, con el tope de un turno por minuto puesto).
   */
  it("mide también la espera desde el mensaje del cliente", async () => {
    state.conversation = {
      ...state.conversation,
      last_customer_message_at: new Date(Date.now() - 8000).toISOString(),
    };

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentTurn("conv-1");

      const tiempos = leerTiempos(spy);
      expect(tiempos?.esperaMs).toBeGreaterThanOrEqual(8000);
      // El total es lo que mira el dueño: del mensaje del cliente a la
      // respuesta enviada, espera incluida.
      expect(tiempos?.totalMs).toBeGreaterThanOrEqual(tiempos?.esperaMs as number);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * En `finally`: el turno que revienta a los veinte segundos es justo el que
   * hay que poder ver, y es el que se perdería si esto colgara del camino
   * feliz.
   */
  it("registra los tiempos aunque el turno termine sin responder", async () => {
    generateMock.mockRejectedValue(new Error("el proveedor falló"));

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentTurn("conv-1");

      const tiempos = leerTiempos(spy);
      expect(tiempos).not.toBeNull();
      expect(tiempos).toMatchObject({ entregado: false, pasos: null });
      // El tramo que falló también se mide: cuánto tardó en fallar importa.
      expect(typeof tiempos?.redaccionMs).toBe("number");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * T0 ("La respuesta llega en siete segundos", 7/9/2026): `esperaMs` mezclaba
   * la ventana de silencio (diseño) con la espera en cola (atraso) en un solo
   * número. Con `vencioEn` —lo que trae el reclamo de la cola, ver
   * redis-queue.ts— el turno separa los dos tramos, y por construcción
   * (mismo `Date.now()` para los tres, ver `newTurnTiming`) suman
   * exactamente `esperaMs`.
   */
  it("separa la ventana de silencio de la espera en cola y suman la espera total", async () => {
    const ahora = Date.now();
    state.conversation = {
      ...state.conversation,
      last_customer_message_at: new Date(ahora - 8000).toISOString(),
    };

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // El cliente escribió hace 8 s; la cola dio por vencida la ventana de
      // silencio hace 5 s (vencioEn = ahora - 5000) — o sea, el debounce fue
      // de 3 s y la cola tardó 5 s más en atenderlo.
      await runAgentTurn("conv-1", { vencioEn: ahora - 5000 });

      const tiempos = leerTiempos(spy);
      expect(tiempos).not.toBeNull();
      // Margen generoso: entre encolar el mock y leer el log corre el turno
      // entero, y ese tiempo real también pasa.
      expect(tiempos?.debounceMs).toBeGreaterThanOrEqual(2900);
      expect(tiempos?.debounceMs).toBeLessThanOrEqual(3200);
      expect(tiempos?.colaMs).toBeGreaterThanOrEqual(5000);
      expect((tiempos?.debounceMs as number) + (tiempos?.colaMs as number)).toBe(tiempos?.esperaMs);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * `api/dev/simulate-message` llama a `runAgentTurn` sin pasar por la cola:
   * sin `vencioEn` los dos tramos nuevos no pueden calcularse, pero eso no
   * puede tumbar `esperaMs`, que es el número que ya se usaba antes de esta
   * corrida.
   */
  it("sin vencimiento los dos tramos quedan null y esperaMs sigue midiendo", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentTurn("conv-1");

      const tiempos = leerTiempos(spy);
      expect(tiempos?.debounceMs).toBeNull();
      expect(tiempos?.colaMs).toBeNull();
      expect(typeof tiempos?.esperaMs).toBe("number");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * T0: sin este dato, nadie podía decir qué herramienta dispara el segundo
   * paso de redacción (29 de 65 turnos medidos el 7/9/2026) sin tocar el
   * prompt del redactor.
   */
  it("la línea trae las herramientas usadas, en el orden en que corrieron", async () => {
    generateMock.mockResolvedValueOnce({
      text: "respuesta redactada por el modelo",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [
        { toolCalls: [{ toolName: "consultarBiblioteca" }] },
        { toolCalls: [{ toolName: "buscarRepuesto" }, { toolName: "escalarAAsesor" }] },
      ],
    });

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentTurn("conv-1");

      const tiempos = leerTiempos(spy);
      expect(tiempos?.herramientas).toBe("consultarBiblioteca,buscarRepuesto,escalarAAsesor");
    } finally {
      spy.mockRestore();
    }
  });

  /** El mock por defecto de este archivo trae `steps: [{}, {}]`, sin `toolCalls`: el tool loop corrió y no usó ninguna herramienta. */
  it("sin herramientas usadas, la línea trae un string vacío, no null", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAgentTurn("conv-1");

      const tiempos = leerTiempos(spy);
      expect(tiempos?.herramientas).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * T7, plan "Seba no habla de más" (23/9/2026): el reporte de latencia del
   * VPS medía `agent_turns.wait_ms` como si fuera la espera en cola sola
   * (`colaMs`, lo que el comentario de la columna siempre dijo) y el número
   * salía inflado por la ventana de silencio (~7,5 s de diseño) mezclada
   * adentro (`esperaMs`) — un debounce normal parecía atraso. `logTurn`
   * pasó de escribir `esperaMs` a escribir `colaMs`.
   */
  it("agent_turns.wait_ms guarda la espera en cola (colaMs), no la espera total (esperaMs)", async () => {
    const ahora = Date.now();
    state.conversation = {
      ...state.conversation,
      last_customer_message_at: new Date(ahora - 8000).toISOString(),
    };

    // Debounce de 3 s, cola de 5 s más: esperaMs (~8000) y colaMs (~5000)
    // tienen que quedar claramente distintos para que la aserción no pase
    // por casualidad si alguien vuelve a escribir esperaMs.
    await runAgentTurn("conv-1", { vencioEn: ahora - 5000 });

    expect(agentTurnInserts).toHaveLength(1);
    const waitMs = agentTurnInserts[0].wait_ms as number;
    expect(waitMs).toBeGreaterThanOrEqual(5000);
    expect(waitMs).toBeLessThan(7000);
  });

  /**
   * `api/dev/simulate-message` llama a `runAgentTurn` sin pasar por la cola:
   * sin `vencioEn` la cola nunca dio por vencido nada, así que `colaMs`
   * queda en `null` (la columna lo admite, migración 20260921040000, sin
   * `not null`) — más honesto que inventar un 0 o seguir escribiendo
   * `esperaMs` ahí.
   */
  it("sin vencimiento, agent_turns.wait_ms queda en null", async () => {
    await runAgentTurn("conv-1");

    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({ wait_ms: null });
  });
});

/**
 * T4, corrida "La IA ve lo que llega" (8/9/2026, Bug 2 / S4). Hallazgo 2 del
 * plan: había TRES puertas en `runTurnPhases` que dejaban `journey_stage`
 * congelado en "classifying"/"tool_running" para siempre porque el turno
 * salía antes de llegar al reseteo normal. Este describe cubre las tres.
 */
describe("runAgentTurn — salidas que limpian su etapa", () => {
  /** La línea `turno_tiempos`, ya parseada, entre las llamadas de un spy. */
  function tiemposDe(info: ReturnType<typeof vi.spyOn>): Record<string, unknown> | undefined {
    const call = info.mock.calls.find((args: unknown[]) => args[0] === "turno_tiempos");
    return call?.[1] as Record<string, unknown> | undefined;
  }

  /**
   * Caso `cea69118…`: un historial que solo trae `unsupported` o notas —nada
   * legible para el modelo, tras describir la media con `historyLine`
   * (T2)— ya no sale mudo. Prueba de mutación del orquestador: si el
   * `return` por historial vacío volviera a ser mudo (`if (history.length
   * === 0) return;`), este test se pone rojo.
   */
  it("un historial sin nada legible deja traspaso sin_contenido_legible y limpia la etapa", async () => {
    const warn = vi.spyOn(log, "warn");
    const info = vi.spyOn(log, "info");
    state.history = [
      { sender_type: "customer", content: null, is_internal_note: false, message_type: "unsupported" },
    ];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("turno_sin_contenido_legible", { conversationId: "conv-1" });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({
        p_conversation_id: "conv-1",
        p_to_kind: "unassigned",
        p_reason: "sin_contenido_legible",
      })
    );

    // journey_stage se puso en "classifying" al abrir el turno y se limpió
    // DESPUÉS, no antes: el orden importa, es la prueba de que no es un
    // reseteo que ya estaba ahí por otro motivo.
    const classificando = conversationUpdates.findIndex((u) => u.journey_stage === "classifying");
    const limpieza = conversationUpdates.findIndex(
      (u, i) => i > classificando && u.journey_stage === null && u.active_tool === null
    );
    expect(classificando).toBeGreaterThanOrEqual(0);
    expect(limpieza).toBeGreaterThan(classificando);

    expect(tiemposDe(info)).toMatchObject({ entregado: false });
  });

  /** Mismo resultado con una nota interna: tampoco es texto de cliente que leer. */
  it("un historial con solo una nota interna también deja traspaso sin_contenido_legible y limpia la etapa", async () => {
    const warn = vi.spyOn(log, "warn");
    const info = vi.spyOn(log, "info");
    state.history = [{ sender_type: "agent", content: "revisar con el proveedor", is_internal_note: true }];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("turno_sin_contenido_legible", { conversationId: "conv-1" });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({ p_to_kind: "unassigned", p_reason: "sin_contenido_legible" })
    );
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
    expect(tiemposDe(info)).toMatchObject({ entregado: false });
  });

  /**
   * El corte de red de OpenRouter del 7/9/2026 a las 11:57 UTC pasó
   * exactamente por esta puerta: el turno registraba el fallo en
   * `agent_turns` pero dejaba `journey_stage = "classifying"` sin limpiar.
   * Sin saludo previo (`welcome_sent_at` ya sellado, el default de la
   * suite) el último mensaje sigue siendo del cliente: el reconciliador
   * sigue recogiendo la conversación sola, así que acá NO hace falta
   * ningún traspaso nuevo (T2, "Seba sale sin pisar a nadie", 19/9/2026).
   */
  it("si la clasificación falla SIN saludo previo, la etapa se limpia y no hay traspaso nuevo", async () => {
    classifyIntentMock.mockRejectedValue(new Error("rate limit"));

    await runAgentTurn("conv-1");

    expect(agentTurnInserts).toContainEqual(expect.objectContaining({ action: "error" }));
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
    expect(handoffCalls).toHaveLength(0);
  });

  /**
   * T2, plan "Seba sale sin pisar a nadie" (19/9/2026, hallazgo A2), test
   * (a) de T12 (mismo plan, cierra la decisión abierta #1, 19/9/2026). Con
   * `welcome_sent_at: null` y una pregunta real detrás del saludo
   * (`introducedThisTurn` termina en `true`), el saludo de Seba sale y
   * QUEDA como el último mensaje visible. T2 tapaba la invisibilidad
   * escribiendo acá un `recordHandoff(entrega_fallida)` — T12 lo reemplaza:
   * ese traspaso volvía el caso irrecuperable cuando en realidad es seguro
   * reintentar (lo único que salió es la presentación, ya sellada). Ahora
   * el turno LANZA `ProviderFailedAfterGreetingError` (la cola lo
   * reintenta) y NO escribe ningún traspaso.
   */
  it("si la clasificación falla CON saludo previo, lanza ProviderFailedAfterGreetingError y NO escribe entrega_fallida", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    classifyIntentMock.mockRejectedValue(new Error("rate limit"));

    await expect(runAgentTurn("conv-1")).rejects.toMatchObject({
      name: "ProviderFailedAfterGreetingError",
      conversationId: "conv-1",
    });

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(agentTurnInserts).toContainEqual(expect.objectContaining({ action: "error" }));
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
    // El sello de `welcome_sent_at` queda puesto: el reintento no vuelve a
    // presentarse.
    expect(conversationUpdates).toContainEqual(expect.objectContaining({ welcome_sent_at: expect.any(String) }));
    expect(handoffCalls).toHaveLength(0);
  });

  /**
   * Antes este `catch` solo apagaba `active_tool` y dejaba `journey_stage`
   * congelado en "classifying"/"tool_running". Sin saludo previo, mismo
   * motivo que la clasificación fallida: el último mensaje sigue siendo del
   * cliente y el reconciliador la recoge como siempre. T12 (19/9/2026, test
   * (c) del plan) no cambia nada de este camino: sin saludo no hay nada que
   * reintentar de forma especial.
   */
  it("si el tool loop lanza SIN saludo previo, la etapa se limpia y no hay traspaso nuevo", async () => {
    generateMock.mockRejectedValue(new Error("fetch failed"));

    await runAgentTurn("conv-1");

    expect(agentTurnInserts).toContainEqual(expect.objectContaining({ action: "error" }));
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
    expect(handoffCalls).toHaveLength(0);
  });

  /**
   * T2, plan "Seba sale sin pisar a nadie" (19/9/2026, hallazgo A2), test
   * (b) de T12 (mismo plan, 19/9/2026). Mismo caso que la clasificación
   * fallida, pero para el `catch` del tool loop, y con un asesor YA
   * asignado (D2, "Seba atiende el mostrador": asignado + IA encendida
   * corre el turno igual). T12 reemplaza el `recordHandoff(entrega_fallida)`
   * de T2 por `ProviderFailedAfterGreetingError`: es seguro reintentar sin
   * importar quién esté asignado, porque lo único que salió es el saludo.
   */
  it("si el tool loop lanza CON saludo previo y asesor asignado, lanza ProviderFailedAfterGreetingError y NO escribe entrega_fallida", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null, assigned_agent_id: "agent-9" };
    generateMock.mockRejectedValue(new Error("fetch failed"));

    await expect(runAgentTurn("conv-1")).rejects.toMatchObject({
      name: "ProviderFailedAfterGreetingError",
      conversationId: "conv-1",
    });

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(agentTurnInserts).toContainEqual(expect.objectContaining({ action: "error" }));
    // Con dueño asignado, `stageFor` deja "assigned" en vez de `null`
    // (CLAUDE.md, trampa de la píldora "Escaladas" que mira el campo crudo).
    expect(conversationUpdates).toContainEqual({ journey_stage: "assigned", active_tool: null });
    expect(handoffCalls).toHaveLength(0);
  });
});

/**
 * Hallazgo C, revisión adversarial de la Tanda 1 (20/9/2026): la tercera
 * puerta del mismo hueco que T2/T12 cierran arriba para los fallos del
 * proveedor. Acá el proveedor NO falla — `agent.generate()` responde bien,
 * pero el tool loop agota `MAX_STEPS` sin volver a redactar texto (cinco
 * `consultarBiblioteca` seguidos, o `catalogOutcome.generico` bloqueando a
 * propósito la red de seguridad del catálogo) y sin que el modelo haya
 * llamado a `escalarAAsesor`. `text` queda `""` y `outcome.escalated` en
 * `false`.
 */
describe("runAgentTurn — texto vacío sin escalar tras agotar los pasos (Hallazgo C, 20/9/2026)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * C-1: CON saludo previo (`welcome_sent_at: null`, el default de la
   * suite de la presentación). El saludo sale bien —un solo envío— y el
   * turno, al llegar al final con `text` vacío y sin escalar, lanza
   * `ProviderFailedAfterGreetingError` en vez de terminar mudo: sin segundo
   * envío, sin traspaso nuevo, y la cola reintenta.
   */
  it("C-1: CON saludo previo, texto vacío sin escalar → lanza ProviderFailedAfterGreetingError, sin segundo envío ni traspaso", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    generateMock.mockResolvedValue({
      text: "",
      usage: { inputTokens: 20, outputTokens: 0, totalTokens: 20 },
      steps: [{}, {}, {}, {}, {}],
    });

    await expect(runAgentTurn("conv-1")).rejects.toMatchObject({
      name: "ProviderFailedAfterGreetingError",
      conversationId: "conv-1",
    });

    // Un solo envío: la presentación. El texto vacío del tool loop no generó
    // un segundo mensaje (ni vacío ni de cortesía).
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(handoffCalls).toHaveLength(0);
  });

  /**
   * C-2: mismo caso, SIN saludo previo (`welcome_sent_at` ya sellado, el
   * default de fábrica del `beforeEach` general). El turno NO lanza —el
   * último mensaje visible sigue siendo del cliente, el reconciliador lo
   * recoge solo— pero deja `log.warn("turno_sin_texto", …)` para que el caso
   * sea visible, y el resumen de `agent_turns` nombra los pasos gastados en
   * vez de quedar vacío.
   */
  it("C-2: SIN saludo previo, texto vacío sin escalar → no lanza, no envía, y queda el log.warn turno_sin_texto", async () => {
    const warn = vi.spyOn(log, "warn");
    generateMock.mockResolvedValue({
      text: "",
      usage: { inputTokens: 20, outputTokens: 0, totalTokens: 20 },
      steps: [{}, {}, {}, {}, {}],
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "turno_sin_texto",
      expect.objectContaining({ conversationId: "conv-1", pasos: 5 })
    );
    expect(handoffCalls).toHaveLength(0);
    expect(agentTurnInserts).toContainEqual(
      expect.objectContaining({ action: "answered", summary: expect.stringMatching(/sin texto tras/i) })
    );
  });

  /**
   * Verificación adicional pedida por la tarea: el modelo puede escalar por
   * su cuenta (llamando a `escalarAAsesor`, sin pasar por las redes de
   * seguridad de devolución/queja ni de catálogo — p. ej. una
   * `intencion_compra`) y devolver texto vacío después. Sin el bloque nuevo
   * de `agent.ts` (`if (outcome.escalated && !text.trim())`) el cliente se
   * quedaba sin una sola palabra aunque la conversación SÍ tuviera dueño:
   * `escalateConversation` ya había dejado su traspaso, pero el `if
   * (text.trim())` de más abajo saltaba el envío entero. Se simula la
   * llamada del modelo mutando `outcome` desde `buildEscalateToolMock`, como
   * el resto de este archivo (ver el comentario de ese mock).
   */
  it("el modelo escala por su cuenta (fuera de las redes de devolución/queja y catálogo) con texto vacío: igual se manda la despedida fija", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "otro",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    buildEscalateToolMock.mockImplementationOnce((_deps, outcome) => {
      Object.assign(outcome, {
        escalated: true,
        assignedAgentName: "María",
        unassigned: false,
        businessStatus: undefined,
        motivo: "intencion_compra",
      });
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "",
      usage: { inputTokens: 20, outputTokens: 0, totalTokens: 20 },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      DESPEDIDA_CON_ASESOR_ABIERTA,
      expect.objectContaining({ isAutoReply: true })
    );
    expect(agentTurnInserts).toContainEqual(
      expect.objectContaining({ action: "escalated" })
    );
  });
});

/**
 * T12, plan "Seba sale sin pisar a nadie" (19/9/2026, cierra la decisión
 * abierta #1). Los dos describes de arriba prueban las salidas que LANZAN el
 * error reintentable; este describe prueba el otro lado — el REINTENTO en
 * sí, que reconoce el saludo ya enviado y actúa distinto según lo que
 * encuentre.
 *
 * El reloj se fija en los tests que arman `sebaGreeting` a mano (mismo
 * patrón que el describe "la presentación de Seba, T2b" más arriba): nunca
 * el reloj real (trampa de CLAUDE.md).
 */
describe("runAgentTurn — el reintento tras ProviderFailedAfterGreetingError (T12, 19/9/2026)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Test (d) del plan: el historial que llega —armado por `loadHistory`
   * REAL a partir de la fila que dejaría `sendAgentText`, no un
   * `introducedThisTurn` inyectado a mano— termina en la presentación de
   * Seba seguida de la pregunta real del cliente. El reintento reconoce el
   * saludo, lo recorta, NO vuelve a saludar, y el historial que llega tanto
   * a `classifyIntent` como a `agent.generate` termina en el mensaje del
   * CLIENTE — nunca en el saludo.
   */
  it("reintento: no vuelve a saludar, clasifica y redacta con el historial terminado en el cliente", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T00:30:00Z")); // 8:30 pm en Caracas → franja "noche"
    // welcome_sent_at YA sellado: el primer intento reclamó la presentación
    // y la mandó antes de caerse.
    state.conversation = { ...state.conversation, welcome_sent_at: "2026-09-17T23:00:00Z" };
    // Descendente (más reciente primero), igual que el resto de este
    // archivo: el saludo de Seba es la fila MÁS reciente.
    state.history = [
      { sender_type: "agent", content: sebaGreeting("noche"), is_internal_note: false, created_at: "2026-09-18T00:29:00.000Z" },
      { sender_type: "customer", content: "hola, tienen pastillas de freno", is_internal_note: false, created_at: "2026-09-18T00:28:00.000Z" },
    ];

    await runAgentTurn("conv-1");

    // Un solo envío: la respuesta redactada. El saludo NO se repite.
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "respuesta redactada por el modelo",
      expect.anything()
    );
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    // El historial que le llegó a classifyIntent termina en el cliente, no
    // en el saludo — el primer argumento es el historial completo.
    const historialClasificado = classifyIntentMock.mock.calls[0][0] as { role: string; content: unknown }[];
    expect(historialClasificado.at(-1)).toMatchObject({ role: "user", content: "hola, tienen pastillas de freno" });
    expect(generateMock).toHaveBeenCalledTimes(1);
    // `buildInstructions` recibe `introducedThisTurn: true`: el sufijo usa
    // la variante "Seba acaba de presentarse en un mensaje aparte..." (la
    // misma que un turno que SÍ mandó el saludo este turno), no la de "ya te
    // presentaste antes" — para el modelo el saludo salió recién, aunque
    // haya sido en el intento anterior.
    expect(agentOptions[0].instructions.slice(SYSTEM_PROMPT.length)).toMatch(
      /seba acaba de presentarse en un mensaje aparte/i
    );
  });

  /**
   * T1, plan "Seba no habla de más mientras el cliente espera al asesor"
   * (22-23/9/2026): un reintento de T12 NUNCA escribió la marca "visto
   * hasta" (falló ANTES de responder, `marcarTurnoVisto` no corre en ese
   * camino) — así que, si existe alguna marca, es de un turno ANTERIOR al
   * que se está reintentando, y el mensaje del cliente que dispara este
   * reintento sigue siendo más nuevo que ella. El reintento no puede caer
   * en la salida nueva `turno_sin_mensaje_nuevo`.
   */
  it("reintento con una marca VIEJA (de un turno anterior, no de este): no dispara turno_sin_mensaje_nuevo, sigue redactando", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T00:30:00Z"));
    state.conversation = { ...state.conversation, welcome_sent_at: "2026-09-17T23:00:00Z" };
    state.history = [
      { sender_type: "agent", content: sebaGreeting("noche"), is_internal_note: false, created_at: "2026-09-18T00:29:00.000Z" },
      {
        sender_type: "customer",
        content: "hola, tienen pastillas de freno",
        is_internal_note: false,
        created_at: "2026-09-18T00:28:00.000Z",
        id: "m-pregunta",
      },
    ];
    // Marca de un turno bien anterior — nada que ver con el mensaje que se
    // está reintentando ahora.
    redisSeenStore.set(
      "turno:visto:conv-1",
      JSON.stringify({ hasta: "2026-09-17T22:00:00.000Z", ids: [] })
    );
    const info = vi.spyOn(log, "info");

    await runAgentTurn("conv-1");

    expect(info).not.toHaveBeenCalledWith("turno_sin_mensaje_nuevo", expect.anything());
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Test (d2) del plan: turno espurio. El primer intento mandó el saludo
   * como respuesta COMPLETA (`soloSaludo` — el cliente solo había dicho
   * "hola") y se cayó DESPUÉS, en un paso que ya no debería existir para un
   * turno tan simple (defensivo: lo que importa es que el reintento, al
   * encontrar `[hola, saludo]`, no tenga nada nuevo que redactar). Cierra
   * sin llamar al modelo ni escribir traspaso.
   */
  it("reintento sobre [hola, saludo]: turno espurio, cierra sin llamar al modelo ni traspaso", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: "2026-09-17T23:00:00Z" };
    state.history = [
      { sender_type: "agent", content: sebaGreeting("noche"), is_internal_note: false, created_at: "2026-09-18T00:29:00.000Z" },
      { sender_type: "customer", content: "hola", is_internal_note: false, created_at: "2026-09-18T00:28:00.000Z" },
    ];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(0);
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
  });

  /**
   * Test (d3) del plan: el cliente escribió DESPUÉS del saludo (mientras el
   * primer intento esperaba su reintento, o simplemente escribió de nuevo).
   * La última línea del historial ya NO es el asistente — es el cliente —
   * así que esto NO se reconoce como reintento: el saludo se queda en el
   * historial tal cual, y el turno corre normal (sin volver a presentarse,
   * porque `welcome_sent_at` ya está sellado).
   */
  it("el cliente escribió después del saludo: NO es un reintento, el saludo se queda en el historial", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: "2026-09-17T23:00:00Z" };
    state.history = [
      { sender_type: "customer", content: "¿y en talla M la tienen?", is_internal_note: false, created_at: "2026-09-18T00:30:00.000Z" },
      { sender_type: "agent", content: sebaGreeting("noche"), is_internal_note: false, created_at: "2026-09-18T00:29:00.000Z" },
      { sender_type: "customer", content: "hola, tienen pastillas de freno", is_internal_note: false, created_at: "2026-09-18T00:28:00.000Z" },
    ];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    const historialClasificado = classifyIntentMock.mock.calls[0][0] as { role: string; content: unknown }[];
    // El saludo SIGUE en el historial que ve el modelo, sin recortar.
    expect(historialClasificado.some((m) => m.content === sebaGreeting("noche"))).toBe(true);
    expect(historialClasificado.at(-1)).toMatchObject({ role: "user", content: "¿y en talla M la tienen?" });
  });

  /**
   * Test (e) del plan: reintento con "gracias" + escalada abierta. La
   * guarda de cortesía tras escalada sigue callando el turno — la ráfaga se
   * calcula SIN el saludo final (recortado antes de `customerBurst`), así
   * que ["gracias"] sigue siendo pura cortesía y la guarda dispara igual
   * que si el saludo nunca hubiera estado ahí.
   */
  it("reintento con 'gracias' + escalada abierta: la guarda de cortesía sigue callando", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: "2026-09-17T23:00:00Z" };
    state.history = [
      { sender_type: "agent", content: sebaGreeting("noche"), is_internal_note: false, created_at: "2026-09-18T00:29:00.000Z" },
      { sender_type: "customer", content: "gracias", is_internal_note: false, created_at: "2026-09-18T00:28:00.000Z" },
    ];
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-14T10:00:00.000Z" };
    state.agentMessagesAfterHandoff = [];

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({ p_reason: "cortesia_tras_escalada" });
  });

  /**
   * Test (f) del plan: `runAgentTurn` deja pasar el error TAL CUAL, sin
   * envolverlo en `NonRetryableTurnError` — es la mutación que el plan pide
   * verificar a mano (quitar la excepción del `catch` de `runAgentTurn` debe
   * romper este test).
   */
  it("runAgentTurn deja pasar ProviderFailedAfterGreetingError sin envolverlo en NonRetryableTurnError", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    classifyIntentMock.mockRejectedValue(new Error("rate limit"));

    let capturado: unknown;
    try {
      await runAgentTurn("conv-1");
    } catch (err) {
      capturado = err;
    }

    expect(capturado).toMatchObject({ name: "ProviderFailedAfterGreetingError" });
    expect((capturado as Error).name).not.toBe("NonRetryableTurnError");
  });
});

/**
 * S6, corrida "La IA ve lo que llega" (hallazgo 4, 8/9/2026). El corte de red
 * de OpenRouter del 7/9 a las 11:57 UTC dejó dos envíos `failed` con
 * `detalle: "fetch failed"` que el código de entonces trataba como rechazo
 * de Meta. `deliveryFailed` (antes `rejectedByMeta`) ahora bifurca por
 * `entrega.origenDelFallo`.
 */
describe("runAgentTurn — un corte de red no se confunde con un rechazo de Meta (S6)", () => {
  const FALLO_DE_RED = {
    whatsapp_message_id: null,
    whatsapp_status: "failed" as const,
    whatsapp_error_code: null,
    whatsapp_error_detail: "fetch failed",
    origenDelFallo: "red" as const,
  };

  it("la respuesta redactada del tool loop falla por red: entrega_fallida, no rechazado_por_meta, log de red, etapa reseteada", async () => {
    const error = vi.spyOn(log, "error");
    const warn = vi.spyOn(log, "warn");
    sendAgentTextMock.mockResolvedValueOnce(FALLO_DE_RED);

    await runAgentTurn("conv-1");

    expect(error).toHaveBeenCalledWith("turno_envio_fallo_de_red", {
      conversationId: "conv-1",
      detalle: "fetch failed",
    });
    expect(warn).not.toHaveBeenCalledWith("turno_rechazado_por_meta", expect.anything());
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({
        p_conversation_id: "conv-1",
        p_to_kind: "unassigned",
        p_reason: "entrega_fallida",
      })
    );
    expect(handoffCalls.some((call) => call.p_reason === "rechazado_por_meta")).toBe(false);
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
  });

  it("el escenario de fase 0 falla por red: también entrega_fallida, no se etiqueta ni se escala", async () => {
    const error = vi.spyOn(log, "error");
    const pb = playbook({
      afterSend: "escalate",
      tags: [{ id: "tag-envio", label: "Envio", color: "accent" as const }],
    });
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });
    sendPlaybookReplyMock.mockImplementation(async () => FALLO_DE_RED);

    await runAgentTurn("conv-1");

    expect(contactTagUpserts).toHaveLength(0);
    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("turno_envio_fallo_de_red", {
      conversationId: "conv-1",
      detalle: "fetch failed",
    });
    expect(handoffCalls).toContainEqual(
      expect.objectContaining({ p_to_kind: "unassigned", p_reason: "entrega_fallida" })
    );
    expect(conversationUpdates).toContainEqual({ journey_stage: null, active_tool: null });
  });

  /**
   * Mismo criterio que un rechazo de Meta: si ya hay una escalación previa
   * (asesor asignado, traspaso `escalada` ya escrito), un fallo de red en el
   * envío final NO agrega un segundo traspaso `unassigned` que pisaría al
   * asesor ya asignado. Solo queda el log.
   */
  it("ya escalada + fallo de red: solo se registra el log, sin traspaso nuevo", async () => {
    const error = vi.spyOn(log, "error");
    classifyIntentMock.mockResolvedValue({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    escalateConversationMock.mockImplementation(async (...args: unknown[]) => {
      const [supabaseArg, params] = args as [
        { rpc: (fn: string, params: Record<string, unknown>) => Promise<unknown> },
        { conversationId: string },
      ];
      await supabaseArg.rpc("record_handoff", {
        p_conversation_id: params.conversationId,
        p_to_kind: "human",
        p_reason: "escalada",
        p_to_id: "asesor-42",
      });
      return { escalated: true, assignedAgentName: "María" };
    });
    sendAgentTextMock.mockResolvedValueOnce(FALLO_DE_RED);

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({ p_to_kind: "human", p_reason: "escalada", p_to_id: "asesor-42" });
    expect(error).toHaveBeenCalledWith("turno_envio_fallo_de_red", {
      conversationId: "conv-1",
      detalle: "fetch failed",
    });
    // journey_stage ya quedó "assigned" por la escalación: no se pisa con null.
    expect(conversationUpdates).not.toContainEqual({ journey_stage: null, active_tool: null });
  });
});

/**
 * Corrección 5/9/2026 (HUECO 2). En devolución/queja, la escalación forzada
 * (`escalateConversation`) corre ANTES del envío final y ya deja su propio
 * traspaso —`escalada` con asesor, `escalada_sin_asesor` sin uno—. Si ese
 * envío final es justo el que Meta rechaza, `rejectedByMeta()` no debe
 * escribir un SEGUNDO traspaso `unassigned`: como el conteo "Sin dueño" mira
 * la ÚLTIMA fila de `conversation_handoffs`, una conversación que sí quedó
 * con asesor asignado aparecería como sin dueño. Un solo traspaso por
 * salida, el más específico.
 */
describe("runAgentTurn — un solo traspaso por salida cuando la escalación forzada y el rechazo de Meta coinciden", () => {
  /**
   * El mock de `escalateConversation` no ejecuta el código real de
   * escalate.ts (está reemplazado por `vi.mock`), así que para probar "un
   * solo recordHandoff" hay que dejar que ESTE mock deje su traspaso, tal
   * como lo hace la función real ANTES de devolver.
   */
  it("queja escalada a un asesor + envío final rechazado por Meta: un solo recordHandoff, el de la escalación", async () => {
    const warn = vi.spyOn(log, "warn");
    classifyIntentMock.mockResolvedValue({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    escalateConversationMock.mockImplementation(async (...args: unknown[]) => {
      const [supabaseArg, params] = args as [
        { rpc: (fn: string, params: Record<string, unknown>) => Promise<unknown> },
        { conversationId: string },
      ];
      pasos.push("escalar");
      // Espeja lo que hace escalate.ts de verdad: deja su propio traspaso
      // ANTES de devolver, con el asesor ya asignado.
      await supabaseArg.rpc("record_handoff", {
        p_conversation_id: params.conversationId,
        p_to_kind: "human",
        p_reason: "escalada",
        p_to_id: "asesor-42",
      });
      return { escalated: true, assignedAgentName: "María" };
    });
    sendAgentTextMock.mockResolvedValueOnce({
      whatsapp_message_id: null,
      whatsapp_status: "failed" as const,
      whatsapp_error_code: 131047,
      whatsapp_error_detail: "Meta rechazó el envío",
      origenDelFallo: "meta" as const,
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    // Exactamente UN traspaso, y es el de la escalación — no un segundo
    // `rechazado_por_meta` que lo pisara.
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "human",
      p_reason: "escalada",
      p_to_id: "asesor-42",
    });
    // El rechazo de Meta sí se ve en el registro: solo se omite la bitácora.
    expect(warn).toHaveBeenCalledWith("turno_rechazado_por_meta", {
      conversationId: "conv-1",
      codigo: 131047,
      traspaso_omitido: "escalada_previa",
    });
    // A3 (5/9/2026): tampoco se pisa journey_stage. escalateConversation ya
    // dejó "assigned" antes del envío rechazado — resetear acá a null
    // disfrazaría de "sin escalar" un caso que sí tiene asesor.
    expect(conversationUpdates).not.toContainEqual({ journey_stage: null, active_tool: null });
  });

  /** El caso que ya existía (cubierto también en handoffs.test.ts) sigue igual: sin escalación previa, el rechazo de Meta registra su propio traspaso. */
  it("sin escalación previa, el rechazo de Meta en el tool loop sigue registrando rechazado_por_meta", async () => {
    const warn = vi.spyOn(log, "warn");
    sendAgentTextMock.mockResolvedValueOnce({
      whatsapp_message_id: null,
      whatsapp_status: "failed" as const,
      whatsapp_error_code: 131047,
      whatsapp_error_detail: "Meta rechazó el envío",
      origenDelFallo: "meta" as const,
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("turno_rechazado_por_meta", {
      conversationId: "conv-1",
      codigo: 131047,
    });
    expect(handoffCalls).toHaveLength(1);
    expect(handoffCalls[0]).toMatchObject({
      p_conversation_id: "conv-1",
      p_to_kind: "unassigned",
      p_reason: "rechazado_por_meta",
    });
  });
});

/**
 * Anexo A1 (5/9/2026): la despedida de la IA al escalar sin asesores no
 * cuenta como respuesta real. Cubre los dos caminos por los que la IA se
 * despide sin nadie detrás —la red de seguridad de devolución/queja, y el
 * modelo que redacta su propia despedida tras invocar la herramienta— y los
 * dos controles: con asesor asignado, y una respuesta que ni siquiera
 * escaló.
 *
 * Tarea 5 ("La voz cercana y la espera visible", 14/9/2026): la promesa de
 * un asesor TAMPOCO cuenta como respuesta real, tenga o no asesor asignado
 * — 170 promesas ≥ 30 min sin cumplir en la auditoría de esta tarea, 23 de
 * ellas nunca atendidas. El caso (c), que hasta acá era el CONTROL de "con
 * asesor no lleva la marca", pasa a ser justo lo contrario.
 */
describe("runAgentTurn — anexo A1 + Tarea 5: is_auto_reply en la despedida de la IA al escalar", () => {
  it("(a) red de seguridad de queja sin asesores: el texto fijo sale con isAutoReply true", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    // El modelo no redacta nada (tool loop agotado sin escalar de verdad):
    // el texto que sale es el fijo que arma la red de seguridad.
    generateMock.mockResolvedValueOnce({
      text: "",
      usage: { inputTokens: 20, outputTokens: 0, totalTokens: 20 },
      steps: [{}],
    });
    escalateConversationMock.mockImplementation(async () => {
      pasos.push("escalar");
      return { escalated: true, assignedAgentName: null, unassigned: true };
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      DESPEDIDA_SIN_ASESOR,
      { isAutoReply: true }
    );
  });

  it("(b) el modelo llama a escalarAAsesor, queda sin asesor y redacta su propia despedida: isAutoReply true", async () => {
    // Simula lo que haría la herramienta real (`buildEscalateTool`) si el
    // modelo la invocara durante el tool loop: mutar el `outcome` que le
    // llegó ANTES de que `agent.generate()` devuelva texto.
    buildEscalateToolMock.mockImplementationOnce((_deps, outcome) => {
      outcome.escalated = true;
      outcome.assignedAgentName = undefined;
      outcome.unassigned = true;
      pasos.push("escalar");
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "Ya dejé tu caso registrado, en cuanto haya alguien libre te escribe.",
      usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "Ya dejé tu caso registrado, en cuanto haya alguien libre te escribe.",
      { isAutoReply: true }
    );
  });

  /**
   * (a) del checklist de la Tarea 5: escalación CON asesor, el mensaje al
   * cliente lleva `is_auto_reply: true`. Hasta el 14/9/2026 este mismo test
   * era el CONTROL negativo ("con asesor no lleva la marca") — la auditoría
   * de esta tarea encontró que esa era justo la falla: la conversación
   * apagaba `awaiting_reply` con una promesa, no con una respuesta real, y
   * desaparecía de "Pendientes" y de "Tuyas" del asesor asignado.
   */
  it("(c) escalación CON asesor: isAutoReply true — la promesa tampoco es respuesta (Tarea 5, 14/9/2026)", async () => {
    buildEscalateToolMock.mockImplementationOnce((_deps, outcome) => {
      outcome.escalated = true;
      outcome.assignedAgentName = "María";
      outcome.unassigned = false;
      pasos.push("escalar");
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "Ya te paso con María, ella te ayuda con esto.",
      usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toBe("Ya te paso con María, ella te ayuda con esto.");
    const opciones = llamada[3] as { isAutoReply?: boolean } | undefined;
    expect(opciones?.isAutoReply).toBe(true);
  });

  it("(d) respuesta normal sin escalar: sin la marca", async () => {
    await runAgentTurn("conv-1");

    const llamada = sendAgentTextMock.mock.calls[0];
    const opciones = llamada[3] as { isAutoReply?: boolean } | undefined;
    expect(opciones?.isAutoReply).not.toBe(true);
  });
});

/**
 * T3, "Seba atiende el mostrador" (18/9/2026, requisitos 2/3/4/5 del
 * cliente): la red de seguridad del catálogo — mismo patrón que la red de
 * devolución/queja (A1, arriba), pero mirando `catalogOutcome` en vez de
 * `intent`. `buildCatalogToolMock` simula lo que haría `buildCatalogTool`
 * real si el modelo llamara a `buscarRepuesto` durante el tool loop: mutar
 * el `catalogOutcome` que `runTurnPhases` construye ANTES de invocar
 * `agent.generate()`.
 */
describe("runAgentTurn — T3: red de seguridad del catálogo", () => {
  it("con existencia y sin escalada del modelo, escala en código con confirmar_inventario y is_auto_reply", async () => {
    buildCatalogToolMock.mockImplementationOnce((_deps, catalogOutcome) => {
      catalogOutcome.ran = true;
      catalogOutcome.conExistencia = true;
      return {};
    });
    // El modelo cotizó, pero se quedó sin pasos antes de llamar a
    // `escalarAAsesor` — no menciona "asesor", así que la red debe anexarlo.
    generateMock.mockResolvedValueOnce({
      text: "Tenemos el carburador en $18 y 12 unidades.",
      usage: NO_USAGE,
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: "conv-1", motivo: "confirmar_inventario" })
    );
    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toBe(`Tenemos el carburador en $18 y 12 unidades.\n${TEXTO_CONFIRMAR_INVENTARIO}`);
    const opciones = llamada[3] as { isAutoReply?: boolean } | undefined;
    expect(opciones?.isAutoReply).toBe(true);
  });

  it("agotados: escala en código con sin_stock y anexa el texto fijo", async () => {
    buildCatalogToolMock.mockImplementationOnce((_deps, catalogOutcome) => {
      catalogOutcome.ran = true;
      catalogOutcome.agotados = true;
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "Por ahora no quedan unidades de ese repuesto.",
      usage: NO_USAGE,
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: "conv-1", motivo: "sin_stock" })
    );
    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toContain(TEXTO_SIN_STOCK);
  });

  it("sin resultados: escala en código con no_identificado y anexa el texto fijo", async () => {
    buildCatalogToolMock.mockImplementationOnce((_deps, catalogOutcome) => {
      catalogOutcome.ran = true;
      catalogOutcome.sinResultados = true;
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "No tengo ese repuesto en el catálogo.",
      usage: NO_USAGE,
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: "conv-1", motivo: "no_identificado" })
    );
    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toContain(TEXTO_NO_IDENTIFICADO);
  });

  /**
   * Mutación de verificación de la tarea (ver el reporte final): cambiar
   * `!catalogOutcome.generico` por `true` en la red de seguridad de
   * `agent.ts` tiene que poner ESTE test en rojo.
   */
  it("genérico: NO escala en código aunque el modelo se haya quedado sin pasos", async () => {
    buildCatalogToolMock.mockImplementationOnce((_deps, catalogOutcome) => {
      catalogOutcome.ran = true;
      catalogOutcome.generico = true;
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "Claro, ¿para qué modelo y año de moto las buscas?",
      usage: NO_USAGE,
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toBe("Claro, ¿para qué modelo y año de moto las buscas?");
    const opciones = llamada[3] as { isAutoReply?: boolean } | undefined;
    expect(opciones?.isAutoReply).not.toBe(true);
  });

  /**
   * Mutación de verificación (resguardo antes del push, 20/9/2026): el
   * inventario tenía dudas sobre la PRECEDENCIA cuando dos llamadas del
   * mismo turno dejan más de una bandera encendida a la vez —
   * `CatalogOutcome` se ACUMULA, nunca se resetea (ver tools.ts). Cambiar el
   * orden del `? :` en `agent.ts` (mirar `agotados` antes que
   * `conExistencia`) tiene que poner ESTE test en rojo: `conExistencia` va
   * primero porque "hay unidades de ALGO" pesa más que "otra búsqueda del
   * mismo turno no encontró nada en stock".
   */
  it("con conExistencia Y agotados a la vez (dos búsquedas del mismo turno), gana confirmar_inventario", async () => {
    buildCatalogToolMock.mockImplementationOnce((_deps, catalogOutcome) => {
      catalogOutcome.ran = true;
      catalogOutcome.conExistencia = true;
      catalogOutcome.agotados = true;
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "Tenemos el carburador en $18, pero las pastillas están agotadas.",
      usage: NO_USAGE,
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: "conv-1", motivo: "confirmar_inventario" })
    );
    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toContain(TEXTO_CONFIRMAR_INVENTARIO);
    expect(llamada[2]).not.toContain(TEXTO_SIN_STOCK);
  });

  /**
   * Mutación de verificación: la rama `text.trim() ? … : textoFijo` de
   * `agent.ts` — con el modelo devolviendo texto VACÍO (se quedó sin pasos
   * antes de redactar nada), el texto fijo tiene que ser la respuesta
   * ENTERA, sin un salto de línea sobrante al principio. Fusionar la rama en
   * un solo template literal (`` `${text.trim()}\n${textoFijo}` ``) deja un
   * "\n" colgando al inicio y este test se pone en rojo.
   */
  it("con texto vacío del modelo, el texto fijo es la respuesta ENTERA (sin salto de línea sobrante)", async () => {
    buildCatalogToolMock.mockImplementationOnce((_deps, catalogOutcome) => {
      catalogOutcome.ran = true;
      catalogOutcome.conExistencia = true;
      return {};
    });
    generateMock.mockResolvedValueOnce({ text: "", usage: NO_USAGE, steps: [{}, {}] });

    await runAgentTurn("conv-1");

    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toBe(TEXTO_CONFIRMAR_INVENTARIO);
  });

  it("el modelo ya dijo 'asesor': no se anexa el texto fijo por encima", async () => {
    buildCatalogToolMock.mockImplementationOnce((_deps, catalogOutcome) => {
      catalogOutcome.ran = true;
      catalogOutcome.conExistencia = true;
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "Tenemos el carburador disponible; ya te paso con un asesor para confirmar.",
      usage: NO_USAGE,
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toBe("Tenemos el carburador disponible; ya te paso con un asesor para confirmar.");
    expect(llamada[2]).not.toContain(TEXTO_CONFIRMAR_INVENTARIO);
  });

  it("el modelo ya escaló (llamó a escalarAAsesor de verdad): la red del catálogo no vuelve a escalar", async () => {
    buildCatalogToolMock.mockImplementationOnce((_deps, catalogOutcome) => {
      catalogOutcome.ran = true;
      catalogOutcome.conExistencia = true;
      return {};
    });
    buildEscalateToolMock.mockImplementationOnce((_deps, outcome) => {
      outcome.escalated = true;
      outcome.assignedAgentName = "María";
      outcome.motivo = "confirmar_inventario";
      pasos.push("escalar");
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "Tenemos el carburador disponible, ya te paso con María para confirmar el inventario.",
      usage: NO_USAGE,
      steps: [{}, {}, {}],
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toBe("Tenemos el carburador disponible, ya te paso con María para confirmar el inventario.");
  });
});

/**
 * T2, plan "La escalada se hace una vez y la búsqueda responde" (21/9/2026,
 * D2 del operador). Medido en producción el 21/9/2026: en la primera hora
 * del deploy, 24 de 34 turnos escalados eran repeticiones sobre un chat que
 * YA tenía asesor asignado (bastaban 9). El modelo no sabía que el chat ya
 * tenía dueño: `buildInstructions` no recibía nada que lo dijera, y las dos
 * redes de seguridad en código (devolución/queja, catálogo) llamaban a
 * `escalateConversation` igual que en un chat sin asesor —`escalate.ts` ya
 * lo detectaba (rama `alreadyAssigned`, solo deja una nota interna), pero la
 * vuelta completa al proveedor ya se había pagado.
 */
describe("runAgentTurn — T2: el modelo sabe que el chat ya tiene asesor (21/9/2026)", () => {
  it("sin asesor asignado, buildEscalateTool se arma sin restricción, como siempre", async () => {
    await runAgentTurn("conv-1");

    expect(buildEscalateToolMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ restrictedToPurchase: false })
    );
    expect(Object.keys(agentOptions[0].tools)).toContain("escalarAAsesor");
    // Sin asesor, el sufijo no menciona ninguna asignación previa.
    expect(agentOptions[0].instructions.slice(SYSTEM_PROMPT.length)).not.toMatch(/YA está asignado a un asesor/);
  });

  it("con asesor asignado y deal_status distinto de in_progress, la herramienta se arma en modo restringido", async () => {
    state.conversation = { ...state.conversation, assigned_agent_id: "agent-9", deal_status: "none" };

    await runAgentTurn("conv-1");

    expect(buildEscalateToolMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ restrictedToPurchase: true })
    );
    expect(Object.keys(agentOptions[0].tools)).toContain("escalarAAsesor");
    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toMatch(/YA está asignado a un asesor/);
    expect(sufijo).toMatch(/solo usa escalarAAsesor/i);
  });

  it("con asesor asignado y deal_status ya en in_progress, la herramienta se OMITE del todo", async () => {
    state.conversation = { ...state.conversation, assigned_agent_id: "agent-9", deal_status: "in_progress" };

    await runAgentTurn("conv-1");

    expect(buildEscalateToolMock).not.toHaveBeenCalled();
    expect(Object.keys(agentOptions[0].tools)).not.toContain("escalarAAsesor");
    // El sufijo sigue avisando que ya hay asesor, pero sin nombrar una
    // herramienta que este turno no recibió.
    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toMatch(/YA está asignado a un asesor/);
    expect(sufijo).not.toMatch(/escalarAAsesor/i);
  });

  it("un turno sobre un chat asignado responde al cliente sin llamar a escalateConversation ni dejar traspaso nuevo", async () => {
    state.conversation = { ...state.conversation, assigned_agent_id: "agent-9", deal_status: "none" };

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(handoffCalls).toHaveLength(0);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "respuesta redactada por el modelo",
      expect.objectContaining({ isAutoReply: true })
    );
  });

  /**
   * La red de seguridad de devolución/queja se SALTA con asesor asignado:
   * escalar de nuevo un chat que ya tiene dueño solo dejaría una nota
   * interna en `escalate.ts` (rama `alreadyAssigned`) sin ningún efecto
   * nuevo — el modelo, en modo restringido, ni siquiera puede pedirlo (el
   * esquema de `motivo` no admite "devolucion").
   */
  it("con asesor asignado, la red de devolución/queja NO llama a escalateConversation", async () => {
    state.conversation = { ...state.conversation, assigned_agent_id: "agent-9", deal_status: "none" };
    classifyIntentMock.mockResolvedValue({
      intent: "devolucion",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    generateMock.mockResolvedValueOnce({
      text: "Ya reviso tu caso, dame un segundo.",
      usage: NO_USAGE,
      steps: [{}],
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toBe("Ya reviso tu caso, dame un segundo.");
  });

  /** Regresión: sin asesor asignado, la red de devolución/queja sigue corriendo (test (f) del describe de la guarda de identidad, más arriba, ya la ejercita). */
  it("sin asesor asignado, la red de devolución/queja SÍ llama a escalateConversation (regresión)", async () => {
    classifyIntentMock.mockResolvedValue({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    generateMock.mockResolvedValueOnce({ text: "", usage: NO_USAGE, steps: [{}] });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
  });

  /**
   * La red de seguridad del catálogo se SALTA con asesor asignado —no llama
   * a `escalateConversation`— pero el texto fijo del requisito 2/3/4 del
   * cliente ("Seba atiende el mostrador") se sigue anexando si el modelo no
   * mencionó "asesor": el chat ya tiene dueño, pero la respuesta igual tiene
   * que nombrarlo.
   */
  it("con asesor asignado, la red del catálogo NO escala pero sigue anexando el texto fijo", async () => {
    state.conversation = { ...state.conversation, assigned_agent_id: "agent-9", deal_status: "none" };
    buildCatalogToolMock.mockImplementationOnce((_deps, catalogOutcome) => {
      catalogOutcome.ran = true;
      catalogOutcome.conExistencia = true;
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "Tenemos el carburador en $18 y 12 unidades.",
      usage: NO_USAGE,
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    const llamada = sendAgentTextMock.mock.calls[0];
    expect(llamada[2]).toBe(`Tenemos el carburador en $18 y 12 unidades.\n${TEXTO_CONFIRMAR_INVENTARIO}`);
    const opciones = llamada[3] as { isAutoReply?: boolean } | undefined;
    expect(opciones?.isAutoReply).toBe(true);
  });

  /** Regresión: sin asesor, la red del catálogo sigue escalando en código (ya cubierto por el describe T3 de arriba; se repite acá el caso mínimo para dejar el contraste explícito). */
  it("sin asesor asignado, la red del catálogo SÍ llama a escalateConversation (regresión)", async () => {
    buildCatalogToolMock.mockImplementationOnce((_deps, catalogOutcome) => {
      catalogOutcome.ran = true;
      catalogOutcome.conExistencia = true;
      return {};
    });
    generateMock.mockResolvedValueOnce({
      text: "Tenemos el carburador en $18 y 12 unidades.",
      usage: NO_USAGE,
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Punto 3 del prompt de la tarea: qué pasa con un chat asignado donde el
   * modelo termina SIN texto y SIN escalar — mismo comportamiento que sin
   * asesor (Hallazgo C, 20/9/2026): sin saludo previo, no lanza y deja
   * `turno_sin_texto`; no hay ninguna rama nueva para este caso.
   */
  it("con asesor asignado, texto vacío sin escalar → no lanza, deja turno_sin_texto (mismo comportamiento que sin asesor)", async () => {
    state.conversation = { ...state.conversation, assigned_agent_id: "agent-9", deal_status: "none" };
    const warn = vi.spyOn(log, "warn");
    classifyIntentMock.mockResolvedValue({
      intent: "devolucion",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    generateMock.mockResolvedValue({
      text: "",
      usage: { inputTokens: 20, outputTokens: 0, totalTokens: 20 },
      steps: [{}, {}, {}, {}, {}],
    });

    await runAgentTurn("conv-1");

    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "turno_sin_texto",
      expect.objectContaining({ conversationId: "conv-1", pasos: 5 })
    );
    expect(handoffCalls).toHaveLength(0);
  });
});

/**
 * `despedidaConAsesor` (agent.ts) es la función pura; estos primeros cuatro
 * casos la ejercen directo, sin levantar `runAgentTurn`.
 */
describe("despedidaConAsesor — texto según el horario (Tarea 5, 14/9/2026)", () => {
  it("tienda abierta: promesa genérica, sin horario", () => {
    // Tarea 3 (14/9/2026): texto reescrito para sonar de mostrador — dice
    // por qué (para que te ayude con esto) y qué va a pasar (te escriba por
    // acá), regla "CÓMO SUENAS" del prompt (prompt.ts).
    expect(despedidaConAsesor({ open: true, closesAt: "6:00 pm", nextOpening: null })).toBe(
      "Dame un momentico: ya le paso tu caso a un asesor para que te ayude con esto y te escriba por acá."
    );
  });

  it("tienda cerrada con próxima apertura: nombra el día y la hora", () => {
    const texto = despedidaConAsesor({
      open: false,
      closesAt: null,
      nextOpening: { dayLabel: "el lunes", time: "8:00 am" },
    });

    expect(texto).toContain("el lunes");
    expect(texto).toContain("8:00 am");
  });

  it("tienda cerrada sin ninguna apertura en los próximos 7 días: no inventa una fecha", () => {
    const texto = despedidaConAsesor({ open: false, closesAt: null, nextOpening: null });

    expect(texto).not.toMatch(/undefined/);
    expect(texto).toMatch(/vuelva a abrir/);
  });

  it("sin status (compatibilidad): se trata igual que tienda abierta", () => {
    expect(despedidaConAsesor(undefined)).toBe(DESPEDIDA_CON_ASESOR_ABIERTA);
  });
});

/**
 * Extremo a extremo: que `outcome.businessStatus` viaje desde
 * `escalateConversation` hasta el texto que de verdad sale por
 * `sendAgentText`, en el camino de la red de seguridad de devolución/queja
 * (agent.ts, ~1380). Es el mismo camino que antes solo sabía mandar
 * `DESPEDIDA_SIN_ASESOR`/el texto fijo sin horario — Tarea 5, 14/9/2026,
 * decisión 6.
 */
describe("runAgentTurn — la despedida CON asesor de la red de seguridad nombra el horario (Tarea 5, 14/9/2026)", () => {
  function forzarQuejaSinTexto() {
    classifyIntentMock.mockResolvedValue({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    // El modelo no redacta nada (tool loop agotado sin escalar de verdad):
    // el texto que sale es el que arma la red de seguridad, forzando el
    // camino que decide despedidaConAsesor.
    generateMock.mockResolvedValueOnce({
      text: "",
      usage: { inputTokens: 20, outputTokens: 0, totalTokens: 20 },
      steps: [{}],
    });
  }

  it("con asesor y tienda abierta: no promete un horario", async () => {
    forzarQuejaSinTexto();
    escalateConversationMock.mockImplementation(async () => {
      pasos.push("escalar");
      return {
        escalated: true,
        assignedAgentName: "María",
        businessStatus: { open: true, closesAt: "6:00 pm", nextOpening: null },
      };
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock.mock.calls[0][2]).toBe(DESPEDIDA_CON_ASESOR_ABIERTA);
  });

  it("con asesor y tienda cerrada: nombra cuándo escribe el asesor", async () => {
    forzarQuejaSinTexto();
    escalateConversationMock.mockImplementation(async () => {
      pasos.push("escalar");
      return {
        escalated: true,
        assignedAgentName: "María",
        businessStatus: { open: false, closesAt: null, nextOpening: { dayLabel: "el lunes", time: "8:00 am" } },
      };
    });

    await runAgentTurn("conv-1");

    const textoEnviado = sendAgentTextMock.mock.calls[0][2] as string;
    expect(textoEnviado).toContain("lunes");
    expect(textoEnviado).toContain("8:00 am");
    expect(revealsIdentity(textoEnviado)).toBeNull();
  });
});

/**
 * "Escribiendo…" hacia el cliente (T3.1, 4/9/2026): se dispara justo al
 * arrancar el tool loop, y solo cuando de verdad hay a quién avisarle — canal
 * conectado, dentro de la ventana de 24h y con un mensaje entrante al que
 * apuntar. Ninguno de los tests de arriba lo dispara: su canal por defecto es
 * `demo` (ver beforeEach), así que este describe es el único que lo activa a
 * propósito.
 */
describe("runAgentTurn — 'escribiendo…' hacia el cliente", () => {
  beforeEach(() => {
    state.conversation = {
      ...state.conversation,
      channel: { phone_number_id: "phone-id-1", status: "connected" },
    };
    process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba";
  });

  afterEach(() => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
  });

  it("lo dispara sin esperar a que el modelo termine de redactar, con el wamid del último mensaje entrante", async () => {
    const ordenDeLlamadas: string[] = [];
    sendTypingIndicatorMock.mockImplementation(async () => {
      ordenDeLlamadas.push("typing");
    });
    // El modelo queda deliberadamente colgado: si el typing dependiera de que
    // `generate` termine (o corriera DESPUÉS de él), este test se quedaría
    // esperando para siempre en el primer `waitFor` de abajo.
    let resolverGenerate: () => void = () => {};
    generateMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolverGenerate = () => {
            ordenDeLlamadas.push("generate");
            resolve({
              text: "respuesta redactada por el modelo",
              usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
              steps: [{}, {}],
            });
          };
        })
    );

    const turno = runAgentTurn("conv-1");

    await vi.waitFor(() => expect(sendTypingIndicatorMock).toHaveBeenCalledTimes(1));
    expect(sendTypingIndicatorMock).toHaveBeenCalledWith("phone-id-1", "token-de-prueba", "wamid.ULTIMO_ENTRANTE");
    // El aviso ya llegó y el modelo TODAVÍA no devolvió nada: no lo esperó.
    expect(ordenDeLlamadas).toEqual(["typing"]);

    resolverGenerate();
    await turno;

    expect(ordenDeLlamadas).toEqual(["typing", "generate"]);
  });

  it("no lo dispara cuando el escenario responde: ese camino no redacta con el modelo", async () => {
    const pb = playbook();
    fetchActivePlaybooksMock.mockResolvedValue([pb]);
    matchPlaybookMock.mockResolvedValue({ playbook: pb, usage: NO_USAGE });

    await runAgentTurn("conv-1");

    expect(sendTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("no lo dispara fuera de la ventana de 24h de Meta", async () => {
    state.conversation = {
      ...state.conversation,
      last_customer_message_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };

    await runAgentTurn("conv-1");

    expect(sendTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("no lo dispara con el canal simulado (no 'connected')", async () => {
    state.conversation = { ...state.conversation, channel: { phone_number_id: null, status: "demo" } };

    await runAgentTurn("conv-1");

    expect(sendTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("no lo dispara sin WHATSAPP_ACCESS_TOKEN en el servidor", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;

    await runAgentTurn("conv-1");

    expect(sendTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("no lo dispara sin ningún mensaje entrante con wamid", async () => {
    state.lastInboundWamid = null;

    await runAgentTurn("conv-1");

    expect(sendTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("un fallo del typing no aborta el turno: el cliente igual recibe la respuesta", async () => {
    sendTypingIndicatorMock.mockRejectedValue(new Error("no debería pasar, pero si pasa no debe tumbar el turno"));

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Guarda de identidad (6/9/2026): último control antes de hablarle al
 * cliente, sobre el texto final del tool loop —después de la red de
 * seguridad de devolución/queja, justo antes del envío de la redacción. El
 * 26 y 27/8/2026 la IA se despidió como "el asistente automatizado de SBK
 * Motorcycles" 34 de 68 y 26 de 151 veces pese a que el SYSTEM_PROMPT ya lo
 * prohibía; esta es la cerradura para cuando el guion vuelve a fallar.
 */
describe("runAgentTurn — guarda de identidad", () => {
  it("(a) texto limpio: pasa sin llamada extra a generateText", async () => {
    const warn = vi.spyOn(log, "warn");
    const error = vi.spyOn(log, "error");
    // Negativo del catálogo a propósito: "automático" es un repuesto, no una
    // autorreferencia — revealsIdentity no debe calzar acá.
    generateMock.mockResolvedValueOnce({
      text: "El automático de la Horse está en 12$ a tasa BCV",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe("El automático de la Horse está en 12$ a tasa BCV");
    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(agentTurnInserts[0].summary).not.toMatch(/^\[identidad/);
    expect(warn).not.toHaveBeenCalledWith("identidad_reescrita", expect.anything());
    expect(error).not.toHaveBeenCalledWith("identidad_bloqueada", expect.anything());
  });

  it("(b) texto que calza: se reescribe una vez y sale limpio", async () => {
    const warn = vi.spyOn(log, "warn");
    const borrador =
      "¡Buenos días! Soy el asistente automatizado de SBK Motorcycles. El automático de la Horse está en 12$.";
    const reescrito = "¡Buenos días! Acá en SBK el automático de la Horse está en 12$.";
    generateMock.mockResolvedValueOnce({
      text: borrador,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });
    generateTextMock.mockResolvedValueOnce({
      text: reescrito,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });

    await runAgentTurn("conv-1");

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const opciones = generateTextMock.mock.calls[0][0] as {
      system: string;
      messages: { role: string; content: string }[];
      maxRetries: number;
      maxOutputTokens: number;
    };
    expect(opciones.system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(opciones.system).toContain("asistente automatizado");
    expect(opciones.messages).toEqual([{ role: "user", content: borrador }]);
    expect(opciones.maxRetries).toBe(0);
    // Techo de salida (T5, plan "Nada se pierde en un corte ni en un
    // deploy", 21-22/9/2026, hallazgo 5): esta llamada corría sin ninguno.
    // Literal, no el símbolo importado -- regla de "El resguardo antes del
    // push", 20/9/2026: un tope medido contra su propio símbolo no prueba el
    // número si alguien lo cambia en el código de producción.
    expect(opciones.maxOutputTokens).toBe(1500);
    expect(getAgentModelCalls).toContain("low");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe(reescrito);
    // Nunca el borrador que se delataba.
    expect(sendAgentTextMock.mock.calls.some((llamada) => llamada[2] === borrador)).toBe(false);
    expect(escalateConversationMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("identidad_reescrita", {
      conversationId: "conv-1",
      categoria: "automatizacion",
      fragmento: "asistente automatizado",
    });

    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({ action: "answered" });
    expect((agentTurnInserts[0].summary as string).startsWith("[identidad reescrita]")).toBe(true);
    // 4 (reconocimiento de escenario, NO_USAGE del beforeEach) + 6
    // (clasificación) + 28 (redacción) + 14 (reescritura) = 52.
    expect(agentTurnInserts[0].total_tokens).toBe(52);
  });

  it("(c) reescrito que sigue calzando: se bloquea, se escala por 'seguimiento' y sale la despedida CON asesor", async () => {
    const error = vi.spyOn(log, "error");
    const borrador =
      "¡Buenos días! Soy el asistente automatizado de SBK Motorcycles. El automático de la Horse está en 12$.";
    const reescritoQueSigueCalzando = "Soy un asistente virtual de SBK, el automático está en 12$.";
    generateMock.mockResolvedValueOnce({
      text: borrador,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });
    generateTextMock.mockResolvedValueOnce({
      text: reescritoQueSigueCalzando,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    // Mock por defecto del beforeEach: { escalated: true, assignedAgentName: "María" } — CON asesor.

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe(DESPEDIDA_CON_ASESOR_ABIERTA);
    const opcionesEnvio = sendAgentTextMock.mock.calls[0][3] as { isAutoReply?: boolean } | undefined;
    // Tarea 5 (14/9/2026): la promesa de un asesor tampoco es una respuesta
    // real, tenga o no asesor — antes esta aserción era `.not.toBe(true)`.
    expect(opcionesEnvio?.isAutoReply).toBe(true);
    // Nunca el borrador ni el reescrito que se seguían delatando.
    expect(sendAgentTextMock.mock.calls.some((llamada) => llamada[2] === borrador)).toBe(false);
    expect(sendAgentTextMock.mock.calls.some((llamada) => llamada[2] === reescritoQueSigueCalzando)).toBe(false);

    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(escalateConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        motivo: "seguimiento",
        resumen: "La respuesta redactada se describía como automatizada y no pudo corregirse. Retomar el hilo.",
      })
    );
    expect(error).toHaveBeenCalledWith("identidad_bloqueada", expect.objectContaining({ conversationId: "conv-1" }));

    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({ action: "escalated" });
    const summary = agentTurnInserts[0].summary as string;
    expect(summary.startsWith("[identidad bloqueada]")).toBe(true);
    expect(summary).toContain("seguimiento");
  });

  it("(c2) variante sin asesor: sale la despedida SIN asesor, marcada is_auto_reply", async () => {
    generateMock.mockResolvedValueOnce({
      text: "Soy un asistente virtual de SBK, el automático está en 12$.",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });
    generateTextMock.mockResolvedValueOnce({
      text: "Soy un asistente virtual de SBK, el automático está en 12$.",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    escalateConversationMock.mockImplementationOnce(async () => {
      pasos.push("escalar");
      return { escalated: true, assignedAgentName: null, unassigned: true };
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).toBe(DESPEDIDA_SIN_ASESOR);
    const opciones = sendAgentTextMock.mock.calls[0][3] as { isAutoReply?: boolean } | undefined;
    expect(opciones?.isAutoReply).toBe(true);
  });

  it("(c3) generateText lanza: se trata como reescritura fallida, nunca se envía el borrador", async () => {
    const error = vi.spyOn(log, "error");
    const borrador = "Soy un bot, dame un momento y te cotizo el automático.";
    generateMock.mockResolvedValueOnce({
      text: borrador,
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });
    generateTextMock.mockRejectedValueOnce(new Error("proveedor caído"));

    // No debe lanzar: un proveedor caído en la reescritura no puede tumbar el
    // turno, tiene que resolver igual con la despedida fija.
    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock.mock.calls[0][2]).not.toBe(borrador);
    expect([DESPEDIDA_SIN_ASESOR, DESPEDIDA_CON_ASESOR_ABIERTA]).toContain(sendAgentTextMock.mock.calls[0][2]);
    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(escalateConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ motivo: "seguimiento" })
    );
    expect(error).toHaveBeenCalledWith(
      "identidad_bloqueada",
      expect.objectContaining({ conversationId: "conv-1", motivo: "reescritura_fallida" })
    );
  });

  it("(d) el modelo ya había escalado (queja) antes de redactar: no se escala una segunda vez por 'seguimiento'", async () => {
    const error = vi.spyOn(log, "error");
    classifyIntentMock.mockResolvedValueOnce({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    generateMock.mockResolvedValueOnce({
      text: "Soy un bot, ya te paso con un asesor.",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });
    generateTextMock.mockResolvedValueOnce({
      text: "Soy un asistente virtual, ya te paso con un asesor.",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    // escalateConversationMock por defecto (beforeEach): { escalated: true, assignedAgentName: "María" } —
    // es la llamada de la red de seguridad de "queja", ANTES de que corra la guarda de identidad.

    await runAgentTurn("conv-1");

    // Una sola escalación en todo el turno: la de "queja". La guarda NO
    // escala una segunda vez porque outcome.escalated ya era true.
    expect(escalateConversationMock).toHaveBeenCalledTimes(1);
    expect(escalateConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ motivo: "queja" })
    );

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect([DESPEDIDA_SIN_ASESOR, DESPEDIDA_CON_ASESOR_ABIERTA]).toContain(sendAgentTextMock.mock.calls[0][2]);
    expect(error).toHaveBeenCalledWith("identidad_bloqueada", expect.objectContaining({ conversationId: "conv-1" }));

    expect(agentTurnInserts).toHaveLength(1);
    const summary = agentTurnInserts[0].summary as string;
    expect(summary.startsWith("[identidad bloqueada]")).toBe(true);
  });

  /**
   * Test estático: las constantes y textos fijos que la propia guarda podría
   * llegar a mandar (u OFF_TOPIC_REPLY, que nunca pasa por la guarda en
   * caliente) no pueden delatarse a sí mismos — si alguna vez alguien les
   * agrega la palabra equivocada, este test lo agarra sin levantar el turno
   * completo.
   */
  it("(e) las despedidas fijas y OFF_TOPIC_REPLY no calzan ningún patrón de identidad", () => {
    expect(revealsIdentity(OFF_TOPIC_REPLY)).toBeNull();
    expect(revealsIdentity(DESPEDIDA_SIN_ASESOR)).toBeNull();
    // Tarea 5 (14/9/2026): despedidaConAsesor pasó a tener tres formas según
    // el horario — las tres tienen que revisarse, no solo la de "abierta".
    expect(revealsIdentity(despedidaConAsesor({ open: true, closesAt: "6:00 pm", nextOpening: null }))).toBeNull();
    expect(
      revealsIdentity(
        despedidaConAsesor({ open: false, closesAt: null, nextOpening: { dayLabel: "el lunes", time: "8:00 am" } })
      )
    ).toBeNull();
    expect(revealsIdentity(despedidaConAsesor({ open: false, closesAt: null, nextOpening: null }))).toBeNull();
    expect(revealsIdentity(despedidaConAsesor(undefined))).toBeNull();
    // Tarea 6 (14/9/2026): la despedida del segundo adjunto sin texto.
    expect(revealsIdentity(DESPEDIDA_MEDIA)).toBeNull();
  });

  /**
   * Hueco cerrado el 6/9/2026 al integrar la guarda: la red de seguridad de
   * devolución/queja (más arriba en `runTurnPhases`, ANTES de la guarda de
   * identidad) copiaba `escalated`/`assignedAgentName`/`unassigned` de
   * `forced` pero nunca `outcome.motivo` — a diferencia de
   * `buildEscalateTool` en tools.ts, que sí lo hace. Sin esa copia, el
   * `summary` de `agent_turns` quedaba "Escalado a X. Motivo: undefined."
   * en vez de nombrar "queja" o "devolucion".
   */
  it("(f) red de seguridad de queja: el summary trae 'Motivo: queja.', no 'undefined'", async () => {
    classifyIntentMock.mockResolvedValueOnce({
      intent: "queja",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    });
    // Texto limpio, sin nada que la guarda de identidad tenga que tocar: este
    // test es sobre la red de seguridad de devolución/queja, no sobre la
    // guarda.
    generateMock.mockResolvedValueOnce({
      text: "Lamento lo que pasó, ya te paso con un asesor.",
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
      steps: [{}, {}],
    });

    await runAgentTurn("conv-1");

    expect(agentTurnInserts).toHaveLength(1);
    const summary = agentTurnInserts[0].summary as string;
    expect(summary).toContain("Motivo: queja.");
    expect(summary).not.toContain("undefined");
  });
});

/**
 * T5, plan "Seba atiende el mostrador" (18/9/2026), requisito 7 del cliente:
 * "Lecciones de Seba" leídas en `fetchTurnLessons` (lessons.ts) y pasadas a
 * `buildInstructions` (prompt.ts). El módulo real de `prompt.ts` NO está
 * mockeado en este archivo, así que `agentOptions[n].instructions` trae el
 * texto de verdad — estas pruebas verifican que el turno de verdad lee la
 * cuarta consulta y se la entrega al modelo, no que `prompt.ts` sepa
 * pegarlas (eso ya lo cubre prompt.test.ts).
 */
describe("Lecciones de Seba llegan al prompt del turno (T5, 18/9/2026)", () => {
  it("sin lecciones cargadas (el caso de fábrica), el prefijo sigue siendo exactamente SYSTEM_PROMPT", async () => {
    await runAgentTurn("conv-1");

    expect(agentOptions).toHaveLength(1);
    expect(agentOptions[0].instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
  });

  it("con lecciones globales, buildInstructions las recibe en el bloque cacheado", async () => {
    state.globalLessons = ["Nunca prometas un descuento por WhatsApp sin confirmar con un asesor."];

    await runAgentTurn("conv-1");

    expect(agentOptions[0].instructions).toContain("Nunca prometas un descuento por WhatsApp");
    expect(agentOptions[0].instructions).toContain("LECCIONES DEL EQUIPO");
  });

  it("con lecciones de esta conversación, buildInstructions las recibe en el sufijo", async () => {
    state.chatLessons = ["Este cliente ya pagó con Cashea, no le pidas comprobante otra vez."];

    await runAgentTurn("conv-1");

    const sufijo = agentOptions[0].instructions.slice(SYSTEM_PROMPT.length);
    expect(sufijo).toContain("Este cliente ya pagó con Cashea");
  });

  /**
   * `fetchTurnLessons` nunca lanza (ver lessons.test.ts): un error de la
   * base se traduce en lecciones vacías + `log.warn`, nunca en un turno
   * caído — el cliente sigue esperando su respuesta, con o sin las
   * correcciones del equipo.
   */
  it("un error leyendo ai_lessons no tumba el turno: sigue sin lecciones y avisa por log", async () => {
    const warn = vi.spyOn(log, "warn");
    state.lessonsError = { message: "conexión perdida" };

    await runAgentTurn("conv-1");

    expect(agentOptions).toHaveLength(1);
    expect(agentOptions[0].instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "turno_lecciones_no_legibles",
      expect.objectContaining({ conversationId: "conv-1", detail: "conexión perdida" })
    );
  });
});

/**
 * T2, plan "Seba no habla de más mientras el cliente espera al asesor"
 * (22-23/9/2026): "borrador cedido". `state.cessionLastCustomerMessageAt`
 * simula la relectura de `conversations.last_customer_message_at` que hace
 * `shouldCedeDraft` (turn-cession.ts) en los dos puntos de `runTurnPhases` —
 * `null` de fábrica (ver el docblock del campo en `FakeState`), así que
 * estos tests son los únicos de todo el archivo que lo tocan.
 */
describe("runAgentTurn — borrador cedido (T2, 22-23/9/2026)", () => {
  it("cesión en el punto 1 (después de fase 0/1, antes de mandar un escenario o el tool loop): no llama a sendPlaybookReply ni al ToolLoopAgent", async () => {
    state.history = [
      {
        sender_type: "customer",
        content: "Cuánto cuesta la parrilla de sbr",
        is_internal_note: false,
        created_at: "2026-09-22T09:14:11.000Z",
        id: "m-parrilla",
      },
    ];
    // Un fragmento nuevo ya está en la base cuando corre el punto 1 —
    // llegó mientras este turno todavía cargaba/clasificaba.
    state.cessionLastCustomerMessageAt = "2026-09-22T09:14:22.000Z";

    await runAgentTurn("conv-1");

    // Fase 0/1 SÍ corrió (el punto 1 va DESPUÉS de las dos): el chequeo
    // necesita su resultado para decidir el `intent` de la fila `skipped`.
    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(matchPlaybookMock).toHaveBeenCalledTimes(1);
    // Pero ni el escenario ni el tool loop llegaron a correr.
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();

    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({
      action: "skipped",
      summary: "Borrador cedido: llegó otro mensaje del cliente mientras se redactaba.",
    });
    // Los tokens de la clasificación (ya gastados) se cuentan igual.
    expect(agentTurnInserts[0].total_tokens).toBeGreaterThan(0);

    // Sin marca "visto hasta": todo lo que este turno cargó sigue pendiente.
    expect(redisSeenStore.has("turno:visto:conv-1")).toBe(false);
    // Sin traspaso: no cambia el dueño de la conversación.
    expect(handoffCalls).toHaveLength(0);
  });

  it("cesión en el punto 2 (después del tool loop y la guarda de identidad, antes de entregar): generate corrió, no se entrega texto y logTurn recibe skipped con los tokens", async () => {
    state.history = [
      {
        sender_type: "customer",
        content: "El guarda fango trasero con su tapa negra",
        is_internal_note: false,
        created_at: "2026-09-22T09:14:22.000Z",
        id: "m-guardafango",
      },
    ];
    // Todavía nada nuevo cuando corre el punto 1 (sigue null → no cede) —
    // el fragmento siguiente ("Y luces traseras de cruce") llega recién
    // MIENTRAS el tool loop está redactando, dentro de `agent.generate()`.
    generateMock.mockImplementationOnce(async () => {
      state.cessionLastCustomerMessageAt = "2026-09-22T09:14:30.000Z";
      return {
        text: "Sí, tenemos el guardafango con tapa negra disponible.",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}],
      };
    });

    await runAgentTurn("conv-1");

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).not.toHaveBeenCalled();

    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({
      action: "skipped",
      summary: "Borrador cedido: llegó otro mensaje del cliente mientras se redactaba.",
    });
    // `turnTokens` incluye lo que gastó el tool loop, no solo fase 0/1.
    expect(agentTurnInserts[0].output_tokens).toBeGreaterThanOrEqual(8);

    expect(redisSeenStore.has("turno:visto:conv-1")).toBe(false);
    expect(handoffCalls).toHaveLength(0);
  });

  it("sin cesión si el tool loop YA escaló en este turno (aunque llegue un mensaje más nuevo): la despedida sale igual", async () => {
    state.history = [
      {
        sender_type: "customer",
        content: "quiero comprar la moto completa",
        is_internal_note: false,
        created_at: "2026-09-22T09:14:22.000Z",
        id: "m-compra",
      },
    ];
    // `buildEscalateTool` se llama al armar las herramientas, ANTES de
    // `agent.generate()` — mutar `outcome.escalated` ahí simula que la
    // escalada de verdad ya corrió cuando el punto 2 pregunta.
    buildEscalateToolMock.mockImplementationOnce((_deps, outcome) => {
      outcome.escalated = true;
      outcome.unassigned = false;
      outcome.assignedAgentName = "María";
      return {};
    });
    generateMock.mockImplementationOnce(async () => {
      // Un mensaje más nuevo SÍ llega mientras se redacta la despedida —
      // pero como ya escaló, no importa: tiene que salir igual.
      state.cessionLastCustomerMessageAt = "2026-09-22T09:14:30.000Z";
      return {
        text: "Ya te paso con un asesor para cerrar la compra.",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        steps: [{}],
      };
    });

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0].action).toBe("escalated");
    expect(agentTurnInserts[0].summary).not.toContain("Borrador cedido");
    // Sí se marca lo visto: esta redacción SÍ atendió lo que vio.
    expect(redisSeenStore.has("turno:visto:conv-1")).toBe(true);
  });

  it("sin cesión cuando la relectura de last_customer_message_at es EXACTAMENTE igual al hasta cargado (empate, no hay nada nuevo)", async () => {
    state.history = [
      {
        sender_type: "customer",
        content: "hola, tienen cascos?",
        is_internal_note: false,
        created_at: "2026-09-22T12:00:00.000Z",
        id: "m-1",
      },
    ];
    // Mismo instante que el `created_at` de la única línea del cliente: no
    // es un mensaje nuevo, es el mismo que ya se cargó.
    state.cessionLastCustomerMessageAt = "2026-09-22T12:00:00.000Z";

    await runAgentTurn("conv-1");

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(agentTurnInserts.some((row) => row.action === "skipped")).toBe(false);
    expect(redisSeenStore.has("turno:visto:conv-1")).toBe(true);
  });

  /**
   * Hallazgo del orquestador (23/9/2026): un cliente que no para de escribir
   * en fragmentos podía quedarse SIN RESPUESTA para siempre. La primera
   * versión de esta tarea borraba el contador de cesiones seguidas en el
   * PUNTO 1 cada vez que ese punto decidía "no cede" — que es el caso normal
   * de casi todos los turnos (fase 0/1 tarda ~2 s, rara vez alcanza a llegar
   * un fragmento nuevo en ese hueco). Eso pisaba, en cada turno, lo que el
   * PUNTO 2 del turno anterior acababa de incrementar: el contador nunca
   * pasaba de 1, así que el tope (`CESSION_CAP = 2`) nunca se alcanzaba.
   *
   * Tres turnos SEGUIDOS para la MISMA conversación, cada uno "no cede en el
   * punto 1, cede en el punto 2" (el fragmento siguiente llega justo
   * mientras `agent.generate()` está redactando, mismo truco que el resto
   * de este describe): con la corrección, el contador SÍ acumula 1 → 2 → 3,
   * y el tercero topa (`> CESSION_CAP`) y entrega igual, aunque su propio
   * punto 1 tampoco vea nada nuevo (el caso normal).
   */
  it("tres turnos seguidos que ceden en el punto 2 (sin cesión en el punto 1, el caso normal): el tercero topa y entrega igual", async () => {
    const T0 = "2026-09-22T09:14:00.000Z";
    const T1 = "2026-09-22T09:14:10.000Z";
    const T2 = "2026-09-22T09:14:20.000Z";
    const T3 = "2026-09-22T09:14:30.000Z";

    // Turno A: nada nuevo en el punto 1 (cessionLastCustomerMessageAt == la
    // línea que este turno cargó) — el caso normal, no el que dispara la
    // cesión. Cede en el punto 2 porque el fragmento siguiente (T1) llega
    // mientras `generate()` corre.
    state.history = [
      { sender_type: "customer", content: "Cuánto cuesta la parrilla de sbr", is_internal_note: false, created_at: T0, id: "m-a" },
    ];
    state.cessionLastCustomerMessageAt = T0;
    generateMock.mockImplementationOnce(async () => {
      state.cessionLastCustomerMessageAt = T1;
      return { text: "texto A", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, steps: [{}] };
    });
    await runAgentTurn("conv-1");

    // Turno B: mismo patrón — el fragmento que llegó durante A (T1) es
    // ahora lo más nuevo que B carga; nada más nuevo todavía en su punto 1.
    // Cede en su punto 2 porque el fragmento siguiente (T2) llega mientras
    // redacta.
    state.history = [
      { sender_type: "customer", content: "El guarda fango trasero con su tapa negra", is_internal_note: false, created_at: T1, id: "m-b" },
    ];
    generateMock.mockImplementationOnce(async () => {
      state.cessionLastCustomerMessageAt = T2;
      return { text: "texto B", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, steps: [{}] };
    });
    await runAgentTurn("conv-1");

    // Turno C: mismo patrón otra vez — pero esta es la TERCERA cesión
    // seguida, así que el tope tiene que ganar y entregar de verdad.
    state.history = [
      { sender_type: "customer", content: "Y luces traseras de cruce", is_internal_note: false, created_at: T2, id: "m-c" },
    ];
    generateMock.mockImplementationOnce(async () => {
      state.cessionLastCustomerMessageAt = T3;
      return { text: "texto C", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, steps: [{}] };
    });
    await runAgentTurn("conv-1");

    expect(generateMock).toHaveBeenCalledTimes(3);
    // A y B se callaron; C entregó.
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "texto C",
      expect.anything()
    );

    const acciones = agentTurnInserts.map((row) => row.action);
    expect(acciones).toEqual(["skipped", "skipped", "answered"]);
  });
});

/**
 * T6, plan "Seba no habla de más mientras el cliente espera al asesor"
 * (22-23/9/2026, decisión del operador: "esperar la pregunta"). Caso RK200
 * (22/9, medido por el VPS): el turno arrancó con solo "Buenas tardes" de un
 * cliente que YA conocía a Seba; la pregunta real llegó 10 s después y el
 * modelo corrió igual sobre ese historial, escalando sobre algo que el
 * cliente ni había preguntado. `state.conversation.welcome_sent_at` ya viene
 * sellado por el `beforeEach` general ("2026-08-22T10:00:00Z"), así que
 * estos tests no necesitan tocarlo salvo el de "cliente nuevo".
 */
describe("runAgentTurn — saludo suelto de un cliente que ya conocía a Seba (T6, 22-23/9/2026)", () => {
  afterEach(() => {
    // Mismo motivo que el resto del archivo: un reloj congelado que se
    // filtre a otro describe rompe cualquier prueba que dependa de la hora
    // real.
    vi.useRealTimers();
  });

  it("cliente conocido, pendientes = ['Buenas tardes'], sin escalada: primer intento — difiere sin modelo ni envío, y deja el rastro", async () => {
    state.history = [{ sender_type: "customer", content: "Buenas tardes", is_internal_note: false }];

    await expect(runAgentTurn("conv-1")).rejects.toThrow(GreetingAwaitsQuestionError);

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(sendPlaybookReplyMock).not.toHaveBeenCalled();
    expect(redisSeenStore.has("turno:saludo_suelto:conv-1")).toBe(true);
    // Diferir no abandona la conversación (invariante "ningún lead
    // invisible", CLAUDE.md): el turno sigue en la cola, así que acá no hay
    // ningún dueño que cambiar ni traspaso que dejar.
    expect(handoffCalls).toHaveLength(0);
  });

  it("segundo intento con el rastro puesto y todavía solo saludo: Seba contesta el saludo fijo, sin modelo, 'answered', marca vista y borra el rastro", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T00:30:00Z")); // 8:30 pm en Caracas → franja "noche"
    redisSeenStore.set("turno:saludo_suelto:conv-1", "1");
    state.history = [
      {
        sender_type: "customer",
        content: "Buenas tardes",
        is_internal_note: false,
        created_at: "2026-09-18T00:28:00.000Z",
        id: "m-saludo",
      },
    ];

    await runAgentTurn("conv-1");

    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      sebaGreetingFollowUp("noche"),
      // Es respuesta REAL: el cliente saludó y se le contestó, apaga
      // `awaiting_reply` como cualquier otra respuesta -- no es la cortesía
      // de una escalada.
      expect.objectContaining({ isAutoReply: false })
    );
    expect(agentTurnInserts).toHaveLength(1);
    expect(agentTurnInserts[0]).toMatchObject({
      action: "answered",
      summary: "Saludo suelto: Seba contestó sin esperar más.",
    });
    expect(redisSeenStore.has("turno:visto:conv-1")).toBe(true);
    expect(redisSeenStore.has("turno:saludo_suelto:conv-1")).toBe(false);
  });

  it("segundo intento con la pregunta real ya en la ráfaga (['Buenas tardes', 'precio del RK200']): corre normal, modelo llamado, y el rastro sin uso se borra", async () => {
    redisSeenStore.set("turno:saludo_suelto:conv-1", "1");
    state.history = [
      {
        sender_type: "customer",
        content: "precio del RK200",
        is_internal_note: false,
        created_at: "2026-09-22T15:24:24.000Z",
        id: "m-pregunta",
      },
      {
        sender_type: "customer",
        content: "Buenas tardes",
        is_internal_note: false,
        created_at: "2026-09-22T15:24:14.000Z",
        id: "m-saludo",
      },
    ];

    await runAgentTurn("conv-1");

    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "respuesta redactada por el modelo",
      expect.anything()
    );
    expect(redisSeenStore.has("turno:saludo_suelto:conv-1")).toBe(false);
  });

  it("cliente NUEVO saludando: sigue la presentación de Seba de siempre, no difiere ni toca el rastro", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.history = [{ sender_type: "customer", content: "Buenas tardes", is_internal_note: false }];

    await expect(runAgentTurn("conv-1")).resolves.toBeUndefined();

    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(matchPlaybookMock).not.toHaveBeenCalled();
    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(redisSeenStore.has("turno:saludo_suelto:conv-1")).toBe(false);
  });

  it("con escalada abierta y solo saludo: no difiere -- sigue el camino de T5 (nota para el asesor), como hoy", async () => {
    state.history = [{ sender_type: "customer", content: "Buenas tardes", is_internal_note: false }];
    state.lastHandoffRow = { reason: "escalada_sin_asesor", created_at: "2026-09-22T09:14:26.000Z" };
    state.agentMessagesAfterHandoff = [];
    matchPlaybookMock.mockResolvedValue({ playbook: null, usage: NO_USAGE });

    await expect(runAgentTurn("conv-1")).resolves.toBeUndefined();

    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(sendAgentTextMock).not.toHaveBeenCalled();
    expect(messageInserts).toHaveLength(1);
    expect(messageInserts[0].content).toContain("Buenas tardes");
    expect(redisSeenStore.has("turno:saludo_suelto:conv-1")).toBe(false);
  });

  it("sin Redis: no difiere, sigue de largo como si esta tarea no existiera", async () => {
    redisFailing = true;
    state.history = [{ sender_type: "customer", content: "Buenas tardes", is_internal_note: false }];

    await expect(runAgentTurn("conv-1")).resolves.toBeUndefined();

    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "respuesta redactada por el modelo",
      expect.anything()
    );
  });

  /**
   * Corrección hallada preparando la mutación de esta tarea (23/9/2026): con
   * `welcome_sent_at: null` PERO el reclamo de la presentación PERDIDO (otra
   * corrida ya lo selló, o simplemente no calzó), `convo.welcome_sent_at`
   * sigue siendo `null` en memoria -- si el `if` de T6 solo mirara
   * `primerPendienteEsSaludo`, sin `convo.welcome_sent_at !== null`, un
   * saludo suelto en este chat también diferiría acá, aunque la IA nunca
   * llegó a presentarse. La condición "ya se presentó antes" es justo lo que
   * distingue este caso del de un cliente que sí la conoce.
   */
  it("cliente nuevo que perdió la carrera del reclamo de presentación: welcome_sent_at sigue null, T6 no dispara, sigue de largo", async () => {
    state.conversation = { ...state.conversation, welcome_sent_at: null };
    state.presentationClaimWins = false;
    state.history = [{ sender_type: "customer", content: "Buenas tardes", is_internal_note: false }];

    await expect(runAgentTurn("conv-1")).resolves.toBeUndefined();

    expect(classifyIntentMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledTimes(1);
    expect(sendAgentTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "respuesta redactada por el modelo",
      expect.anything()
    );
    expect(redisSeenStore.has("turno:saludo_suelto:conv-1")).toBe(false);
  });
});
