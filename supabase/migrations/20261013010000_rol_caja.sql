-- ============================================================================
-- El rol `caja`: usuarios que solo LEEN el Inventario (13/10/2026).
--
-- Contexto: la caja del negocio necesita consultar precio, existencia y tarifa
-- de envío desde el Inventario, y nada más: sin conversaciones, clientes,
-- ventas, facturas ni configuración. Hoy cualquier fila de `agents` pasa por
-- `is_agent()` y `is_agent()` abre las 49 políticas de RLS del CRM, así que
-- "darle una cuenta" a la caja equivalía a darle todo.
--
-- Decisión de diseño: la separación vive en la BASE, no en la interfaz.
--
--   1. `agents.role` admite un cuarto valor, 'caja'.
--   2. `is_agent()` pasa a exigir `role <> 'caja'`. Para agent/supervisor/admin
--      nada cambia (toda fila existente tiene uno de esos tres roles, y la
--      función ya no mira `is_active` desde 20260825040000); una cuenta de
--      caja deja de pasar TODAS las políticas existentes sin tocar ninguna.
--      `is_agent()` NO se revoca a nadie (excepción permanente de CLAUDE.md:
--      las políticas `TO public` la invocan).
--   3. `can_read_inventory()` es la pregunta nueva, más ancha: "¿este
--      auth.uid() tiene fila en agents?", con cualquier rol. Solo la usan
--      políticas de SELECT del inventario y `tarifa_mrw_usd`.
--   4. Las nueve tablas del inventario/catálogo de motos ganan una política
--      `<tabla>_select_inventario` de SOLO LECTURA. Ninguna política de
--      escritura nueva: `products` sigue siendo de solo lectura para la app
--      salvo `weight_kg` (20260925010000) y esa vía la sigue frenando
--      `products_all` (is_agent) más el trigger; una caja afecta 0 filas.
--   5. `agents`: la caja lee SU fila (`agents_select_self`; la app la
--      necesita para saber quién es) y no la edita (`agents_update_self`
--      exige `role <> 'caja'`: no se enciende `is_active`, no cambia su rol
--      ni su nombre). El `with check` de 20260928050000 se conserva.
--   6. `handle_new_agent()` lee el rol de `raw_app_meta_data` (lo escribe SOLO
--      el servidor, p. ej. `scripts/crear-usuario-caja.ts`) y nunca de
--      `raw_user_meta_data`, que el propio usuario puede escribir al
--      registrarse. Una caja nace con `is_active = false`: la IA no le
--      asigna chats (`claimNextAvailableAgent` filtra por `is_active`).
--   7. El bucket `whatsapp-media` solo admitía INSERT de "cualquier
--      authenticated" (20260819010000): con cuentas que ya no son agentes
--      eso es un agujero, así que exige `is_agent()`.
--
-- Qué se audita y NO se redefine (la app lo filtra): `agent_metrics()` y
-- `agent_day_summary()` listan `public.agents` entero; una fila 'caja'
-- aparecería ahí con ceros, igual que `agents_select_all` la muestra a
-- supervisores. El roster de Control de agentes y el reparto de la IA
-- tienen que filtrar `role <> 'caja'` en la app.
--
-- ESTA MIGRACIÓN SE APLICA DENTRO DE UNA SOLA TRANSACCIÓN --
-- `psql -1 -v ON_ERROR_STOP=1` -- mismo motivo que las anteriores: `set local
-- lock_timeout` fuera de una transacción es un NO-OP silencioso. Toca
-- `agents`, que `is_agent()` lee en TODAS las políticas: sin tope de espera,
-- un lock largo congelaría el CRM entero.
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
-- 1. El CHECK de agents.role admite 'caja'
-- ---------------------------------------------------------------------------
alter table public.agents drop constraint if exists agents_role_check;
alter table public.agents
  add constraint agents_role_check
  check (role in ('agent', 'supervisor', 'admin', 'caja'));

-- ---------------------------------------------------------------------------
-- 2. is_agent(): una caja NO es un agente del CRM
-- ---------------------------------------------------------------------------
-- Mismas propiedades que la versión de 20260825040000 (sql, stable, definer,
-- search_path public). `create or replace` conserva el ACL: no se revoca nada.
create or replace function public.is_agent()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.agents
    where id = auth.uid() and role <> 'caja'
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. can_read_inventory(): cualquier fila de agents, caja incluida
-- ---------------------------------------------------------------------------
-- Es la barrera de las políticas de SOLO LECTURA del inventario. Definer para
-- leer `agents` sin pagar su RLS, y para que se evalúe UNA vez por consulta
-- (mismo motivo que search_conversations_by_message, 20260921030000).
create or replace function public.can_read_inventory()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (select 1 from public.agents where id = auth.uid());
$$;

