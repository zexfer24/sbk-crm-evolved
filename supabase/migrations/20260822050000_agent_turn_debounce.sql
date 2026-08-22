-- ============================================================================
-- Ventana de silencio en la cola de turnos
--
-- Meta entrega casi siempre un POST por mensaje, así que agrupar dentro de un
-- mismo lote no alcanza: un cliente que escribe «hola» / «quiero un
-- carburador» / «para una Bera» con dos segundos entre cada uno dejaba dos
-- comportamientos, los dos malos.
--
--   1. Si el turno anterior ya había terminado: tres turnos y tres respuestas
--      a una sola idea. Molesto para el cliente y se paga tres veces.
--
--   2. Si el turno anterior seguía corriendo (lo normal, tarda de 3 a 8
--      segundos): el `where status <> 'processing'` impedía reabrir la fila y
--      finish_agent_turn la borraba al terminar. Los mensajes 2 y 3 se
--      perdían en silencio, que es justo lo que la cola venía a evitar.
--
-- Se arregla con dos cosas: una ventana que se corre hacia adelante con cada
-- mensaje, y una marca para volver a correr si algo llegó mientras se
-- procesaba.
-- ============================================================================

alter table public.agent_turn_queue
  add column process_after timestamptz not null default now(),
  add column rerun_requested boolean not null default false;

comment on column public.agent_turn_queue.process_after is
  'No se toca el turno antes de este momento. Cada mensaje nuevo lo empuja, así una ráfaga de tipeo termina siendo un solo turno con todo el contexto.';
comment on column public.agent_turn_queue.rerun_requested is
  'El cliente escribió mientras el turno corría. Al terminar se vuelve a encolar en vez de borrarse: si no, ese mensaje quedaría sin respuesta.';

-- El índice de pendientes ahora tiene que mirar también la ventana.
drop index if exists agent_turn_queue_pendientes_idx;
create index agent_turn_queue_pendientes_idx
  on public.agent_turn_queue (status, process_after, enqueued_at);

-- ---------------------------------------------------------------------------
-- Las firmas viejas se tiran antes de crear las nuevas.
--
-- `create or replace` con una lista de parámetros distinta NO reemplaza: crea
-- una sobrecarga. Con la nueva teniendo valor por defecto, llamar
-- `enqueue_agent_turn('...')` con un solo argumento pasa a ser ambiguo y
-- Postgres responde «function is not unique». Se detectó al ejecutarlo.
-- ---------------------------------------------------------------------------
drop function if exists public.enqueue_agent_turn(uuid);
drop function if exists public.finish_agent_turn(uuid, text);

-- ---------------------------------------------------------------------------
-- Encolar: empuja la ventana. Si el turno está corriendo, no se le toca el
-- estado — se marca para repetirlo cuando termine.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_agent_turn(
  p_conversation_id uuid,
  p_debounce_seconds integer default 6
)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.agent_turn_queue (conversation_id, status, enqueued_at, process_after)
  values (
    p_conversation_id,
    'pending',
    now(),
    now() + make_interval(secs => p_debounce_seconds)
  )
  on conflict (conversation_id) do update
  set
    -- Corriendo: se respeta y se marca para repetir.
    rerun_requested = (public.agent_turn_queue.status = 'processing'),
    status = case
      when public.agent_turn_queue.status = 'processing' then 'processing'
      else 'pending'
    end,
    -- Un mensaje nuevo es un caso nuevo: si el turno anterior había agotado
    -- sus intentos, vuelve a tener oportunidad.
    attempts = case
      when public.agent_turn_queue.status = 'failed' then 0
      else public.agent_turn_queue.attempts
    end,
    process_after = now() + make_interval(secs => p_debounce_seconds);
  -- enqueued_at NO se actualiza a propósito: ordena la cola, y empujarlo
  -- dejaría a quien escribe mucho siempre al final.
$$;

-- ---------------------------------------------------------------------------
-- Reclamar: además de lo de antes, respeta la ventana.
-- ---------------------------------------------------------------------------
create or replace function public.claim_agent_turn(
  p_max_attempts integer default 3,
  p_stale_seconds integer default 300
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  claimed uuid;
begin
  with siguiente as (
    select conversation_id
    from public.agent_turn_queue
    where attempts < p_max_attempts
      and (
        (status = 'pending' and process_after <= now())
        or (status = 'processing' and started_at < now() - make_interval(secs => p_stale_seconds))
      )
    order by enqueued_at
    limit 1
    for update skip locked
  )
  update public.agent_turn_queue q
  set status = 'processing',
      started_at = now(),
      attempts = q.attempts + 1,
      -- Se limpia al empezar: lo que llegue de acá en adelante sí cuenta
      -- como mensaje nuevo que este turno no alcanzó a ver.
      rerun_requested = false
  from siguiente
  where q.conversation_id = siguiente.conversation_id
  returning q.conversation_id into claimed;

  return claimed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cerrar: si llegó algo mientras corría, vuelve a la cola en vez de borrarse.
-- ---------------------------------------------------------------------------
create or replace function public.finish_agent_turn(
  p_conversation_id uuid,
  p_error text default null,
  p_debounce_seconds integer default 6
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  repetir boolean;
begin
  select rerun_requested into repetir
  from public.agent_turn_queue
  where conversation_id = p_conversation_id;

  if p_error is not null then
    -- Con error se marca el fallo y se respeta el tope de intentos, aunque
    -- haya mensajes nuevos: si no, un turno que falla siempre reintentaría
    -- sin fin mientras el cliente siga escribiendo.
    update public.agent_turn_queue
    set status = 'failed', last_error = left(p_error, 500)
    where conversation_id = p_conversation_id;

  elsif coalesce(repetir, false) then
    update public.agent_turn_queue
    set status = 'pending',
        rerun_requested = false,
        attempts = 0,
        process_after = now() + make_interval(secs => p_debounce_seconds)
    where conversation_id = p_conversation_id;

  else
    delete from public.agent_turn_queue where conversation_id = p_conversation_id;
  end if;
end;
$$;

grant execute on function public.enqueue_agent_turn(uuid, integer) to service_role;
grant execute on function public.claim_agent_turn(integer, integer) to service_role;
grant execute on function public.finish_agent_turn(uuid, text, integer) to service_role;
