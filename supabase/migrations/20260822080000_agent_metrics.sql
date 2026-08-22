-- ============================================================================
-- Métricas por agente para «Control de agentes»
--
-- Se agrega `conversations.assigned_at` porque no existía: el trigger de
-- asignación solo sellaba `agents.last_assigned_at` (a quién le tocó el turno),
-- y con eso no se puede saber cuánto tardó ESA conversación en recibir su
-- primer mensaje.
--
-- El dato empieza a acumularse desde acá. Las conversaciones ya asignadas
-- quedan con assigned_at nulo y no entran en el tiempo de primera respuesta:
-- inventarles una fecha daría una métrica falsa.
-- ============================================================================

alter table public.conversations add column assigned_at timestamptz;

comment on column public.conversations.assigned_at is
  'Cuándo se le asignó esta conversación al asesor actual. Base del tiempo de primera respuesta.';

-- Las que ya están asignadas arrancan sin fecha: no se puede saber cuándo fue.
create index conversations_assigned_at_idx on public.conversations (assigned_agent_id, assigned_at)
  where assigned_at is not null;

-- ---------------------------------------------------------------------------
-- El trigger que ya existía ahora también sella la conversación.
-- ---------------------------------------------------------------------------
create or replace function public.handle_conversation_assigned()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.assigned_agent_id is not null
     and (TG_OP = 'INSERT' or new.assigned_agent_id is distinct from old.assigned_agent_id) then
    update public.agents set last_assigned_at = now() where id = new.assigned_agent_id;
    -- El reloj del tiempo de respuesta arranca acá.
    new.assigned_at := now();
  elsif new.assigned_agent_id is null then
    -- Al desasignar se limpia: si vuelve a asignarse, el reloj empieza de cero.
    new.assigned_at := null;
  end if;
  return new;
end;
$$;

-- Pasa a BEFORE: un trigger AFTER no puede modificar la fila que se está
-- guardando, y `new.assigned_at` se perdería.
drop trigger if exists on_conversation_assigned on public.conversations;
create trigger on_conversation_assigned
  before insert or update of assigned_agent_id on public.conversations
  for each row execute function public.handle_conversation_assigned();

-- ---------------------------------------------------------------------------
-- Métricas por agente: hoy y el período, en una sola pasada.
--
-- «Hoy» es el día en hora de Caracas, igual que el resto del CRM: si fuera
-- UTC, lo trabajado después de las 8pm aparecería como del día siguiente.
-- ---------------------------------------------------------------------------
create function public.agent_metrics(p_days integer default 30)
returns table (
  agent_id uuid,
  mensajes_hoy bigint,
  mensajes_periodo bigint,
  conversaciones_hoy bigint,
  conversaciones_periodo bigint,
  ventas_hoy bigint,
  ventas_periodo bigint,
  monto_hoy numeric,
  monto_periodo numeric,
  verificadas_hoy bigint,
  verificadas_periodo bigint,
  primera_respuesta_mediana_seg numeric
)
language sql
stable
security definer set search_path = public
as $$
  with
  limites as (
    select
      (now() at time zone 'America/Caracas')::date as hoy,
      now() - make_interval(days => p_days) as desde
  ),

  -- Mensajes que escribió a clientes. Las notas internas no cuentan: no las
  -- lee nadie del otro lado.
  mensajes as (
    select
      m.sender_agent_id as agent_id,
      count(*) filter (where (m.created_at at time zone 'America/Caracas')::date = l.hoy) as hoy,
      count(*) filter (where m.created_at >= l.desde) as periodo,
      count(distinct m.conversation_id) filter (
        where (m.created_at at time zone 'America/Caracas')::date = l.hoy
      ) as convs_hoy,
      count(distinct m.conversation_id) filter (where m.created_at >= l.desde) as convs_periodo
    from public.messages m
    cross join limites l
    where m.sender_agent_id is not null
      and m.sender_type = 'agent'
      and not m.is_internal_note
    group by m.sender_agent_id
  ),

  -- Ventas cerradas. El monto sale de la orden enlazada, que a su vez viene de
  -- lo que la IA cotizó de verdad en el chat.
  ventas as (
    select
      c.assigned_agent_id as agent_id,
      count(*) filter (where (c.deal_closed_at at time zone 'America/Caracas')::date = l.hoy) as hoy,
      count(*) filter (where c.deal_closed_at >= l.desde) as periodo,
      coalesce(sum(o.total_amount) filter (
        where (c.deal_closed_at at time zone 'America/Caracas')::date = l.hoy
      ), 0) as monto_hoy,
      coalesce(sum(o.total_amount) filter (where c.deal_closed_at >= l.desde), 0) as monto_periodo
    from public.conversations c
    cross join limites l
    left join public.orders o on o.id = c.order_id
    where c.assigned_agent_id is not null
      and c.deal_status = 'won'
      and c.deal_closed_at is not null
    group by c.assigned_agent_id
  ),

  -- Verificar comprobantes es cosa de supervisión: un asesor no puede.
  verificadas as (
    select
      c.deal_verified_by as agent_id,
      count(*) filter (where (c.deal_verified_at at time zone 'America/Caracas')::date = l.hoy) as hoy,
      count(*) filter (where c.deal_verified_at >= l.desde) as periodo
    from public.conversations c
    cross join limites l
    where c.deal_verified_by is not null and c.deal_verified_at is not null
    group by c.deal_verified_by
  ),

  -- Tiempo entre que le asignan la conversación y su primer mensaje.
  primera_respuesta as (
    select
      c.assigned_agent_id as agent_id,
      -- Mediana y no promedio: una conversación asignada un viernes en la
      -- tarde y contestada el lunes arrastraría el promedio de todo el mes.
      percentile_cont(0.5) within group (
        order by extract(epoch from (primer.momento - c.assigned_at))
      ) as mediana_seg
    from public.conversations c
    cross join limites l
    cross join lateral (
      select min(m.created_at) as momento
      from public.messages m
      where m.conversation_id = c.id
        and m.sender_agent_id = c.assigned_agent_id
        and m.sender_type = 'agent'
        and not m.is_internal_note
        and m.created_at >= c.assigned_at
    ) primer
    where c.assigned_at is not null
      and c.assigned_at >= l.desde
      and primer.momento is not null
    group by c.assigned_agent_id
  )

  select
    a.id,
    coalesce(m.hoy, 0),
    coalesce(m.periodo, 0),
    coalesce(m.convs_hoy, 0),
    coalesce(m.convs_periodo, 0),
    coalesce(v.hoy, 0),
    coalesce(v.periodo, 0),
    coalesce(v.monto_hoy, 0),
    coalesce(v.monto_periodo, 0),
    coalesce(ver.hoy, 0),
    coalesce(ver.periodo, 0),
    pr.mediana_seg
  from public.agents a
  left join mensajes m on m.agent_id = a.id
  left join ventas v on v.agent_id = a.id
  left join verificadas ver on ver.agent_id = a.id
  left join primera_respuesta pr on pr.agent_id = a.id;
$$;

comment on function public.agent_metrics is
  'Métricas por agente: mensajes, conversaciones atendidas, ventas y monto, verificaciones y mediana del tiempo de primera respuesta. Hoy en hora de Caracas; el período son los últimos p_days días.';

grant execute on function public.agent_metrics(integer) to authenticated, service_role;
