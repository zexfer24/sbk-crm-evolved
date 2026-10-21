-- ============================================================================
-- Registro de uso de los mensajes rápidos y ranking «Más usados» (T2, plan
-- "Presupuestos y mensajes rápidos", 21/10/2026, decisión D8).
--
-- Hasta hoy nadie anota cuándo un asesor usa un mensaje rápido, así que no hay
-- forma de saber cuáles sirven. Esta migración agrega:
--
--   · `quick_reply_uses`: una fila por cada envío de un mensaje rápido (lo
--     escribe el composer, T8). Crece cientos de filas por día.
--   · `quick_replies_mas_usados(p_hasta, p_dias, p_limite)`: el ranking del
--     EQUIPO sobre los últimos `p_dias` días (30 por defecto), con los
--     `p_limite` primeros (5 por defecto). Solo cuenta mensajes que quien
--     consulta puede ver —los compartidos y los suyos—: un personal ajeno
--     nunca aparece, aunque acumule usos.
--
-- «Se actualiza cada 24 h»: el cliente pasa `p_hasta` = la medianoche de hoy en
-- Caracas y la RPC cuenta usos en `[p_hasta - p_dias, p_hasta)`. Así el ranking
-- no se mueve en todo el día.
--
-- Por qué `security definer` (mismo patrón que `resumen_busquedas`,
-- 20260930060000): la tabla crece rápido, y si la lectura pasara por una
-- política RLS `using (is_agent())` se pagaría esa función POR FILA — la
-- trampa que tumbó la búsqueda de /inbox 48 h (20260921030000). Por eso
-- `quick_reply_uses` tiene RLS habilitada con política SOLO de insert y NINGUNA
-- de select: se lee únicamente por la RPC, que chequea `is_agent()` UNA vez y
-- aplica a mano el mismo filtro de visibilidad de `quick_replies`
-- (`owner_id is null or owner_id = auth.uid()`).
--
-- Un `select` directo como `authenticated` da `insufficient_privilege` (no hay
-- grant de select), no 0 filas.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores.
-- ============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. La tabla de usos
-- ---------------------------------------------------------------------------
create table public.quick_reply_uses (
  id uuid primary key default gen_random_uuid(),
  quick_reply_id uuid not null references public.quick_replies(id) on delete cascade,
  agent_id uuid not null default auth.uid() references public.agents(id) on delete cascade,
  conversation_id uuid null references public.conversations(id) on delete set null,
  used_at timestamptz not null default now()
);

comment on table public.quick_reply_uses is
  'Un uso por cada envío de un mensaje rápido (T2, 21/10/2026). RLS sin política de select: se lee SOLO por quick_replies_mas_usados(), no con select directo (una política is_agent() por fila es la trampa de 20260921030000).';

create index quick_reply_uses_used_at_idx on public.quick_reply_uses (used_at);
create index quick_reply_uses_reply_idx on public.quick_reply_uses (quick_reply_id, used_at);

alter table public.quick_reply_uses enable row level security;

-- El `alter default privileges` de Supabase le da ALL a anon/authenticated/
-- service_role a toda tabla nueva de `public`: se quita todo y se devuelve solo
-- lo que hace falta.
revoke all on public.quick_reply_uses from public, anon, authenticated;
grant insert on public.quick_reply_uses to authenticated;
grant select, insert, delete on public.quick_reply_uses to service_role;

create policy quick_reply_uses_insert on public.quick_reply_uses
  for insert to authenticated
  with check (public.is_agent() and agent_id = auth.uid());
-- SIN política de select: ver la cabecera.

-- ---------------------------------------------------------------------------
-- 2. El ranking
-- ---------------------------------------------------------------------------
create function public.quick_replies_mas_usados(
  p_hasta timestamptz,
  p_dias integer default 30,
  p_limite integer default 5
)
returns table (quick_reply_id uuid, usos bigint)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_dias integer := least(greatest(coalesce(p_dias, 30), 1), 90);
  v_limite integer := least(greatest(coalesce(p_limite, 5), 1), 20);
begin
  if p_hasta is null then
    raise exception 'p_hasta es obligatorio' using errcode = '22023';
  end if;

  -- El chequeo de RLS, UNA sola vez: sin él, `security definer` le abriría
  -- los usos a cualquier usuario con sesión (la caja incluida, que no es
  -- agente). Quien no es agente recibe cero filas.
  if not public.is_agent() then
    return;
  end if;

  return query
    select q.id, count(*)::bigint
    from public.quick_reply_uses u
    join public.quick_replies q on q.id = u.quick_reply_id
    where (q.owner_id is null or q.owner_id = auth.uid())
      and u.used_at >= p_hasta - make_interval(days => v_dias)
      and u.used_at < p_hasta
    group by q.id
    order by count(*) desc, q.label asc
    limit v_limite;
end;
$fn$;

comment on function public.quick_replies_mas_usados(timestamptz, integer, integer) is
  'Ranking «Más usados» de los mensajes rápidos (T2, 21/10/2026, D8): usos del equipo en [p_hasta - p_dias, p_hasta), solo de mensajes que quien consulta puede ver (compartidos y propios). p_dias 1..90, p_limite 1..20, p_hasta null lanza 22023. security definer con is_agent() chequeado UNA vez; quien no es agente (anon, caja) recibe cero filas.';

revoke execute on function public.quick_replies_mas_usados(timestamptz, integer, integer) from public;
revoke execute on function public.quick_replies_mas_usados(timestamptz, integer, integer) from anon, authenticated;
grant execute on function public.quick_replies_mas_usados(timestamptz, integer, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.quick_replies_mas_usados(timestamptz,integer,integer)', 'execute') then
    raise exception '20261021020000: anon todavía puede ejecutar quick_replies_mas_usados -- faltó uno de los dos revokes.';
  end if;
  if not has_function_privilege('authenticated', 'public.quick_replies_mas_usados(timestamptz,integer,integer)', 'execute') then
    raise exception '20261021020000: authenticated no puede ejecutar quick_replies_mas_usados y la llama el navegador.';
  end if;
  if not exists (
    select 1 from pg_proc
     where oid = 'public.quick_replies_mas_usados(timestamptz,integer,integer)'::regprocedure and prosecdef
  ) then
    raise exception '20261021020000: quick_replies_mas_usados no quedó security definer.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.quick_reply_uses'::regclass) then
    raise exception '20261021020000: quick_reply_uses no tiene RLS habilitada.';
  end if;
  if has_table_privilege('authenticated', 'public.quick_reply_uses', 'select') then
    raise exception '20261021020000: authenticated no debía poder leer quick_reply_uses con select directo.';
  end if;

  raise notice '20261021020000: autoverificación de quick_reply_uses / quick_replies_mas_usados correcta.';
end
$$;

-- Sin esto PostgREST sigue sirviendo el esquema cacheado y el RPC nuevo da 404
-- hasta que alguien lo recargue a mano (hallazgo M1 del 19/9/2026).
notify pgrst, 'reload schema';
