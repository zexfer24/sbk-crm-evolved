-- ============================================================================
-- El lock de turno de la IA nace con vencimiento y dueño
--
-- El 29/8/2026 una revisión encontró el hueco de `ai_turn_running`
-- (migración 20260819100000): es un booleano sin TTL. Si el proceso muere
-- entre adquirirlo y el `finally` que lo suelta —un crash, un redeploy a
-- mitad de turno—, la conversación queda muda para siempre: nadie vuelve a
-- poner `ai_turn_running` en false, y cada turno posterior "pierde" la
-- carrera en silencio, sin error visible.
--
-- La corrección es un lease con dueño: vence solo (no depende de que nadie
-- lo suelte) y solo quien lo tomó puede renovarlo o soltarlo (un token
-- aleatorio por turno, no un booleano). Esta migración solo agrega las
-- columnas y las funciones; el código que las usa (adquirir con TTL, renovar
-- mientras el turno vive, soltar al terminar) llega en un commit posterior.
-- ============================================================================

alter table public.conversations
  add column if not exists ai_turn_lock_until timestamptz,
  add column if not exists ai_turn_lock_token  text;

comment on column public.conversations.ai_turn_lock_until is
  'Hasta cuándo vale el lock del turno de IA. Null o vencido = libre. El propio turno lo renueva mientras vive.';
comment on column public.conversations.ai_turn_lock_token is
  'Dueño del lock: solo quien lo tomó puede renovarlo o soltarlo. Sin esto, un turno zombi soltaría el lock del que vino después.';
comment on column public.conversations.ai_turn_running is
  'OBSOLETA: el lock vive en ai_turn_lock_until/ai_turn_lock_token. Se elimina en una migración posterior, cuando el código con lease lleve tiempo en producción.';

-- ---------------------------------------------------------------------------
-- Toma el lock si está libre (null o vencido). Atómico: el UPDATE
-- condicional es quien decide, no un SELECT previo.
-- ---------------------------------------------------------------------------
create function public.ai_turn_lock_acquire(
  p_conversation_id uuid,
  p_token text,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer set search_path = public
as $$
begin
  update public.conversations
  set ai_turn_lock_token = p_token,
      ai_turn_lock_until = now() + make_interval(secs => p_lease_seconds)
  where id = p_conversation_id
    and (ai_turn_lock_until is null or ai_turn_lock_until <= now());

  return found;
end;
$$;

comment on function public.ai_turn_lock_acquire is
  'true si el lock estaba libre y quedó tomado por p_token. false si otro turno ya lo tenía vigente.';

-- ---------------------------------------------------------------------------
-- Renueva el lock mientras el turno sigue vivo. A propósito SIN condición de
-- vencimiento: un turno vivo cuyo lease se pasó (una pausa larga del
-- proceso, por ejemplo) recupera la propiedad si nadie se la llevó todavía;
-- si otro turno ya la tomó, el token no coincide y el UPDATE no toca nada.
-- ---------------------------------------------------------------------------
create function public.ai_turn_lock_renew(
  p_conversation_id uuid,
  p_token text,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer set search_path = public
as $$
begin
  update public.conversations
  set ai_turn_lock_token = p_token,
      ai_turn_lock_until = now() + make_interval(secs => p_lease_seconds)
  where id = p_conversation_id
    and ai_turn_lock_token = p_token;

  return found;
end;
$$;

comment on function public.ai_turn_lock_renew is
  'true si p_token seguía siendo el dueño y el lease se extendió. false si otro turno ya tomó el lock.';

-- ---------------------------------------------------------------------------
-- Suelta el lock al terminar el turno. Solo el dueño puede soltarlo.
-- ---------------------------------------------------------------------------
create function public.ai_turn_lock_release(
  p_conversation_id uuid,
  p_token text
)
returns boolean
language plpgsql
security definer set search_path = public
as $$
begin
  update public.conversations
  set ai_turn_lock_until = null,
      ai_turn_lock_token = null
  where id = p_conversation_id
    and ai_turn_lock_token = p_token;

  return found;
end;
$$;

comment on function public.ai_turn_lock_release is
  'true si p_token era el dueño y el lock quedó libre. false si ya no era el dueño (otro turno lo tomó primero).';

-- Solo el cliente admin del servidor (service_role) puede tocar el lock:
-- ningún camino con sesión de usuario debe poder trabar —ni destrabar— la IA
-- de un chat ajeno.
revoke execute on function public.ai_turn_lock_acquire(uuid, text, integer) from public;
revoke execute on function public.ai_turn_lock_renew(uuid, text, integer) from public;
revoke execute on function public.ai_turn_lock_release(uuid, text) from public;

grant execute on function public.ai_turn_lock_acquire(uuid, text, integer) to service_role;
grant execute on function public.ai_turn_lock_renew(uuid, text, integer) to service_role;
grant execute on function public.ai_turn_lock_release(uuid, text) to service_role;

notify pgrst, 'reload schema';
