// ---------------------------------------------------------------------------
// Máquina de estados de la reconfirmación antes de pasar un caso a ventas.
//
// T2 del plan "Seis frentes del buzón" (8/9/2026). Hasta hoy la IA escalaba
// al primer "sí" del cliente ("dale", "sí, me lo llevo"). El operador pidió
// una segunda confirmación: la IA ofrece pasar el caso a ventas y solo con
// el SEGUNDO "sí" la conversación pasa de verdad a un asesor. Aplica SOLO al
// pase a ventas (`motivo = "intencion_compra"` en `buildEscalateTool`,
// `tools.ts`) — devolución, queja y los escenarios que escalan de por sí
// (`afterSend = "escalate"`) siguen escalando con el primer aviso.
//
// El sello vive en `conversations.handoff_confirmation_pending_at`
// (migración 20260909010000): no null significa "hay una oferta de pase a
// ventas esperando confirmación, sellada a esta hora". Este módulo solo
// compara fechas — no toca la base, no sabe qué es `escalarAAsesor` — para
// que la regla de negocio se pueda probar sin Supabase ni el SDK de IA.
//
// `confirmed` exige que el ÚLTIMO mensaje del cliente sea POSTERIOR al
// sello, no solo que exista un sello. Sin esa condición, el modelo podría
// llamar a la herramienta dos veces en el MISMO turno (el tool loop permite
// hasta 5 pasos) y saltarse la confirmación: la primera llamada sella la
// oferta, y si "haber un sello" alcanzara para escalar, la segunda llamada
// —todavía respondiendo al mismo mensaje del cliente que disparó la
// primera— escalaría sin que el cliente hubiera dicho nada más. Exigir un
// mensaje POSTERIOR al sello ata la confirmación a un mensaje nuevo, que
// solo puede llegar en un turno futuro.
//
// `expired` (más de `HANDOFF_CONFIRMATION_TTL_MS`) tiene prioridad sobre
// `confirmed`: un "sí" que llega horas después de la oferta original —por
// ejemplo, si el mensaje quedó atascado en la cola— no cuenta como la
// confirmación de una oferta que ya venció. `buildEscalateTool` trata
// `expired` igual que `none`: vuelve a sellar y a pedir el "sí" de nuevo, en
// vez de escalar con una confirmación vieja fuera de contexto.
//
// El plazo (6 h) es el mismo que `PLAYBOOK_COOLDOWN_HOURS` en `playbooks.ts`
// —la ventana en la que un escenario no se repite—: no hay una razón de
// negocio distinta para elegir otro número, y compartir el plazo evita que
// el equipo tenga que recordar dos "seis horas" con orígenes distintos.
//
// Módulo PURO a propósito, igual que `identity-guard.ts` y
// `history-line.ts`: sin `server-only` y sin más import que tipos, para que
// `tools.ts` (servidor) y su test lo usen sin arrastrar Supabase ni el SDK.
// ---------------------------------------------------------------------------

/** Ver el comentario de cabecera: mismo plazo que `PLAYBOOK_COOLDOWN_HOURS` en `playbooks.ts`. */
export const HANDOFF_CONFIRMATION_TTL_MS = 6 * 60 * 60 * 1000;

export type HandoffConfirmationState = "none" | "awaiting" | "confirmed" | "expired";

export interface HandoffConfirmationParams {
  /** `conversations.handoff_confirmation_pending_at`. Null = sin oferta pendiente. */
  pendingAt: string | null;
  /** `conversations.last_customer_message_at` al momento en que corre este turno. */
  lastCustomerMessageAt: string | null;
  /** El reloj de este turno. Inyectable en tests; en producción es ahora. */
  now: Date;
}

/**
 * Decide en qué punto está la reconfirmación de pase a ventas para esta
 * conversación. `buildEscalateTool` (`tools.ts`) es el único llamador: la
 * usa exclusivamente cuando `motivo === "intencion_compra"`.
 */
export function handoffConfirmationState({
  pendingAt,
  lastCustomerMessageAt,
  now,
}: HandoffConfirmationParams): HandoffConfirmationState {
  if (!pendingAt) return "none";

  const pendingAtMs = Date.parse(pendingAt);
  // Un sello ilegible no puede sostener una oferta pendiente: se trata como
  // si no hubiera ninguna, así que el turno vuelve a sellar en vez de
  // quedarse atascado sin poder decidir.
  if (Number.isNaN(pendingAtMs)) return "none";

  // Vence PRIMERO: ver el comentario de cabecera sobre por qué "expired"
  // gana incluso si el cliente ya contestó después del sello.
  if (now.getTime() - pendingAtMs > HANDOFF_CONFIRMATION_TTL_MS) return "expired";

  if (lastCustomerMessageAt) {
    const lastMs = Date.parse(lastCustomerMessageAt);
    // Estrictamente POSTERIOR al sello: ver el comentario de cabecera sobre
    // por qué "igual" no cuenta como confirmado.
    if (!Number.isNaN(lastMs) && lastMs > pendingAtMs) return "confirmed";
  }

  return "awaiting";
}
