-- ===========================================================================
-- El rol `caja`: usuarios que solo LEEN el Inventario (13/10/2026, migración
-- 20261013010000_rol_caja.sql).
--
-- Contexto: la caja del negocio necesita consultar precio, existencia y tarifa
-- de envío desde el Inventario, y nada más. No puede ver conversaciones,
-- clientes, ventas ni configuración. Como `is_agent()` sostiene 49 políticas
-- de RLS, la separación se hace ahí: `is_agent()` pasa a exigir
-- `role <> 'caja'`, y las tablas del inventario ganan una política de SOLO
-- LECTURA con la función nueva `can_read_inventory()` ("cualquier fila en
-- agents"). Un usuario de caja nace con `raw_app_meta_data.role = 'caja'`
-- (solo lo escribe el servidor: el script `scripts/crear-usuario-caja.ts`), e
-- `is_active = false` para que el reparto de la IA nunca le asigne un chat.
--
-- Qué fija:
--   1. handle_new_agent(): 'caja' nace role='caja' e is_active=false; sin rol,
--      agent/true; el rol SOLO se lee de raw_app_meta_data (el
--      raw_user_meta_data lo puede escribir el propio usuario al registrarse:
--      ahí `role: admin` se ignora); basura cae en 'agent'.
--   2. is_agent() es true para agent/supervisor/admin y false para caja;
--      can_read_inventory() es true para los cuatro roles y false para quien
--      no tiene fila en agents.
--   3. caja lee products, exchange_rates, product_compatibility y las seis
--      tablas del catálogo de motos, `tarifa_mrw_usd` y el campo calculado
--      `tarifa_envio_usd`, y SU fila de agents (ninguna otra).
--   4. caja no ve NI UNA FILA de ninguna otra tabla con RLS de `public`
--      (barrido dinámico: una tabla nueva que olvide el candado lo pone en
--      rojo) y no sube archivos al bucket de multimedia.
--   5. caja no escribe: ni products (ni weight_kg), ni su fila de agents
--      (is_active, role), ni otras filas; no se asciende.
--   6. Nada cambió para un asesor: lee conversaciones/mensajes, cambia
--      weight_kg, edita su fila, sube archivos.
--
-- Corre como `authenticated` con la `sub` de un usuario real -- como
-- `postgres` se salta la RLS y no mediría nada (mismo criterio que
-- agents_rol_sin_autoascenso.sql y precio_estandar_mrw.sql). Un UPDATE que la
-- RLS bloquea afecta 0 filas SIN error: por eso cada rechazo se mide con el
-- conteo de filas Y, al final, leyendo el valor como postgres.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

-- Usuarios: CJ (caja), AG (sin rol: asesor), SU (supervisor por app_metadata),
-- XA (intenta role=admin desde raw_user_meta_data, editable por el usuario),
-- XB (rol basura en app_metadata), NA (existe en auth pero se le borra la
-- fila de agents: autenticado que NO es agente).
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('e9e9e9e9-0000-0000-0000-0000000000c1', 'caja-1@sbk.test',  jsonb_build_object('display_name', 'Caja 1'),   '{"role":"caja"}'::jsonb),
  ('e9e9e9e9-0000-0000-0000-0000000000a1', 'agente-1-caja@sbk.test', jsonb_build_object('display_name', 'Agente 1'), '{}'::jsonb),
  ('e9e9e9e9-0000-0000-0000-0000000000a2', 'super-1-caja@sbk.test',  jsonb_build_object('display_name', 'Super 1'),  '{"role":"supervisor"}'::jsonb),
  ('e9e9e9e9-0000-0000-0000-0000000000a3', 'falso-admin-caja@sbk.test', jsonb_build_object('display_name', 'Falso admin', 'role', 'admin'), '{}'::jsonb),
  ('e9e9e9e9-0000-0000-0000-0000000000a4', 'basura-caja@sbk.test', jsonb_build_object('display_name', 'Rol basura'), '{"role":"dios"}'::jsonb),
  ('e9e9e9e9-0000-0000-0000-0000000000a5', 'sin-fila-caja@sbk.test', jsonb_build_object('display_name', 'Sin fila'), '{}'::jsonb);

delete from public.agents where id = 'e9e9e9e9-0000-0000-0000-0000000000a5';

-- Producto de prueba con peso (products es de solo lectura para la app: se
-- inserta como postgres, antes de cambiar de rol).
insert into public.products (id, name, price, currency, weight_kg, stock_quantity) values
  ('e9e9e9e9-1000-0000-0000-000000000001', 'Producto de prueba caja 1 kg', 100, 'VES', 1.000, 5);

-- Ejecuta una sentencia con los privilegios del rol que la llame y devuelve
-- "filas=N" o "error <sqlstate>: <mensaje>".
create or replace function pg_temp.probar(q text) returns text
language plpgsql as $$
declare
  n integer;
begin
  execute q;
  get diagnostics n = row_count;
  return 'filas=' || n;
exception when others then
  return 'error ' || sqlstate || ': ' || sqlerrm;
end $$;

-- Cuenta las filas que el rol ve en una consulta: "filas=N" o "error ...".
create or replace function pg_temp.contar(q text) returns text
language plpgsql as $$
declare
  n bigint;
begin
  execute 'select count(*) from (' || q || ') s' into n;
  return 'filas=' || n;
exception when others then
  return 'error ' || sqlstate || ': ' || sqlerrm;
end $$;

create or replace function pg_temp.esperar(etiqueta text, r text, patron text) returns void
language plpgsql as $$
begin
  if r !~ patron then
    insert into _errores(msg) values (format('%s: se esperaba /%s/ y salió "%s".', etiqueta, patron, r));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. handle_new_agent() (como postgres)
-- ---------------------------------------------------------------------------
do $$
declare
  caso record;
  r record;
begin
  for caso in
    select * from (values
      ('e9e9e9e9-0000-0000-0000-0000000000c1'::uuid, 'caja',       false),
      ('e9e9e9e9-0000-0000-0000-0000000000a1'::uuid, 'agent',      true),
      ('e9e9e9e9-0000-0000-0000-0000000000a2'::uuid, 'supervisor', true),
      ('e9e9e9e9-0000-0000-0000-0000000000a3'::uuid, 'agent',      true),
      ('e9e9e9e9-0000-0000-0000-0000000000a4'::uuid, 'agent',      true)
    ) as t(id, rol, activo)
  loop
    select role, is_active into r from public.agents where id = caso.id;
    if r.role is distinct from caso.rol or r.is_active is distinct from caso.activo then
      insert into _errores(msg) values (format('handle_new_agent(%s): salió role=%s is_active=%s, se esperaba %s/%s.', caso.id, r.role, r.is_active, caso.rol, caso.activo));
    end if;
  end loop;
end $$;

-- El CHECK acepta 'caja' y sigue rechazando lo demás.
do $$
begin
  begin
    update public.agents set role = 'caja' where id = 'e9e9e9e9-0000-0000-0000-0000000000a1';
    update public.agents set role = 'agent' where id = 'e9e9e9e9-0000-0000-0000-0000000000a1';
  exception when others then
    insert into _errores(msg) values (format('El CHECK de agents.role rechazó ''caja'' (%s).', sqlerrm));
  end;
  begin
    update public.agents set role = 'dios' where id = 'e9e9e9e9-0000-0000-0000-0000000000a1';
    insert into _errores(msg) values ('El CHECK de agents.role aceptó ''dios''.');
  exception when check_violation then
    null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Permisos de las funciones (como postgres)
-- ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.can_read_inventory()', 'EXECUTE') then
    insert into _errores(msg) values ('can_read_inventory(): anon puede ejecutarla.');
  end if;
  if not has_function_privilege('authenticated', 'public.can_read_inventory()', 'EXECUTE') then
    insert into _errores(msg) values ('can_read_inventory(): authenticated NO puede ejecutarla (las políticas de inventario la invocan como authenticated).');
  end if;
  if not has_function_privilege('service_role', 'public.can_read_inventory()', 'EXECUTE') then
    insert into _errores(msg) values ('can_read_inventory(): service_role NO puede ejecutarla.');
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.can_read_inventory()'::regprocedure and prosecdef) then
    insert into _errores(msg) values ('can_read_inventory() no es security definer.');
  end if;
  -- is_agent() NO se revoca nunca (49 políticas TO public la invocan).
  if not has_function_privilege('anon', 'public.is_agent()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.is_agent()', 'EXECUTE') then
    insert into _errores(msg) values ('is_agent() perdió EXECUTE para anon/authenticated: las políticas TO public revientan con 42501.');
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.is_agent()'::regprocedure and prosecdef) then
    insert into _errores(msg) values ('is_agent() dejó de ser security definer.');
  end if;
end $$;

-- Las nueve políticas de solo lectura existen, son SELECT y solo SELECT.
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['products','product_compatibility','exchange_rates','familias_motor','modelos_comerciales','modelo_motor_nexo','repuesto_compatibilidad_motor','repuesto_compatibilidad_modelo','sinonimos_busqueda']
  loop
    select * into p from pg_policy where polrelid = ('public.' || t)::regclass and polname = t || '_select_inventario';
    if not found then
      insert into _errores(msg) values (format('Falta la política %s_select_inventario.', t));
    elsif p.polcmd <> 'r' then
      insert into _errores(msg) values (format('%s_select_inventario no es de SELECT (polcmd=%s).', t, p.polcmd));
    end if;
  end loop;
  -- Ninguna política de escritura de las que dependen de can_read_inventory().
  for p in
    select c.relname, pol.polname
      from pg_policy pol join pg_class c on c.oid = pol.polrelid
     where pol.polcmd <> 'r'
       and (pg_get_expr(pol.polqual, pol.polrelid) ilike '%can_read_inventory%'
         or pg_get_expr(pol.polwithcheck, pol.polrelid) ilike '%can_read_inventory%')
  loop
    insert into _errores(msg) values (format('%s.%s: una política de escritura usa can_read_inventory().', p.relname, p.polname));
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Valores de referencia (como postgres, sin RLS)
-- ---------------------------------------------------------------------------
create temporary table _ref as
select
  (select count(*) from public.products)               as products,
  (select count(*) from public.exchange_rates)         as exchange_rates,
  (select count(*) from public.product_compatibility)  as product_compatibility,
  (select count(*) from public.conversations)         as conversations,
  (select count(*) from public.messages)              as messages,
  (select count(*) from public.contacts)              as contacts,
  (select count(*) from public.orders)                as orders,
  (select count(*) from public.agents)                as agents;
grant select on _ref to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Como CAJA
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'e9e9e9e9-0000-0000-0000-0000000000c1';

select pg_temp.esperar('caja: is_agent()', (select 'valor=' || public.is_agent()), '^valor=false$');
select pg_temp.esperar('caja: can_read_inventory()', (select 'valor=' || public.can_read_inventory()), '^valor=true$');

-- Lecturas del inventario (conteo igual al de postgres).
do $$
declare
  t text;
  esperado bigint;
  r text;
begin
  foreach t in array array['products','exchange_rates','product_compatibility']
  loop
    execute format('select %I from _ref', t) into esperado;
    r := pg_temp.contar(format('select 1 from public.%I', t));
    if r <> 'filas=' || esperado then
      insert into _errores(msg) values (format('caja / lectura de %s: salió "%s", se esperaba filas=%s.', t, r, esperado));
    end if;
  end loop;

  foreach t in array array['familias_motor','modelos_comerciales','modelo_motor_nexo','repuesto_compatibilidad_motor','repuesto_compatibilidad_modelo','sinonimos_busqueda']
  loop
    r := pg_temp.contar(format('select 1 from public.%I', t));
    if r !~ '^filas=[0-9]+$' then
      insert into _errores(msg) values (format('caja / lectura de %s: salió "%s", no debía fallar.', t, r));
    end if;
  end loop;
end $$;

-- Tarifa de envío: la función y el campo calculado sobre products.
do $$
declare
  t numeric;
begin
  t := public.tarifa_mrw_usd(1.0);
  if t is null then
    insert into _errores(msg) values ('caja: tarifa_mrw_usd(1.0) devolvió null.');
  end if;
  select public.tarifa_envio_usd(p) into t from public.products p where p.id = 'e9e9e9e9-1000-0000-0000-000000000001';
  if t is null then
    insert into _errores(msg) values ('caja: tarifa_envio_usd(producto de 1 kg) devolvió null (¿no ve el producto?).');
  end if;
end $$;

-- Su fila de agents, y ninguna otra.
select pg_temp.esperar('caja: ve su fila de agents', pg_temp.contar($q$select 1 from public.agents where id = 'e9e9e9e9-0000-0000-0000-0000000000c1'$q$), '^filas=1$');
select pg_temp.esperar('caja: no ve otras filas de agents', pg_temp.contar($q$select 1 from public.agents where id <> 'e9e9e9e9-0000-0000-0000-0000000000c1'$q$), '^filas=0$');
select pg_temp.esperar('caja: total visible de agents', pg_temp.contar('select 1 from public.agents'), '^filas=1$');

-- Barrido: ninguna OTRA tabla con RLS de `public` le entrega una sola fila
-- (o le niega el permiso de tabla: también vale).
do $$
declare
  t record;
  r text;
begin
  for t in
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
       and c.relname not in ('products','exchange_rates','product_compatibility','familias_motor','modelos_comerciales','modelo_motor_nexo','repuesto_compatibilidad_motor','repuesto_compatibilidad_modelo','sinonimos_busqueda','agents','_errores','_ref')
     order by 1
  loop
    r := pg_temp.contar(format('select 1 from public.%I', t.relname));
    if r !~ '^(filas=0|error 42501)' then
      insert into _errores(msg) values (format('caja / barrido: public.%s devolvió "%s", se esperaba filas=0 o 42501.', t.relname, r));
    end if;
  end loop;
end $$;

-- Escrituras: nada.
select pg_temp.esperar('caja: update weight_kg', pg_temp.probar($q$update public.products set weight_kg = 9.9 where id = 'e9e9e9e9-1000-0000-0000-000000000001'$q$), '^(filas=0|error 42501)');
select pg_temp.esperar('caja: update price', pg_temp.probar($q$update public.products set price = 1 where id = 'e9e9e9e9-1000-0000-0000-000000000001'$q$), '^(filas=0|error 42501)');
select pg_temp.esperar('caja: delete product', pg_temp.probar($q$delete from public.products where id = 'e9e9e9e9-1000-0000-0000-000000000001'$q$), '^(filas=0|error 42501)');
select pg_temp.esperar('caja: insert product', pg_temp.probar($q$insert into public.products (name, price, currency) values ('x', 1, 'VES')$q$), '^error ');
select pg_temp.esperar('caja: update exchange_rates', pg_temp.probar($q$update public.exchange_rates set usd_to_ves = 1$q$), '^(filas=0|error 42501)');
select pg_temp.esperar('caja: insert contacts', pg_temp.probar($q$insert into public.contacts (phone_number) values ('+0000000')$q$), '^error 42501');
select pg_temp.esperar('caja: update agents.is_active propia', pg_temp.probar($q$update public.agents set is_active = true where id = 'e9e9e9e9-0000-0000-0000-0000000000c1'$q$), '^(filas=0|error 42501)');
select pg_temp.esperar('caja: update agents.display_name propia', pg_temp.probar($q$update public.agents set display_name = 'Hackeada' where id = 'e9e9e9e9-0000-0000-0000-0000000000c1'$q$), '^(filas=0|error 42501)');
select pg_temp.esperar('caja: ascenderse a admin', pg_temp.probar($q$update public.agents set role = 'admin' where id = 'e9e9e9e9-0000-0000-0000-0000000000c1'$q$), '^(filas=0|error 42501)');
select pg_temp.esperar('caja: ascenderse a agent', pg_temp.probar($q$update public.agents set role = 'agent' where id = 'e9e9e9e9-0000-0000-0000-0000000000c1'$q$), '^(filas=0|error 42501)');
select pg_temp.esperar('caja: update fila ajena de agents', pg_temp.probar($q$update public.agents set display_name = 'x' where id = 'e9e9e9e9-0000-0000-0000-0000000000a1'$q$), '^(filas=0|error 42501)');
select pg_temp.esperar('caja: insert en agents', pg_temp.probar($q$insert into public.agents (id, display_name, role) values (gen_random_uuid(), 'x', 'admin')$q$), '^error ');
-- Multimedia: no sube archivos al bucket de WhatsApp.
select pg_temp.esperar('caja: sube archivo a whatsapp-media', pg_temp.probar($q$insert into storage.objects (bucket_id, name) values ('whatsapp-media', 'caja-prueba/x.txt')$q$), '^error 42501');

reset role;
reset "request.jwt.claim.sub";

-- Nada de lo que intentó caja cambió (verificado como postgres, sin RLS).
do $$
declare
  p record;
  a record;
begin
  select weight_kg, price into p from public.products where id = 'e9e9e9e9-1000-0000-0000-000000000001';
  if p.weight_kg is distinct from 1.000 or p.price is distinct from 100 then
    insert into _errores(msg) values (format('Tras caja: el producto cambió (weight_kg=%s, price=%s).', p.weight_kg, p.price));
  end if;
  select role, is_active, display_name into a from public.agents where id = 'e9e9e9e9-0000-0000-0000-0000000000c1';
  if a.role is distinct from 'caja' or a.is_active is distinct from false or a.display_name is distinct from 'Caja 1' then
    insert into _errores(msg) values (format('Tras caja: su fila cambió (role=%s, is_active=%s, display_name=%s).', a.role, a.is_active, a.display_name));
  end if;
  if exists (select 1 from public.agents where id = 'e9e9e9e9-0000-0000-0000-0000000000a1' and display_name = 'x') then
    insert into _errores(msg) values ('Tras caja: cambió la fila del asesor.');
  end if;
  if exists (select 1 from public.contacts where phone_number = '+0000000') or exists (select 1 from storage.objects where name = 'caja-prueba/x.txt') then
    insert into _errores(msg) values ('Tras caja: quedó una fila que no debía existir (contacto o archivo).');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Como ASESOR: nada cambió
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'e9e9e9e9-0000-0000-0000-0000000000a1';

select pg_temp.esperar('asesor: is_agent()', (select 'valor=' || public.is_agent()), '^valor=true$');
select pg_temp.esperar('asesor: can_read_inventory()', (select 'valor=' || public.can_read_inventory()), '^valor=true$');

do $$
declare
  t text;
  esperado bigint;
  r text;
begin
  foreach t in array array['products','exchange_rates','product_compatibility','conversations','messages','contacts','orders','agents']
  loop
    execute format('select %I from _ref', t) into esperado;
    r := pg_temp.contar(format('select 1 from public.%I', t));
    if r <> 'filas=' || esperado then
      insert into _errores(msg) values (format('asesor / lectura de %s: salió "%s", se esperaba filas=%s.', t, r, esperado));
    end if;
  end loop;
end $$;

select pg_temp.esperar('asesor: update weight_kg', pg_temp.probar($q$update public.products set weight_kg = 2.5 where id = 'e9e9e9e9-1000-0000-0000-000000000001'$q$), '^filas=1$');
select pg_temp.esperar('asesor: update price (candado de products)', pg_temp.probar($q$update public.products set price = 1 where id = 'e9e9e9e9-1000-0000-0000-000000000001'$q$), '^(filas=0|error 42501)');
select pg_temp.esperar('asesor: edita su fila', pg_temp.probar($q$update public.agents set display_name = 'Agente 1 editado' where id = 'e9e9e9e9-0000-0000-0000-0000000000a1'$q$), '^filas=1$');
select pg_temp.esperar('asesor: se asciende a caja (ni a nada)', pg_temp.probar($q$update public.agents set role = 'caja' where id = 'e9e9e9e9-0000-0000-0000-0000000000a1'$q$), '^error 42501');
select pg_temp.esperar('asesor: sube archivo a whatsapp-media', pg_temp.probar($q$insert into storage.objects (bucket_id, name) values ('whatsapp-media', 'caja-prueba/asesor.txt')$q$), '^filas=1$');
select pg_temp.esperar('asesor: tarifa_mrw_usd', (select 'valor=' || coalesce(public.tarifa_mrw_usd(1.0)::text, 'null')), '^valor=[0-9]');

reset role;
reset "request.jwt.claim.sub";

-- Un supervisor sigue siendo agente (is_agent) y ve la fila de caja en agents
-- (lo hace agents_select_all): la app filtra el listado, no la base.
set local role authenticated;
set local "request.jwt.claim.sub" = 'e9e9e9e9-0000-0000-0000-0000000000a2';
select pg_temp.esperar('supervisor: is_agent()', (select 'valor=' || public.is_agent()), '^valor=true$');
select pg_temp.esperar('supervisor: ve la fila de caja', pg_temp.contar($q$select 1 from public.agents where id = 'e9e9e9e9-0000-0000-0000-0000000000c1'$q$), '^filas=1$');
reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- 5. Autenticado que NO es agente (sin fila en agents)
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'e9e9e9e9-0000-0000-0000-0000000000a5';
select pg_temp.esperar('sin fila: is_agent()', (select 'valor=' || public.is_agent()), '^valor=false$');
select pg_temp.esperar('sin fila: can_read_inventory()', (select 'valor=' || public.can_read_inventory()), '^valor=false$');
select pg_temp.esperar('sin fila: no lee products', pg_temp.contar('select 1 from public.products'), '^filas=0$');
select pg_temp.esperar('sin fila: tarifa_mrw_usd', (select 'valor=' || coalesce(public.tarifa_mrw_usd(1.0)::text, 'null')), '^valor=null$');
reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Veredicto
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'rol_caja.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'rol_caja.sql: todas las aserciones pasaron.'
