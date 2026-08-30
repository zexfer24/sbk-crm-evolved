-- ============================================================================
-- agent_metrics ya no confía solo en el privilegio de ejecución
--
-- Evidencia contra producción el 30/8/2026, con la anon key pública (la que
-- viaja al navegador) y sin sesión:
--   POST /rest/v1/rpc/agent_metrics {"p_days":1} → HTTP 200 con métricas por
--   asesor: mensajes, conversaciones, ventas y montos.
--
-- Primera línea de defensa, 20260830010000: `revoke execute ... from anon`.
-- Esta migración agrega la segunda: la función misma verifica quién
-- pregunta, en vez de depender solo de que el privilegio de EXECUTE quede
-- bien puesto para siempre. Las dos quedan, no una — el revoke es lo que
-- hoy cierra la puerta, la guarda es lo que la mantiene cerrada si algún
-- día un `grant` (de un default privilege, de una migración futura, de un
-- error) la vuelve a abrir.
--
-- Por qué agent_can_run() y agent_spend_today() NO llevan esta guarda,
-- aunque son las otras dos de "Grupo 2" en 20260830010000 (ejecutables por
-- authenticated, no por anon): agent_can_run() invoca a agent_spend_today()
-- en su cuerpo, y el webhook de WhatsApp llama a agent_can_run con
-- service_role (src/app/api/webhooks/whatsapp/route.ts:679, cliente armado
-- en la línea 332 con createAdminClient()). Bajo service_role, auth.uid()
-- es null, así que is_agent() devuelve false: una guarda ahí lanzaría la
-- excepción en cada mensaje entrante y la IA dejaría de responder. Esas dos
-- se protegen solo con el revoke a anon — no se les agrega esta guarda "por
-- consistencia" con agent_metrics.
--
-- Límite honesto de esta guarda, verificado hoy: el trigger
-- on_auth_user_created (20260819000001_initial_schema.sql:44-46) crea
-- automáticamente la fila de public.agents de todo el que se registre en
-- Supabase Auth. Hoy is_agent() equivale a "tiene cuenta en Auth", no a "es
-- un asesor del equipo". Mientras el registro esté abierto, esta guarda no
-- distingue a un asesor de un desconocido recién registrado: lo que de
-- verdad cierra eso es deshabilitar el registro en el servidor
-- (GOTRUE_DISABLE_SIGNUP). La guarda vale igual —cierra el caso de un
-- usuario de Auth sin fila de agente, y deja la función cerrada si el
-- registro alguna vez se cierra— pero no promete más que eso.
-- ============================================================================

create or replace function public.agent_metrics(p_days integer default 30)
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
language plpgsql
stable
security definer set search_path = public
as $$
#variable_conflict use_column
-- Sin esta directiva, cualquier columna del cuerpo que se llame igual que
-- una del `returns table` (agent_id, mensajes_hoy...) revienta con "column
-- reference is ambiguous": plpgsql convierte cada nombre de columna de
-- salida en una variable, y acá el `select` final las usa sin calificar. En
-- `language sql` esto no existía; nace con el cambio a plpgsql de esta
-- migración.
begin
  if not public.is_agent() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  return query
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
    -- 30/8/2026: percentile_cont() devuelve double precision, no numeric. En
    -- `language sql` la coerción al tipo de retorno era implícita; en
    -- plpgsql, `return query` exige que el tipo calce exacto y sin el cast
    -- explícito falla con "structure of query does not match function
    -- result type" en la columna 12.
    pr.mediana_seg::numeric
  from public.agents a
  left join mensajes m on m.agent_id = a.id
  left join ventas v on v.agent_id = a.id
  left join verificadas ver on ver.agent_id = a.id
  left join primera_respuesta pr on pr.agent_id = a.id;
end;
$$;

comment on function public.agent_metrics is
  'Métricas por agente: mensajes, conversaciones atendidas, ventas y monto, verificaciones y mediana del tiempo de primera respuesta. Hoy en hora de Caracas; el período son los últimos p_days días. Guarda interna is_agent() como segunda línea de defensa detrás del revoke a anon (20260830010000).';

notify pgrst, 'reload schema';
