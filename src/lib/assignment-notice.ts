// ---------------------------------------------------------------------------
// Aviso de asignación (T5): decide si una fila NUEVA de `conversation_handoffs`
// (llega por realtime como INSERT) merece un aviso de 6 s para MÍ, el asesor
// que la está mirando.
//
// Módulo puro a propósito: sin React, sin Supabase, sin DOM. Quien conecte
// el canal de realtime (AppRail, T6) le pasa la fila cruda del INSERT y este
// archivo responde con un booleano; no sabe nada de cómo se muestra el aviso
// ni de cómo se abrió el canal.
// ---------------------------------------------------------------------------

/**
 * Forma mínima de una fila de `conversation_handoffs` que necesita la regla.
 * A propósito NO se importa el tipo `Row` generado de `database.types.ts`
 * (eso acoplaría este módulo puro al cliente de Supabase) ni el
 * `HandoffReason`/`HandoffKind` de `src/lib/ai/handoffs.ts` (ese archivo abre
 * con `"server-only"` y arrastra `createAdminClient`). Los nombres de campo
 * son los mismos snake_case de la tabla porque así llega el payload crudo de
 * un evento `postgres_changes` de Supabase Realtime — sin mapear a camelCase.
 */
export interface AssignmentHandoffRow {
  /** uuid de la fila en `conversation_handoffs`. Es la clave del dedupe. */
  id: string;
  /** Espeja el CHECK de la tabla: 'ai' | 'human' | 'unassigned' | 'closed'. */
  to_kind: string;
  /** id del asesor humano que queda a cargo, o null si `to_kind` no es 'human'. */
  to_id: string | null;
  /** Espeja el CHECK de `reason` en la migración 20260830040000. */
  reason: string;
}

/**
 * La regla pura: ¿esta fila significa "la IA ACABA de asignarte esto a VOS"?
 *
 * Avisa solo si las tres condiciones se cumplen a la vez:
 *   - `to_kind === "human"`: el traspaso deja a un humano a cargo (no a la
 *     IA, no a nadie, no cierra el chat).
 *   - `to_id === myAgentId`: ese humano soy yo, no otro asesor.
 *   - `reason === "escalada"`: la razón, no un detalle de higiene.
 *
 * `reason` es la trampa de este frente. `escalateConversation`
 * (`src/lib/ai/escalate.ts:110`) escribe `escalada` UNA sola vez, justo
 * después de que `claimNextAvailableAgent` te reclamó — es el único
 * traspaso que significa "te acaban de asignar algo nuevo".
 *
 * En cambio `asignada` (`src/lib/ai/agent.ts:1512`) la escribe el turno de
 * IA CADA VEZ que llega un mensaje a una conversación que ya tiene dueño,
 * solo para dejar registrado por qué no contestó — no es una asignación
 * nueva, es la MISMA asignación de siempre reafirmándose. Filtrar nada más
 * por `to_kind`/`to_id` haría saltar el aviso en cada mensaje del cliente
 * durante el resto de la conversación, que es exactamente el bug que este
 * archivo existe para evitar.
 *
 * El resto de razones con `to_kind: "human"` (`humano_intervino`,
 * `humano_se_adelanto`) tampoco son "te asignaron algo nuevo": son un humano
 * escribiendo antes o durante un turno de IA, no la IA entregando un caso.
 * `reabierta_por_asesor`/`reabierta_por_cliente` reabren, no asignan.
 *
 * `created_by` NO sirve como filtro adicional: vale `'system'` en
 * prácticamente todas las razones (incluida `escalada`), salvo las acciones
 * manuales de cerrar/reabrir — no distingue "te asignaron" de "ya tenías
 * esto".
 */
export function isAssignmentNotice(handoff: AssignmentHandoffRow, myAgentId: string): boolean {
  return (
    handoff.to_kind === "human" &&
    handoff.to_id !== null &&
    handoff.to_id === myAgentId &&
    handoff.reason === "escalada"
  );
}

// ---------------------------------------------------------------------------
// Dedupe por id de handoff, con un Set a nivel de MÓDULO (no de instancia).
//
// `AppRail` se renderiza también dentro de `section-skeleton.tsx`, así que
// durante una navegación pueden coexistir dos instancias del componente
// unos milisegundos — las dos suscritas al mismo canal de realtime, las dos
// recibiendo el mismo INSERT. Un Set por instancia (p. ej. un `useRef`) no
// protege de eso porque cada instancia tiene el suyo; hace falta estado
// compartido por el módulo. De paso protege contra un doble evento del
// propio canal (reconexión de Supabase Realtime reenviando lo último).
//
// El tope de tamaño evita que el Set crezca sin límite durante una sesión
// larga (un turno de un asesor puede durar horas): cada fila que llega acá
// ya pasó el filtro de `isAssignmentNotice`, así que en la práctica son unas
// pocas por hora, pero nada impide dejar la pestaña abierta días. 200 sobra
// para cualquier turno real; si algún día no alcanza, el peor efecto es un
// aviso repetido, nunca una fuga de memoria — se prefiere ese error al
// contrario.
// ---------------------------------------------------------------------------

const NOTIFIED_HANDOFF_IDS_MAX = 200;

/** Set de módulo: sobrevive a que el componente se monte/desmonte, a propósito. */
const notifiedHandoffIds = new Set<string>();

/**
 * Registra el id de un handoff que ya se avisó.
 *
 * Devuelve `true` la PRIMERA vez que se ve ese id (hay que avisar) y `false`
 * si ya se había registrado antes (es un duplicado, no avisar de nuevo).
 *
 * Cuando el Set alcanza el tope, descarta el id más viejo antes de agregar
 * el nuevo: los `Set` de JS mantienen el orden de inserción, así que el
 * primer valor que devuelve el iterador es siempre el más antiguo.
 */
export function markAssignmentNoticeSeen(handoffId: string): boolean {
  if (notifiedHandoffIds.has(handoffId)) return false;

  if (notifiedHandoffIds.size >= NOTIFIED_HANDOFF_IDS_MAX) {
    const oldest = notifiedHandoffIds.values().next().value;
    if (oldest !== undefined) notifiedHandoffIds.delete(oldest);
  }

  notifiedHandoffIds.add(handoffId);
  return true;
}

/** Vacía el Set de módulo. Solo para tests: en producción nadie lo llama. */
export function resetAssignmentNoticeDedupe(): void {
  notifiedHandoffIds.clear();
}

/**
 * La función que de verdad va a llamar quien conecte el canal (T6): junta la
 * regla y el dedupe en una sola decisión — "¿muestro el aviso para ESTA fila,
 * ahora mismo, en ESTA instancia?".
 *
 * Ojo con el orden: el dedupe solo se consulta/marca cuando la regla ya dijo
 * que sí, para no gastar las 200 entradas del Set en traspasos que nunca
 * iban a avisar (`asignada`, `humano_intervino`, etc. pasan por acá miles de
 * veces en una conversación larga).
 */
export function shouldShowAssignmentNotice(
  handoff: AssignmentHandoffRow,
  myAgentId: string
): boolean {
  if (!isAssignmentNotice(handoff, myAgentId)) return false;
  return markAssignmentNoticeSeen(handoff.id);
}
