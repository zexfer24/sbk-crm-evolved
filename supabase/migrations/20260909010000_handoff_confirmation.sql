-- ============================================================================
-- T2 del plan "Seis frentes del buzón" (8/9/2026) — la IA reconfirma antes
-- de pasar el caso a ventas.
--
-- Hoy la IA escala al primer "sí" del cliente ("dale", "sí, me lo llevo").
-- El operador pidió una segunda confirmación: la IA ofrece pasar el caso a
-- ventas, y solo con el SEGUNDO "sí" la conversación pasa de verdad a un
-- asesor. Aplica SOLO al pase a ventas (motivo = "intencion_compra");
-- devolución, queja y los escenarios que escalan de por sí siguen escalando
-- con el primer aviso.
--
-- Esta columna es el sello de "hay una oferta de pase a ventas esperando
-- confirmación": null significa que no hay ninguna oferta pendiente.
-- `handoffConfirmationState` (src/lib/ai/handoff-confirmation.ts) la compara
-- contra el último mensaje del cliente para decidir si la oferta ya fue
-- confirmada (mensaje del cliente POSTERIOR al sello), sigue esperando, o
-- venció (más de 6 h, el mismo plazo que la no-repetición de escenarios en
-- playbooks.ts — PLAYBOOK_COOLDOWN_HOURS). `escalateConversation`
-- (escalate.ts) la limpia SIEMPRE al escalar, sea por esta puerta o por
-- cualquiera de las otras tres (devolución, queja, escenario).
--
-- `if not exists`: Docker/la base local pueden estar apagados al momento de
-- escribir esta migración: que sea idempotente evita que aplicarla dos veces
-- rompa nada si ya corrió una vez a mano.
-- ============================================================================

alter table public.conversations
  add column if not exists handoff_confirmation_pending_at timestamptz;

comment on column public.conversations.handoff_confirmation_pending_at is
  'La IA ofreció pasar el caso a ventas y espera el segundo sí del cliente; null = sin oferta pendiente. Plan Seis frentes del buzón, T2, 8/9/2026.';