comment on function public.can_read_inventory() is
  'true si auth.uid() tiene fila en public.agents, con CUALQUIER rol (agent, supervisor, admin o caja). is_agent() excluye a la caja; esta no. Solo la usan políticas de SELECT del inventario y tarifa_mrw_usd (13/10/2026).';

-- Los dos revokes (PUBLIC y anon/authenticated) y el grant a quien sí la usa:
-- las políticas se evalúan con los privilegios del rol que consulta, así que
-- `authenticated` la necesita; `anon` no.
revoke execute on function public.can_read_inventory() from public;
revoke execute on function public.can_read_inventory() from anon, authenticated;
grant execute on function public.can_read_inventory() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Políticas de SOLO LECTURA sobre el inventario y el catálogo de motos
-- ---------------------------------------------------------------------------
-- Ya existen las políticas `for all ... is_agent()` de escritura; estas se
-- suman (las permisivas se combinan con OR). Se verifica además que
-- `authenticated` conserve el permiso de tabla SELECT: sin él la política
-- no sirve de nada. NO se agrega ningún grant de escritura.
do $$
declare
  t text;
begin
  foreach t in array array[
    'products',
    'product_compatibility',
    'exchange_rates',
    'familias_motor',
    'modelos_comerciales',
    'modelo_motor_nexo',
    'repuesto_compatibilidad_motor',
    'repuesto_compatibilidad_modelo',
    'sinonimos_busqueda'
  ]
  loop
    if to_regclass('public.' || t) is null then
      raise notice '20261013010000: public.% no existe en esta base; se omite su política de lectura.', t;
      continue;
    end if;

    execute format('drop policy if exists %I on public.%I', t || '_select_inventario', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.can_read_inventory())',
      t || '_select_inventario', t
    );

    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      raise exception '20261013010000: authenticated no tiene SELECT sobre public.%; la política de lectura no serviría de nada', t;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. agents: la caja lee su fila y no la edita
-- ---------------------------------------------------------------------------
drop policy if exists "agents_select_self" on public.agents;
create policy "agents_select_self" on public.agents
  for select to authenticated
  using (id = auth.uid());

-- Conserva el `with check` de 20260928050000 y suma `role <> 'caja'` a los dos
-- lados: una caja no se enciende `is_active` ni se cambia el nombre, y
-- tampoco puede "salir" de caja por su cuenta (no pasa el using).
drop policy if exists "agents_update_self" on public.agents;
create policy "agents_update_self" on public.agents
  for update
  using (id = auth.uid() and role <> 'caja')
  with check (id = auth.uid() and role <> 'caja');

-- ---------------------------------------------------------------------------
-- 6. tarifa_mrw_usd(): el chequeo de acceso pasa a can_read_inventory()
-- ---------------------------------------------------------------------------
-- MISMO cuerpo que 20261012010000; solo cambia `is_agent()` por
-- `can_read_inventory()`: la caja ve el precio estándar en Inventario.
create or replace function public.tarifa_mrw_usd(p_peso numeric)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_peso is null or p_peso <= 0 or p_peso >= 80 then null
    when current_setting('role', true) = 'authenticated' and not public.can_read_inventory() then null
    else (
      select r.tarifa_usd
      from public.shipping_rates r
      where r.carrier = 'mrw'
        and r.desde_kg <= p_peso
        and p_peso < r.hasta_kg
    )
  end;
$$;

