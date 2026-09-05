-- ============================================================================
-- T3.4 del plan "La bandeja que no pierde" (Etapa 3 · Cableado de la Cloud
-- API): salud del número de WhatsApp y estado de las plantillas.
--
-- Hasta hoy el webhook solo escuchaba `change.field === 'messages'`. Meta
-- manda por el mismo webhook de la WABA (WhatsApp Business Account) otros
-- tres eventos que el CRM tiraba en silencio:
--   - `message_template_status_update`: una plantilla pasó a aprobada,
--     rechazada, pausada o deshabilitada.
--   - `phone_number_quality_update`: la calidad del número y su límite de
--     mensajería (TIER_50/250/1K/10K/100K/UNLIMITED) subieron o bajaron.
--   - `account_update`: la cuenta se verificó, se restringió o se
--     deshabilitó a nivel de negocio.
-- Sin guardarlos, un número que empieza a degradarse -- Meta lo pausa antes
-- de deshabilitarlo del todo -- no se notaba hasta que dejaba de entregar
-- mensajes de verdad, con el asesor descubriéndolo por un cliente que
-- reclama.
--
-- Columnas nuevas en whatsapp_channels: la fotografía más reciente de esos
-- dos primeros eventos (el tercero, `message_template_status_update`, no
-- trae número de teléfono -- va aparte, a `templates.status`).
-- `health_updated_at` es de cuándo llegó el último webhook de salud, no de
-- cuándo se creó el canal: así el panel de Control de IA puede decir
-- "sin datos" en vez de fingir una calidad que Meta nunca reportó.
--
-- `templates.status` amplía su CHECK: hasta hoy solo admitía los tres
-- valores con los que nace una plantilla del seed ('approved', 'pending',
-- 'rejected'). `message_template_status_update` puede además pasarla a
-- pausada o deshabilitada, y sin esos dos valores el UPDATE del webhook se
-- habría rechazado por el propio CHECK -- la plantilla se habría quedado
-- con un estado viejo mientras el log decía lo contrario.
-- ============================================================================

alter table public.whatsapp_channels
  add column quality_rating text,
  add column messaging_limit text,
  add column account_restrictions jsonb,
  add column health_updated_at timestamptz;

comment on column public.whatsapp_channels.quality_rating is
  'Calidad reportada por Meta (GREEN/YELLOW/RED). Se guarda tal cual venga en phone_number_quality_update si trae quality_rating explícito; si esa versión del webhook no lo manda, se deriva del event (FLAGGED -> RED, UNFLAGGED/UPGRADE -> GREEN, DOWNGRADE -> YELLOW). Null hasta el primer webhook de calidad.';
comment on column public.whatsapp_channels.messaging_limit is
  'current_limit de phone_number_quality_update (TIER_50/TIER_250/TIER_1K/TIER_10K/TIER_100K/TIER_UNLIMITED). Null hasta el primer webhook de calidad.';
comment on column public.whatsapp_channels.account_restrictions is
  'ban_info/restriction_info del último account_update para este canal. Null si nunca hubo restricción reportada.';
comment on column public.whatsapp_channels.health_updated_at is
  'Cuándo llegó el último webhook de calidad o de cuenta para este canal (no cuándo se creó el canal en el CRM).';

alter table public.templates
  drop constraint templates_status_check;
alter table public.templates
  add constraint templates_status_check
  check (status in ('approved', 'pending', 'rejected', 'paused', 'disabled'));
