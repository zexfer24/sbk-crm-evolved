-- ============================================================================
-- T5a -- Mensajes rápidos personales (plan "Ronda del cliente", 30/9/2026).
--
-- Contexto: `public.quick_replies` (20260819010000) nació con una sola política,
-- `quick_replies_all ... using (is_agent()) with check (is_agent())`: cualquier
-- agente lee, edita y borra todos los mensajes rápidos, y todos son de todos.
-- El cliente pidió poder tener los suyos: un mensaje con dueño solo lo ve, edita
-- y borra ese asesor -- ni un supervisor ni un admin lo ven -- y los
-- compartidos (sin dueño) siguen como hasta hoy.
--
-- `owner_id` es nullable: null = compartido (las filas existentes quedan así, sin
-- backfill). `on delete cascade` sobre `agents(id)`: un mensaje personal no tiene
-- sentido sin su dueño, y dejarlo huérfano lo volvería inalcanzable (no es de
-- nadie y ninguna política lo dejaría ver).
--
-- Las cuatro políticas usan el MISMO predicado
--   is_agent() and (owner_id is null or owner_id = auth.uid())
-- tanto para leer como para escribir. En UPDATE va en `using` (qué filas puede
-- tocar) y en `with check` (cómo quedan): sin el `with check`, un asesor podría
-- pasarle su mensaje a otro cambiando `owner_id`, o "plantárselo" a un colega.
-- Las políticas siguen sin cláusula `to` (rol PUBLIC), igual que la original: la
-- barrera es `is_agent()`, que exige sesión de agente. Los grants a
-- authenticated/service_role no cambian; `service_role` salta la RLS, así que
-- los scripts y la app con el cliente admin ven todo.
--
-- Realtime respeta la RLS de select: el canal de mensajes rápidos ya no le
-- entrega a un asesor los personales de otro.
-- ============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

alter table public.quick_replies
  add column owner_id uuid null references public.agents(id) on delete cascade;

comment on column public.quick_replies.owner_id is
  'null = mensaje rápido compartido (lo ven y editan todos los agentes). Con valor = personal: solo ese asesor lo ve, edita y borra; ni un supervisor ni un admin lo ven (RLS, T5a 30/9/2026). Se borra con su dueño.';

create index quick_replies_owner_id_idx on public.quick_replies (owner_id)
  where owner_id is not null;

drop policy "quick_replies_all" on public.quick_replies;

create policy "quick_replies_select" on public.quick_replies for select
  using (public.is_agent() and (owner_id is null or owner_id = auth.uid()));

create policy "quick_replies_insert" on public.quick_replies for insert
  with check (public.is_agent() and (owner_id is null or owner_id = auth.uid()));

create policy "quick_replies_update" on public.quick_replies for update
  using (public.is_agent() and (owner_id is null or owner_id = auth.uid()))
  with check (public.is_agent() and (owner_id is null or owner_id = auth.uid()));

create policy "quick_replies_delete" on public.quick_replies for delete
  using (public.is_agent() and (owner_id is null or owner_id = auth.uid()));

-- Autoverificación contra el catálogo real (no contra este archivo): la columna
-- existe y es nullable, la política vieja ya no está, y quedan exactamente las
-- cuatro nuevas, una por comando.
do $$
declare
  col_ok integer;
  policy_count integer;
  cmds text;
begin
  select count(*) into col_ok
    from information_schema.columns
    where table_schema = 'public' and table_name = 'quick_replies'
      and column_name = 'owner_id' and data_type = 'uuid' and is_nullable = 'YES';
  if col_ok is distinct from 1 then
    raise exception '20261001010000: quick_replies.owner_id no quedó creada como uuid nullable';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'quick_replies' and policyname = 'quick_replies_all'
  ) then
    raise exception '20261001010000: quick_replies_all sigue existiendo';
  end if;

  select count(*), string_agg(cmd, ',' order by cmd) into policy_count, cmds
    from pg_policies
    where schemaname = 'public' and tablename = 'quick_replies'
      and policyname in ('quick_replies_select', 'quick_replies_insert', 'quick_replies_update', 'quick_replies_delete');
  if policy_count is distinct from 4 or cmds is distinct from 'DELETE,INSERT,SELECT,UPDATE' then
    raise exception '20261001010000: se esperaban las 4 políticas de quick_replies (una por comando) y hay % (%)', policy_count, cmds;
  end if;

  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'quick_replies') is distinct from 4 then
    raise exception '20261001010000: quick_replies debía quedar con exactamente 4 políticas';
  end if;

  raise notice '20261001010000: autoverificación de quick_replies personales correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado (hallazgo M1 del
-- 19/9/2026, misma práctica que las demás migraciones recientes).
notify pgrst, 'reload schema';
