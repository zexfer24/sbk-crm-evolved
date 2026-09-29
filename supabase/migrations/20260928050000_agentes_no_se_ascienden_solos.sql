-- ============================================================================
-- Un agente no se asciende solo (T7b, plan "Seba encuentra, no insiste, y el
-- mostrador no deja a nadie esperando", 28/9/2026).
--
-- Hueco hallado revisando la RLS de la tabla de configuración: la política
-- `agents_update_self` (20260819000001) es `for update using (id = auth.uid())`
-- SIN `with check`, y el único trigger de `agents` era `set_agents_updated_at`.
-- Un asesor con rol `agent` autenticado como cualquier otro podía correr
-- `update public.agents set role = 'admin' where id = auth.uid()` -- 1 fila
-- afectada, comprobado en la base local -- y desde ahí `is_supervisor_or_
-- admin()` daba true: config de la IA, catálogos, facturas y el resto de las
-- acciones "solo supervisor/admin" (que la app protege EN RLS, no solo en la
-- interfaz) quedaban a su alcance con una sola llamada a la API. La interfaz
-- nunca escribe `role` (solo `is_active`, `last_assigned_at`, y el perfil),
-- así que el hueco no se veía usando la app.
--
-- Qué hace esta migración (dos capas, ninguna se banca sola):
--
--   1. `agents_update_self` gana `with check (id = auth.uid())`: un asesor no
--      puede dejar la fila con otro id. (Drop/create de la política.)
--
--   2. Trigger BEFORE UPDATE OF role, id `agents_role_guard` (función
--      `enforce_agents_role_guard`, SECURITY INVOKER a propósito: con
--      `definer`, `current_user` sería siempre el dueño de la función y nunca
--      frenaría a nadie -- mismo motivo que `enforce_products_read_only`,
--      20260925010000):
--        · postgres / supabase_admin / service_role pasan sin más
--          (migraciones, Studio, scripts del VPS y el cliente admin de la
--          app, que ya es de confianza por construcción);
--        · cualquier otro rol: cambiar `id` se rechaza siempre; cambiar
--          `role` exige `is_supervisor_or_admin()` Y, si el cambio otorga o
--          quita 'admin', ser admin. Re-escribir el mismo valor no es un
--          cambio y pasa (`UPDATE OF role` también dispara si la columna
--          solo aparece en el SET).
--      Decisión (d) del plan, 28/9/2026: SOLO un admin otorga o quita
--      'admin'. La app no escribe `role` en ningún sitio, así que la regla
--      estricta no rompe nada, y evita el ascenso en dos pasos (un
--      supervisor se sube a admin, o sube a otro).
--
-- Cómo se distingue quién escribe: `current_user` (el rol al que PostgREST
-- hace SET ROLE según el JWT: `authenticated`/`service_role`), no el rol de
-- sesión (`authenticator`). La función es `security invoker`, así que
-- `current_user` es el del llamador. Limitación conocida: una función
-- `security definer` propiedad de `postgres` que hiciera este UPDATE por
-- cuenta de un asesor pasaría el trigger -- hoy no existe ninguna.
--
-- La función de trigger NO es `security definer`: no entra a la lista que
-- cuenta `permisos-funciones.test.ts`, y no necesita los dos revokes.
-- Tampoco toca `handle_new_agent()`: ese trigger es AFTER INSERT sobre
-- auth.users y solo hace INSERT en agents (el rol nace en su default
-- 'agent'), no UPDATE, así que este guarda no lo alcanza.
--
-- Fuera de alcance, y anotado como deuda: `agents_update_by_supervisor`
-- (20260819090000) sigue dejando que un supervisor edite cualquier otra
-- columna de cualquier agente (nombre, `is_active`, `last_assigned_at`): es
-- lo que usa el roster de Control de agentes, a propósito.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso y el `drop
-- policy`/`create trigger` sobre `agents` (que `is_agent()` lee en TODAS las
-- políticas) correría sin tope de espera.
-- ============================================================================
set local lock_timeout = '5s';

-- Guarda contra el no-op silencioso de `set local` (hallazgo 10, revisión
-- `/code-review high` del 19/9/2026): falla cerrado sin `psql -1`.
do $$
begin
  if current_setting('lock_timeout') in ('0', '0ms') then
    raise exception 'Esta migración se aplica dentro de una transacción (psql -1 -v ON_ERROR_STOP=1): sin ella, set local lock_timeout es un no-op y el DDL correría sin límite de espera.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. with check en la política de "editar lo mío".
-- ---------------------------------------------------------------------------
drop policy if exists "agents_update_self" on public.agents;
create policy "agents_update_self" on public.agents
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. El trigger que cierra el ascenso.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_agents_role_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Migraciones, Studio, scripts del VPS y el cliente admin de la app.
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if new.id is distinct from old.id then
    raise exception 'No se puede cambiar el id de un agente (public.agents.id).'
      using errcode = 'insufficient_privilege';
  end if;

  if new.role is distinct from old.role then
    if not public.is_supervisor_or_admin() then
      raise exception 'Solo un supervisor o admin puede cambiar el rol de un agente (public.agents.role).'
        using errcode = 'insufficient_privilege';
    end if;

    -- Otorgar o quitar 'admin' es cosa de un admin. is_supervisor_or_admin()
    -- ya dejó claro que quien escribe es un agente, así que puede leer su
    -- propia fila bajo RLS.
    if (new.role = 'admin' or old.role = 'admin')
       and not exists (
         select 1 from public.agents
          where id = auth.uid() and role = 'admin'
       ) then
      raise exception 'Solo un admin puede otorgar o quitar el rol admin (public.agents.role).'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_agents_role_guard() is
  'Trigger BEFORE UPDATE OF role, id sobre public.agents (T7b, 28/9/2026): un agente no se asciende solo. Rechaza cambiar el id, y cambiar el rol sin ser supervisor/admin; otorgar o quitar admin exige ser admin. postgres/supabase_admin/service_role pasan. SECURITY INVOKER a propósito (current_user debe ser el del llamador).';

drop trigger if exists agents_role_guard on public.agents;
create trigger agents_role_guard
  before update of role, id on public.agents
  for each row execute function public.enforce_agents_role_guard();

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real.
-- ---------------------------------------------------------------------------
do $$
declare
  with_check_txt text;
  definer boolean;
begin
  select pg_get_expr(polwithcheck, polrelid) into with_check_txt
    from pg_policy
   where polrelid = 'public.agents'::regclass and polname = 'agents_update_self';
  if with_check_txt is null then
    raise exception '20260928050000: agents_update_self debía quedar con WITH CHECK y no lo tiene';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.agents'::regclass
       and tgname = 'agents_role_guard'
       and not tgisinternal
  ) then
    raise exception '20260928050000: el trigger agents_role_guard no quedó creado en public.agents';
  end if;

  select prosecdef into definer
    from pg_proc
   where oid = 'public.enforce_agents_role_guard()'::regprocedure;
  if definer then
    raise exception '20260928050000: enforce_agents_role_guard debía ser SECURITY INVOKER (current_user del llamador)';
  end if;

  raise notice '20260928050000: autoverificación de agents_role_guard (política con with check, trigger creado, función invoker) correcta.';
end
$$;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado hasta que
-- alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
