-- ============================================================================
-- "Los números del día" (10/9/2026) — T0: un RPC que resume el día de un
-- asesor, y la venta se atribuye a quien la cerró (no a quien la tenía
-- asignada)
--
-- CORRECCIÓN sobre el plan original: `conversations.assigned_at` NO es
-- nueva. Existe desde `20260822080000_agent_metrics.sql` (esa migración
-- creó la columna, el índice `conversations_assigned_at_idx` y pasó
-- `on_conversation_assigned`/`handle_conversation_assigned()` a `before`
-- para poder sellar `new.assigned_at := now()` al asignar — y limpiarlo a
-- `null` al desasignar—). `src/lib/supabase/database.types.ts` había
-- quedado desactualizado sin esa columna, y de ahí salió la lectura
-- equivocada de que faltaba crearla: la primera versión de esta migración
-- intentaba un `alter table add column` y un `create index` que ya existían
-- (habría reventado en producción con "column already exists"/"relation
-- already exists") y una función/trigger redundante con
-- `handle_conversation_assigned()`. Se retiró todo eso; ni `assigned_at` ni
-- `on_conversation_assigned` se tocan acá.
--
-- Consecuencia práctica para `agent_day_summary` de abajo: "asignadas" es
-- `null` en `assigned_at` SOLO para las conversaciones que ya estaban
-- asignadas ANTES del 22/8/2026 (fecha de esa migración), no desde el
-- 10/9/2026 como decía la primera versión de este comentario — el dato
-- lleva acumulándose casi tres semanas antes de esta corrida.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- agent_day_summary(p_from, p_to): el resumen del día de UN asesor —el que
-- pregunta, auth.uid()—, pensado para un panel que muestra "hoy" sin tener
-- que pegarle a agent_metrics() (que trae de más: mensajes, verificaciones,
-- mediana de primera respuesta, TODOS los asesores) para una sola tarjeta.
--
-- Mismo patrón de guarda que agent_metrics (20260830030000): el revoke a
-- anon/PUBLIC es la primera línea de defensa, is_agent() adentro es la
-- segunda por si algún día un grant de más la reabre.
-- ----------------------------------------------------------------------------
create function public.agent_day_summary(p_from timestamptz, p_to timestamptz)
returns table (
  asignadas bigint,
  respondidas bigint,
  ventas bigint,
  monto numeric
)
language plpgsql
stable
security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_agent() then
    raise exception 'no autorizado' using errcode = '42501';
  end if;

  return query
  select
    (
      select count(*)
      from public.conversations c
      where c.assigned_agent_id = auth.uid()
        and c.assigned_at >= p_from
        and c.assigned_at < p_to
    ) as asignadas,
    (
      select count(distinct m.conversation_id)
      from public.messages m
      where m.sender_agent_id = auth.uid()
        and m.sender_type = 'agent'
        and not m.is_internal_note
        and m.created_at >= p_from
        and m.created_at < p_to
    ) as respondidas,
    (
      select count(*)
      from public.conversations c
      left join public.orders o on o.id = c.order_id
      where c.deal_status = 'won'
        and c.deal_closed_by = auth.uid()
        and c.deal_closed_at >= p_from
        and c.deal_closed_at < p_to
    ) as ventas,
    (
      select coalesce(sum(o.total_amount), 0)
      from public.conversations c
      left join public.orders o on o.id = c.order_id
      where c.deal_status = 'won'
        and c.deal_closed_by = auth.uid()
        and c.deal_closed_at >= p_from
        and c.deal_closed_at < p_to
    ) as monto;
end;
$$;

comment on function public.agent_day_summary is
  'Resumen del día de UN asesor (el que pregunta, auth.uid()): conversaciones asignadas, mensajes respondidos y ventas/monto cerradas por él en [p_from, p_to). "Asignadas" cuenta sobre conversations.assigned_at (existe desde 20260822080000; null solo para lo asignado antes de esa fecha). Ventas se atribuye a quien CERRÓ (deal_closed_by), no a quien tiene asignada la conversación — ver la nota de la decisión 8 en agent_metrics más abajo en esta misma migración. Guarda interna is_agent(), igual que agent_metrics.';

revoke execute on function public.agent_day_summary(timestamptz, timestamptz) from public;
revoke execute on function public.agent_day_summary(timestamptz, timestamptz) from anon, authenticated;
grant execute on function public.agent_day_summary(timestamptz, timestamptz) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Decisión 8 (aprobada por el operador, 10/9/2026, corrida "Los números del
-- día"): hasta hoy `agent_metrics()` atribuía una venta al asesor ASIGNADO
-- (`c.assigned_agent_id`) mientras que el resto del CRM —la lista de Ventas
-- (`sales-view`, T5 de "Seis frentes del buzón") y ahora `agent_day_summary`
-- de arriba— la atribuye a quien la CERRÓ (`c.deal_closed_by`): dos fuentes
-- de verdad distintas para la misma pregunta ("¿de quién es esta venta?"),
-- que no coinciden cuando un caso se reasigna antes de cerrar (soporte
-- transfiere el chat a un asesor de ventas, y el que lo cierra no es el que
-- lo tenía asignado cuando arrancó). Se alinea `agent_metrics` al criterio
-- del resto del sistema: agrupar por `deal_closed_by`. El único cambio real
-- es la CTE `ventas` (agrupa por `c.deal_closed_by` en vez de
-- `c.assigned_agent_id`, y filtra `c.deal_closed_by is not null` en vez de
-- `c.assigned_agent_id is not null`); el resto del cuerpo es una copia
-- textual del vigente en 20260830030000_agent_metrics_guarda.sql. `create or
-- replace` no toca el ACL de la función (revokes/grants se conservan tal
-- cual quedaron en 20260830010000), pero se repiten igual acá porque el
-- guardián estático de permisos (`src/lib/permisos-funciones.test.ts`) exige
-- encontrar ambos revokes en el historial de migraciones por nombre de
-- función, y repetirlos en la migración que toca la función es más fácil de
-- auditar que confiar en que sigan estando cuatro archivos atrás.
-- ----------------------------------------------------------------------------
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
  --
  -- 10/9/2026 (decisión 8): se agrupa por QUIEN CERRÓ (deal_closed_by), no
  -- por quien tiene la conversación asignada — ver la nota grande arriba de
  -- este `create or replace` en esta misma migración (20260910010000).
  ventas as (
    select
      c.deal_closed_by as agent_id,
      count(*) filter (where (c.deal_closed_at at time zone 'America/Caracas')::date = l.hoy) as hoy,
      count(*) filter (where c.deal_closed_at >= l.desde) as periodo,
      coalesce(sum(o.total_amount) filter (
        where (c.deal_closed_at at time zone 'America/Caracas')::date = l.hoy
      ), 0) as monto_hoy,
      coalesce(sum(o.total_amount) filter (where c.deal_closed_at >= l.desde), 0) as monto_periodo
    from public.conversations c
    cross join limites l
    left join public.orders o on o.id = c.order_id
    where c.deal_closed_by is not null
      and c.deal_status = 'won'
      and c.deal_closed_at is not null
    group by c.deal_closed_by
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
    pr.mediana_seg::numeric
  from public.agents a
  left join mensajes m on m.agent_id = a.id
  left join ventas v on v.agent_id = a.id
  left join verificadas ver on ver.agent_id = a.id
  left join primera_respuesta pr on pr.agent_id = a.id;
end;
$$;

comment on function public.agent_metrics is
  'Métricas por agente: mensajes, conversaciones atendidas, ventas y monto, verificaciones y mediana del tiempo de primera respuesta. Hoy en hora de Caracas; el período son los últimos p_days días. Guarda interna is_agent() como segunda línea de defensa detrás del revoke a anon (20260830010000). Desde el 10/9/2026 (decisión 8) las ventas se atribuyen a quien CERRÓ el trato (deal_closed_by), igual que el resto del CRM (sales-view, agent_day_summary) — antes se atribuían al asesor asignado.';

revoke execute on function public.agent_metrics(integer) from public;
revoke execute on function public.agent_metrics(integer) from anon, authenticated;
grant execute on function public.agent_metrics(integer) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Autoverificación: si algo de lo de arriba no quedó como debía, esta
-- migración corta con excepción en vez de dejar la base a medias en
-- silencio.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'agent_day_summary'
  ) then
    raise exception '20260910010000: falta la función agent_day_summary';
  end if;

  if has_function_privilege('anon', 'public.agent_day_summary(timestamptz,timestamptz)', 'execute') then
    raise exception '20260910010000: anon puede ejecutar agent_day_summary — faltó algún revoke';
  end if;

  if not exists (
    select 1 from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'agent_metrics'
  ) then
    raise exception '20260910010000: agent_metrics desapareció tras el create or replace';
  end if;
end $$;

notify pgrst, 'reload schema';
