-- ============================================================================
-- Módulo de Ventas
--
-- El cierre de venta ya vivía como un estado de la conversación
-- (deal_status/deal_closed_at). Esta migración le agrega lo que le faltaba
-- para sostener una sección "Ventas" completa: comprobante de pago, marca de
-- verificación y la posibilidad de reportar una devolución sobre una venta
-- ya cerrada.
-- ============================================================================

alter table public.conversations
  add column deal_payment_proof_url text,
  add column deal_verified boolean not null default false,
  add column deal_verified_at timestamptz,
  add column deal_verified_by uuid references public.agents (id) on delete set null;

comment on column public.conversations.deal_payment_proof_url is 'Captura del comprobante de pago del cliente — subida a mano o elegida entre los archivos ya recibidos en el chat.';
comment on column public.conversations.deal_verified is 'Un asesor confirmó que el comprobante de pago es válido.';

-- "returned" registra una devolución sobre una venta que ya se había marcado
-- "won", sin perder el historial de que la venta ocurrió.
alter table public.conversations drop constraint conversations_deal_status_check;
alter table public.conversations
  add constraint conversations_deal_status_check
  check (deal_status in ('none', 'in_progress', 'won', 'lost', 'returned'));

create index conversations_deal_status_idx on public.conversations (deal_status, deal_closed_at desc);
