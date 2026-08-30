import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorText, log } from "@/lib/log";

// ---------------------------------------------------------------------------
// El rastro que deja una conversación al cambiar de manos.
//
// Hasta el 30/8/2026 el sistema tomaba muy bien la decisión de callarse —la
// IA está apagada, un asesor ya escribió, la ventana de 24 h venció— y muy
// mal la de contarlo: el turno hacía `return` y la conversación se quedaba
// esperando sin que nadie quedara a cargo. En la bandeja no se veía nada,
// porque ninguna de las píldoras corta por "el sistema soltó esto". El lead
// no se perdía por una mala decisión, se perdía porque la decisión correcta
// era invisible.
//
// Esto no cambia ninguna decisión: la IA sigue callándose exactamente en los
// mismos casos. Solo deja la fila que dice cuál fue y por qué.
//
// LA REGLA QUE NO SE PUEDE ROMPER: registrar un traspaso NUNCA puede tumbar
// el turno. Esto es observabilidad, no una barrera nueva. Si la escritura
// falla —Postgres caído, un CHECK que no contempla una razón nueva—, se
// registra el fallo y el turno sigue su camino. Un turno que muere por no
// poder escribir su bitácora sería, literalmente, el problema que esta tabla
// vino a resolver, pero peor: hoy el lead queda sin rastro; así quedaría sin
// rastro Y sin respuesta.
//
// Ver la migración 20260830040000_conversation_handoffs.sql y la invariante
// en CLAUDE.md.
// ---------------------------------------------------------------------------

/** Quién atiende una conversación. Espeja el CHECK de `to_kind` en la tabla. */
export type HandoffKind = "ai" | "human" | "unassigned" | "closed";

/**
 * Por qué cambió de manos. Espeja el CHECK de `reason` en la migración: si
 * acá aparece un valor que allá no está, el insert lo rechaza y el traspaso
 * se pierde (sin tumbar el turno, pero se pierde). Los valores de las Etapas
 * 2 y 3 ya están en el CHECK de la base; acá se declaran solo los que la
 * Etapa 1 usa de verdad, para que el compilador delate un uso adelantado.
 */
export type HandoffReason =
  // El webhook y el turno: `agent_can_run()` dijo que no. Fusiona a propósito
  // "IA apagada" y "tope de gasto alcanzado" — esa RPC ya las fusiona en un
  // solo booleano y separarlas costaría otra consulta en el camino caliente.
  | "agente_no_puede_correr"
  // La IA está apagada en ESTE chat (`ai_enabled = false`).
  | "pausada"
  // El chat tiene asesor asignado.
  | "asignada"
  // Una persona ya había escrito antes de que el turno abriera.
  | "humano_intervino"
  // Una persona escribió MIENTRAS el turno corría: carrera perdida en `deliver()`.
  | "humano_se_adelanto"
  // Pasadas 24 h del último mensaje del cliente, Meta rechaza el texto libre.
  | "fuera_de_ventana"
  // No se pudo congelar a quién se le habla: identidad rota, no se reintenta.
  | "identidad_no_verificable"
  // El lock de la conversación dejó de ser nuestro antes de enviar.
  | "lock_perdido"
  // La cola agotó los tres intentos.
  | "abandonado"
  // Falló después de haber intentado entregar: no se reintenta para no duplicar.
  | "entrega_fallida"
  // El reconciliador encontró una conversación esperando que nadie tenía.
  | "reabierto";

export interface HandoffInput {
  conversationId: string;
  toKind: HandoffKind;
  reason: HandoffReason;
  fromKind?: HandoffKind | null;
  fromId?: string | null;
  toId?: string | null;
  /** `system` (webhook, cola, cron) o `user` (una acción del panel). */
  createdBy?: "system" | "user";
}

/**
 * Escribe el traspaso y devuelve si quedó registrado.
 *
 * Va por la RPC `record_handoff` y no por un `insert` directo a propósito,
 * aunque `service_role` podría insertar sin intermediarios: así hay UNA sola
 * puerta de escritura a la bitácora, y cuando la Etapa 2 traiga los botones
 * de reclamar/cerrar/devolver a IA —que corren como `authenticated` y no
 * pueden insertar directo— no habrá que cambiar este helper ni abrir un
 * segundo camino. La función se ejercita desde el día uno en vez de nacer
 * sin uso.
 *
 * Nunca lanza. El booleano es para los tests y para quien quiera contar
 * fallos; ningún llamador debe cambiar su comportamiento según el resultado.
 *
 * NO sirve para la salida "la conversación no existe": `conversation_id`
 * tiene clave foránea contra `conversations`, así que no hay fila a la que
 * apuntar y el insert se rechazaría. Es correcto que lo haga —una bitácora
 * de traspasos de una conversación que no existe no significa nada—, y por
 * eso `conversacion_inexistente` no está en `HandoffReason` aunque sí esté
 * en el CHECK de la base: que el compilador lo impida es más barato que
 * descubrirlo por un `traspaso_no_registrado` en producción.
 */
export async function recordHandoff(
  supabase: SupabaseClient<Database>,
  input: HandoffInput
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc("record_handoff", {
      p_conversation_id: input.conversationId,
      p_to_kind: input.toKind,
      p_reason: input.reason,
      // Se omiten en vez de mandarse en null: los tres tienen `default null`
      // en la función, así que dejarlos fuera es exactamente lo mismo para
      // Postgres y encaja con los tipos generados, que los declaran
      // opcionales por tener default.
      p_from_kind: input.fromKind ?? undefined,
      p_from_id: input.fromId ?? undefined,
      p_to_id: input.toId ?? undefined,
      p_created_by: input.createdBy ?? "system",
    });

    if (error) {
      log.error("traspaso_no_registrado", {
        conversationId: input.conversationId,
        reason: input.reason,
        detail: error.message,
      });
      return false;
    }

    return true;
  } catch (err) {
    // Se traga TODO —incluida una excepción de red— por la regla de arriba.
    log.error("traspaso_no_registrado", {
      conversationId: input.conversationId,
      reason: input.reason,
      detail: errorText(err),
    });
    return false;
  }
}

/**
 * Igual que `recordHandoff`, pero se fabrica su propio cliente `service_role`.
 *
 * Para los llamadores que no tienen uno a mano: la cola (`queue.ts`) y el
 * reconciliador trabajan sobre ids de conversación y Redis, sin cliente de
 * Supabase abierto. Que el `createAdminClient()` viva DENTRO del try no es
 * decorativo: sin `NEXT_PUBLIC_SUPABASE_URL` o `SUPABASE_SERVICE_ROLE_KEY`
 * ese constructor lanza, y la cola lo llama desde dentro de un `catch` —una
 * excepción ahí no la recoge nadie y se lleva por delante el worker entero,
 * que es justo lo contrario de lo que esta bitácora vino a hacer.
 */
export async function recordHandoffAdmin(input: HandoffInput): Promise<boolean> {
  try {
    return await recordHandoff(createAdminClient(), input);
  } catch (err) {
    log.error("traspaso_no_registrado", {
      conversationId: input.conversationId,
      reason: input.reason,
      detail: errorText(err),
    });
    return false;
  }
}
