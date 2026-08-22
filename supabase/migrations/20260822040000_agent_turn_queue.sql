-- ============================================================================
-- Cola de turnos del agente
--
-- Hasta acá el turno corría en after(): en el mismo proceso, sin registro. Si
-- el servidor se reiniciaba —un despliegue, un reinicio del contenedor— justo
-- mientras la IA preparaba una respuesta, esa respuesta se perdía sin dejar
-- rastro y el cliente se quedaba esperando.
--
-- Ahora el webhook encola y el turno se procesa desde la cola. Si el proceso
-- muere, la fila sigue ahí: la recoge el intento siguiente o el cron de
-- /api/cron/process-queue.
-- ============================================================================

create table public.agent_turn_queue (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'failed')),
  attempts integer not null default 0,
  last_error text,
  enqueued_at timestamptz not null default now(),
  started_at timestamptz
);

comment on table public.agent_turn_queue is
  'Conversaciones esperando turno de IA. La clave primaria es la conversación: varios mensajes seguidos del mismo cliente son un solo turno pendiente, no varios.';
comment on column public.agent_turn_queue.attempts is
  'Intentos gastados. Al llegar a MAX_ATTEMPTS la fila queda en failed y deja de reintentarse sola.';

create index agent_turn_queue_pendientes_idx on public.agent_turn_queue (status, enqueued_at);

-- ---------------------------------------------------------------------------
-- Encolar. Si la conversación ya está en la cola no se duplica; si el turno
-- anterior falló, se reabre.
-- ---------------------------------------------------------------------------
create function public.enqueue_agent_turn(p_conversation_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.agent_turn_queue (conversation_id, status, enqueued_at)
  values (p_conversation_id, 'pending', now())
  on conflict (conversation_id) do update
    set status = 'pending',
        enqueued_at = now()
    where public.agent_turn_queue.status <> 'processing';
$$;

-- ---------------------------------------------------------------------------
-- Tomar el siguiente turno. `for update skip locked` es lo que hace que dos
-- procesos trabajando a la vez nunca se lleven la misma fila.
--
-- p_stale_seconds rescata los turnos que quedaron en 'processing' porque el
-- proceso que los tomó murió: pasado ese tiempo se consideran abandonados.
-- ---------------------------------------------------------------------------
create function public.claim_agent_turn(
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
        status = 'pending'
        or (status = 'processing' and started_at < now() - make_interval(secs => p_stale_seconds))
      )
    order by enqueued_at
    limit 1
    for update skip locked
  )
  update public.agent_turn_queue q
  set status = 'processing',
      started_at = now(),
      attempts = q.attempts + 1
  from siguiente
  where q.conversation_id = siguiente.conversation_id
  returning q.conversation_id into claimed;

  return claimed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cerrar un turno: se saca de la cola si salió bien, o se marca el fallo.
-- ---------------------------------------------------------------------------
create function public.finish_agent_turn(p_conversation_id uuid, p_error text default null)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if p_error is null then
    delete from public.agent_turn_queue where conversation_id = p_conversation_id;
  else
    update public.agent_turn_queue
    set status = 'failed', last_error = left(p_error, 500)
    where conversation_id = p_conversation_id;
  end if;
end;
$$;

alter table public.agent_turn_queue enable row level security;

-- El panel de control la lee para mostrar qué quedó pendiente; escribir es
-- cosa del servidor.
create policy "agent_turn_queue_select" on public.agent_turn_queue
  for select using (public.is_agent());

grant select on public.agent_turn_queue to authenticated;
grant select, insert, update, delete on public.agent_turn_queue to service_role;
grant execute on function public.enqueue_agent_turn(uuid) to service_role;
grant execute on function public.claim_agent_turn(integer, integer) to service_role;
grant execute on function public.finish_agent_turn(uuid, text) to service_role;
