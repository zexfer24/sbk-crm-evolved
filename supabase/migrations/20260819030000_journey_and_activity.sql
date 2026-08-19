-- ============================================================================
-- Recorrido del cliente + actividad de mensajes
--
-- El dashboard muestra por dónde va cada cliente desde que escribe por primera
-- vez hasta que queda con un asesor. Las etapas intermedias las conoce el
-- agente de IA, así que las escribe él aquí. Mientras una conversación no
-- tenga journey_stage, el dashboard deduce la etapa de lo que ya sabe
-- (quién habló último, si la IA está activa, si hay asesor asignado).
-- ============================================================================
alter table public.conversations
  add column journey_stage text check (journey_stage in (
    'first_contact', 'inquiry', 'classifying', 'tool_running', 'assigned'
  )),
  add column intent text,
  add column active_tool text,
  add column welcome_sent_at timestamptz;

comment on column public.conversations.journey_stage is
  'Etapa del recorrido que reporta el agente de IA. Null = el dashboard la deduce.';
comment on column public.conversations.intent is
  'Intención detectada por la IA: compra, devolución, reclamo, etc.';
comment on column public.conversations.active_tool is
  'Herramienta que el agente de IA está ejecutando ahora mismo. Null cuando no hay ninguna.';
comment on column public.conversations.welcome_sent_at is
  'Última vez que se envió el mensaje de bienvenida. Se resella cada vez que el cliente vuelve tras cerrarse la ventana de 24 h.';

create index conversations_journey_stage_idx on public.conversations (journey_stage);

-- ============================================================================
-- Actividad de mensajes por hora
--
-- Alimenta el gráfico de 24 h del dashboard. Se resuelve en la base de datos
-- para no traerse al navegador todos los mensajes del día.
-- ============================================================================
create or replace function public.message_activity_by_hour(
  from_ts timestamptz,
  to_ts timestamptz,
  tz text default 'America/Caracas'
)
returns table (
  hour smallint,
  inbound bigint,
  ai bigint,
  agent bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    extract(hour from m.created_at at time zone tz)::smallint as hour,
    count(*) filter (where m.direction = 'inbound') as inbound,
    count(*) filter (where m.sender_type = 'ai') as ai,
    count(*) filter (where m.sender_type = 'agent' and m.is_internal_note = false) as agent
  from public.messages m
  where m.created_at >= from_ts
    and m.created_at < to_ts
    and m.message_type <> 'system_event'
  group by 1
  order by 1;
$$;

comment on function public.message_activity_by_hour is
  'Mensajes por hora local del día indicado: recibidos, respondidos por la IA y respondidos por un asesor.';

grant execute on function public.message_activity_by_hour(timestamptz, timestamptz, text)
  to authenticated, service_role;
