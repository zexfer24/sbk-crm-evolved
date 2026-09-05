-- ============================================================================
-- T2.1 del plan "La bandeja que no pierde" (Etapa 2 · F6): cerrar y reabrir
--
-- Hasta hoy un asesor podía "terminar" una conversación con la vista, pero
-- no había ninguna acción del CRM que lo dijera: `conversations.status` ya
-- admite 'closed' desde el esquema inicial (20260819000001) y varias
-- píldoras ya lo descuentan (`conversations_pending_idx`,
-- `conversations_escalated_idx`, ambas de 20260905010000), pero nada en la
-- aplicación lo escribía nunca. Esta migración no toca ninguna columna ni
-- ningún índice: solo amplía el catálogo cerrado de `conversation_handoffs.
-- reason` con las tres razones que va a dejar el código de T2.1 —
-- `src/app/api/conversations/[id]/close/route.ts`,
-- `.../reopen/route.ts` y la reapertura automática en el webhook cuando el
-- cliente vuelve a escribirle a un chat cerrado.
--
-- `to_kind` NO se toca: ya admite 'closed' desde el CHECK original de
-- 20260830040000_conversation_handoffs.sql (`check (to_kind in ('ai',
-- 'human', 'unassigned', 'closed'))`), así que las tres razones nuevas se
-- insertan sobre un catálogo de destino que ya las recibe.
--
-- Sin cambios de permisos: `record_handoff()` sigue concedida SOLO a
-- `service_role` (ver 20260830040000). Cerrar/reabrir desde el navegador NO
-- pasa por darle el `execute` a `authenticated` — pasa por un route handler
-- que primero comprueba la sesión con el cliente normal
-- (`@/lib/supabase/server`) y solo entonces llama a `recordHandoff` con un
-- cliente `service_role` (`@/lib/supabase/admin`), igual que ya hace
-- `api/messages/send` para hablar con Meta. Ver CLAUDE.md: "código de
-- servidor" no es sinónimo de `service_role`, lo decide el cliente Supabase
-- que se usó, no el archivo donde vive la ruta.
-- ============================================================================

alter table public.conversation_handoffs
  drop constraint conversation_handoffs_reason_check;

alter table public.conversation_handoffs
  add constraint conversation_handoffs_reason_check
  check (reason in (
    'agente_no_puede_correr',
    'conversacion_inexistente',
    'pausada',
    'asignada',
    'humano_intervino',
    'humano_se_adelanto',
    'fuera_de_ventana',
    'identidad_no_verificable',
    'lock_perdido',
    'abandonado',
    'entrega_fallida',
    'reabierto',
    'escalado_por_ia',
    'reclamado',
    'devuelto_a_ia',
    'cerrado',
    'ventana_vencida',
    'sla_vencido',
    'escalada',
    'escalada_sin_asesor',
    'rechazado_por_meta',
    -- T2.1 (5/9/2026), las tres razones nuevas:
    'cerrada_por_asesor',
    'reabierta_por_asesor',
    'reabierta_por_cliente'
  ));

comment on column public.conversation_handoffs.reason is
  'Por qué ocurrió el traspaso. Lista cerrada por CHECK (no enum, a propósito: ver 20260830040000). T2.1 (5/9/2026) suma cerrada_por_asesor (cierre manual, close/route.ts), reabierta_por_asesor (reabrir manual, reopen/route.ts) y reabierta_por_cliente (el webhook reabre sola una conversación cerrada cuando el cliente vuelve a escribir, ANTES de guardar su mensaje).';