revoke execute on function public.tarifa_mrw_usd(numeric) from public;
revoke execute on function public.tarifa_mrw_usd(numeric) from anon;
grant execute on function public.tarifa_mrw_usd(numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. handle_new_agent(): el rol sale de raw_app_meta_data
-- ---------------------------------------------------------------------------
-- `raw_app_meta_data` solo lo escribe el servidor (auth.admin.createUser con
-- `app_metadata`); `raw_user_meta_data` lo puede mandar el propio usuario al
-- registrarse, así que NUNCA decide el rol. Cualquier valor fuera de la lista
-- cae en 'agent'. Es un INSERT, no toca el trigger `agents_role_guard` (BEFORE
-- UPDATE).
--
-- OJO, medido contra la base local el 13/10/2026: GoTrue hace el INSERT en
-- auth.users con el app_metadata de fábrica (`provider`/`providers`) y recién
-- DESPUÉS un UPDATE con el `app_metadata` que se le pasó a createUser. Este
-- trigger es AFTER INSERT, así que por esa vía el rol no llega: un
-- createUser con `app_metadata: { role: 'caja' }` produce un agente
-- ('agent', activo). `scripts/crear-usuario-caja.ts` lo resuelve fijando el
-- rol en `agents` con service_role y confirmándolo; este camino sirve para
-- inserts directos en SQL (los tests, un alta manual).
create or replace function public.handle_new_agent()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_rol text;
begin
  v_rol := new.raw_app_meta_data ->> 'role';
  if v_rol is null or v_rol not in ('agent', 'supervisor', 'admin', 'caja') then
    v_rol := 'agent';
  end if;

  insert into public.agents (id, display_name, full_name, avatar_url, role, is_active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url',
    v_rol,
    v_rol <> 'caja'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- `create or replace` conserva el ACL, pero se repite explícito (idempotente).
revoke execute on function public.handle_new_agent() from public;
revoke execute on function public.handle_new_agent() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Multimedia: subir archivos al bucket exige ser agente
-- ---------------------------------------------------------------------------
drop policy if exists "whatsapp_media_insert_authenticated" on storage.objects;
create policy "whatsapp_media_insert_authenticated" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'whatsapp-media' and public.is_agent());

-- ---------------------------------------------------------------------------
-- Autoverificación contra el catálogo real
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.agents'::regclass and conname = 'agents_role_check'
       and pg_get_constraintdef(oid) like '%caja%'
  ) then
    raise exception '20261013010000: agents_role_check no admite ''caja''';
  end if;

  if not exists (
    select 1 from pg_proc
     where oid = 'public.is_agent()'::regprocedure and prosecdef and prosrc like '%caja%'
  ) then
    raise exception '20261013010000: is_agent() no excluye a la caja o dejó de ser security definer';
  end if;

  if not exists (
    select 1 from pg_proc where oid = 'public.can_read_inventory()'::regprocedure and prosecdef
  ) then
    raise exception '20261013010000: can_read_inventory() no quedó creada como security definer';
  end if;
  if has_function_privilege('anon', 'public.can_read_inventory()', 'EXECUTE') then
    raise exception '20261013010000: anon puede ejecutar can_read_inventory()';
  end if;
  if not has_function_privilege('authenticated', 'public.can_read_inventory()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.can_read_inventory()', 'EXECUTE') then
    raise exception '20261013010000: authenticated y service_role deben poder ejecutar can_read_inventory()';
  end if;

  -- is_agent() sigue ejecutable por todos (49 políticas TO public la invocan).
  if not has_function_privilege('anon', 'public.is_agent()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.is_agent()', 'EXECUTE') then
    raise exception '20261013010000: is_agent() perdió EXECUTE para anon/authenticated';
  end if;

  foreach t in array array['products', 'product_compatibility', 'exchange_rates', 'familias_motor', 'modelos_comerciales', 'modelo_motor_nexo', 'repuesto_compatibilidad_motor', 'repuesto_compatibilidad_modelo', 'sinonimos_busqueda']
  loop
    if to_regclass('public.' || t) is not null and not exists (
      select 1 from pg_policy
       where polrelid = ('public.' || t)::regclass and polname = t || '_select_inventario' and polcmd = 'r'
    ) then
      raise exception '20261013010000: falta la política %_select_inventario', t;
    end if;
  end loop;

  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.agents'::regclass and polname = 'agents_select_self'
  ) then
    raise exception '20261013010000: falta agents_select_self';
  end if;
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.agents'::regclass and polname = 'agents_update_self'
       and pg_get_expr(polqual, polrelid) like '%caja%'
       and pg_get_expr(polwithcheck, polrelid) like '%caja%'
  ) then
    raise exception '20261013010000: agents_update_self debía quedar con role <> ''caja'' en using y with check';
  end if;

  if not exists (
    select 1 from pg_proc where oid = 'public.tarifa_mrw_usd(numeric)'::regprocedure and prosecdef and prosrc like '%can_read_inventory%'
  ) then
    raise exception '20261013010000: tarifa_mrw_usd debía usar can_read_inventory()';
  end if;
  if not exists (
    select 1 from pg_proc where oid = 'public.handle_new_agent()'::regprocedure and prosecdef and prosrc like '%caja%'
  ) then
    raise exception '20261013010000: handle_new_agent() no conoce el rol caja';
  end if;
  if has_function_privilege('anon', 'public.handle_new_agent()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.handle_new_agent()', 'EXECUTE') then
    raise exception '20261013010000: handle_new_agent() quedó ejecutable por anon/authenticated';
  end if;

  raise notice '20261013010000: autoverificación del rol caja correcta.';
end
$$;

-- Sin esto PostgREST puede seguir sirviendo el esquema cacheado hasta que
-- alguien lo recargue a mano (hallazgo M1, 19/9/2026).
notify pgrst, 'reload schema';
