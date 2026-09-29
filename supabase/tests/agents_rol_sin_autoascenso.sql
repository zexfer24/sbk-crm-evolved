-- ===========================================================================
-- Un agente no se asciende solo: `agents.role` e `id` los cambia únicamente
-- quien tiene autoridad para eso (T7b, plan "Seba encuentra, no insiste, y el
-- mostrador no deja a nadie esperando", 28/9/2026)
--
-- Por qué existe: la política `agents_update_self` (20260819000001) era
-- `for update using (id = auth.uid())` SIN `with check` y el único trigger de
-- `agents` era `set_agents_updated_at`. Un asesor con rol `agent`, autenticado
-- como cualquier otro, podía ejecutar `update public.agents set role = 'admin'
-- where id = auth.uid()` -- 1 fila afectada -- y desde ahí `is_supervisor_or_
-- admin()` daba true para él: todas las políticas de "solo supervisor/admin"
-- (config de la IA, catálogos, facturas) quedaban a su alcance. Verificado
-- contra la base local antes de escribir este test.
--
-- Reglas que fija (migración 20260928050000):
--   (a) un asesor NO cambia su propio `role` (ni a admin ni a supervisor);
--   (b) sí puede cambiar `display_name`/`is_active`/`avatar_url` propios
--       (los usan el perfil y el roster);
--   (c) un supervisor puede cambiar el rol de otro agente (a supervisor/agent);
--   (d) SOLO un admin otorga o quita 'admin': un supervisor no se sube a
--       admin ni sube a otro, y no baja a un admin (decisión del 28/9/2026:
--       la app no escribe `role` en ningún sitio, así que la regla estricta
--       no rompe nada, y "quien otorga admin es admin" cierra el ascenso en
--       dos pasos supervisor -> admin);
--   (e) postgres/service_role (migraciones, scripts, Studio) siguen pudiendo
--       cambiar roles;
--   (f) nadie autenticado cambia el `id` de una fila de `agents`.
--
-- Corre como `authenticated` con claims de un agente real -- como `postgres`
-- se salta la RLS y no mediría nada (mismo criterio que config_solo_supervisor
-- .sql). Los casos de rechazo exigen el mensaje del TRIGGER, no el de la RLS:
-- así una política que rechace por otro motivo no tapa un trigger roto.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

-- Agentes: A (asesor), B (asesor, blanco de los cambios de otros), S y S2
-- (supervisores), AD (admin), X (usuario cuya fila de agents se borra abajo:
-- existe en auth.users, así que un UPDATE de id hacia él no lo frena la FK).
insert into auth.users (id, email, raw_user_meta_data) values
  ('a7a7a7a7-0000-0000-0000-00000000000a', 'agente-a-rol@sbk.test',  jsonb_build_object('display_name', 'A (asesor)')),
  ('a7a7a7a7-0000-0000-0000-00000000000b', 'agente-b-rol@sbk.test',  jsonb_build_object('display_name', 'B (asesor)')),
  ('a7a7a7a7-0000-0000-0000-000000000051', 'agente-s-rol@sbk.test',  jsonb_build_object('display_name', 'S (supervisor)')),
  ('a7a7a7a7-0000-0000-0000-000000000052', 'agente-s2-rol@sbk.test', jsonb_build_object('display_name', 'S2 (supervisor)')),
  ('a7a7a7a7-0000-0000-0000-0000000000ad', 'agente-ad-rol@sbk.test', jsonb_build_object('display_name', 'AD (admin)')),
  ('a7a7a7a7-0000-0000-0000-0000000000ee', 'agente-x-rol@sbk.test',  jsonb_build_object('display_name', 'X (libre)'));

update public.agents set role = 'supervisor' where id in ('a7a7a7a7-0000-0000-0000-000000000051', 'a7a7a7a7-0000-0000-0000-000000000052');
update public.agents set role = 'admin'      where id = 'a7a7a7a7-0000-0000-0000-0000000000ad';
delete from public.agents where id = 'a7a7a7a7-0000-0000-0000-0000000000ee';

-- Ejecuta una sentencia con los privilegios del rol que la llame (security
-- invoker) y devuelve "filas=N" o "error <sqlstate>: <mensaje>".
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

-- Anota en _errores si el resultado de `q` no calza con el patrón esperado.
create or replace function pg_temp.esperar(etiqueta text, q text, patron text) returns void
language plpgsql as $$
declare
  r text;
begin
  r := pg_temp.probar(q);
  if r !~ patron then
    insert into _errores(msg) values (format('%s: se esperaba /%s/ y salió "%s".', etiqueta, patron, r));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Como A (asesor).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'a7a7a7a7-0000-0000-0000-00000000000a';

select pg_temp.esperar('(a) A: role -> admin',
  $q$update public.agents set role = 'admin' where id = 'a7a7a7a7-0000-0000-0000-00000000000a'$q$,
  '^error 42501: Solo un supervisor o admin');
select pg_temp.esperar('(a) A: role -> supervisor',
  $q$update public.agents set role = 'supervisor' where id = 'a7a7a7a7-0000-0000-0000-00000000000a'$q$,
  '^error 42501: Solo un supervisor o admin');
-- Re-escribir el mismo rol no es un cambio: el perfil podría mandarlo.
select pg_temp.esperar('(a) A: role -> agent (el mismo, sin cambio)',
  $q$update public.agents set role = 'agent' where id = 'a7a7a7a7-0000-0000-0000-00000000000a'$q$,
  '^filas=1$');

select pg_temp.esperar('(b) A: display_name propio',
  $q$update public.agents set display_name = 'A editado' where id = 'a7a7a7a7-0000-0000-0000-00000000000a'$q$,
  '^filas=1$');
select pg_temp.esperar('(b) A: is_active propio',
  $q$update public.agents set is_active = false where id = 'a7a7a7a7-0000-0000-0000-00000000000a'$q$,
  '^filas=1$');
select pg_temp.esperar('(b) A: avatar_url propio',
  $q$update public.agents set avatar_url = 'https://ejemplo.test/a.png' where id = 'a7a7a7a7-0000-0000-0000-00000000000a'$q$,
  '^filas=1$');

-- (a bis) A tampoco cambia el rol de OTRO: la RLS ya le da 0 filas.
select pg_temp.esperar('(a) A: role de B (ajeno)',
  $q$update public.agents set role = 'admin' where id = 'a7a7a7a7-0000-0000-0000-00000000000b'$q$,
  '^filas=0$');

select pg_temp.esperar('(f) A: id propio hacia otro usuario existente',
  $q$update public.agents set id = 'a7a7a7a7-0000-0000-0000-0000000000ee' where id = 'a7a7a7a7-0000-0000-0000-00000000000a'$q$,
  '^error 42501: No se puede cambiar el id');

-- ---------------------------------------------------------------------------
-- Como S (supervisor).
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'a7a7a7a7-0000-0000-0000-000000000051';

select pg_temp.esperar('(c) S: role de B agent -> supervisor',
  $q$update public.agents set role = 'supervisor' where id = 'a7a7a7a7-0000-0000-0000-00000000000b'$q$,
  '^filas=1$');
select pg_temp.esperar('(c) S: role de B supervisor -> agent',
  $q$update public.agents set role = 'agent' where id = 'a7a7a7a7-0000-0000-0000-00000000000b'$q$,
  '^filas=1$');

select pg_temp.esperar('(d) S: role propio -> admin',
  $q$update public.agents set role = 'admin' where id = 'a7a7a7a7-0000-0000-0000-000000000051'$q$,
  '^error 42501: Solo un admin');
select pg_temp.esperar('(d) S: role de B -> admin',
  $q$update public.agents set role = 'admin' where id = 'a7a7a7a7-0000-0000-0000-00000000000b'$q$,
  '^error 42501: Solo un admin');
select pg_temp.esperar('(d) S: baja a AD (admin -> agent)',
  $q$update public.agents set role = 'agent' where id = 'a7a7a7a7-0000-0000-0000-0000000000ad'$q$,
  '^error 42501: Solo un admin');

select pg_temp.esperar('(f) S: id de B',
  $q$update public.agents set id = 'a7a7a7a7-0000-0000-0000-0000000000ee' where id = 'a7a7a7a7-0000-0000-0000-00000000000b'$q$,
  '^error 42501: No se puede cambiar el id');

-- ---------------------------------------------------------------------------
-- Como AD (admin): sí otorga y quita admin.
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'a7a7a7a7-0000-0000-0000-0000000000ad';

select pg_temp.esperar('(d) AD: role de B -> admin',
  $q$update public.agents set role = 'admin' where id = 'a7a7a7a7-0000-0000-0000-00000000000b'$q$,
  '^filas=1$');
select pg_temp.esperar('(d) AD: role de B admin -> agent',
  $q$update public.agents set role = 'agent' where id = 'a7a7a7a7-0000-0000-0000-00000000000b'$q$,
  '^filas=1$');

-- ---------------------------------------------------------------------------
-- Como service_role (scripts, la app con el cliente admin): puede cambiar roles.
-- ---------------------------------------------------------------------------
reset "request.jwt.claim.sub";
set local role service_role;

select pg_temp.esperar('(e) service_role: role de A -> supervisor',
  $q$update public.agents set role = 'supervisor' where id = 'a7a7a7a7-0000-0000-0000-00000000000a'$q$,
  '^filas=1$');
select pg_temp.esperar('(e) service_role: role de A -> admin',
  $q$update public.agents set role = 'admin' where id = 'a7a7a7a7-0000-0000-0000-00000000000a'$q$,
  '^filas=1$');

reset role;

-- (e) postgres (migraciones, Studio): también.
select pg_temp.esperar('(e) postgres: role de A -> agent',
  $q$update public.agents set role = 'agent' where id = 'a7a7a7a7-0000-0000-0000-00000000000a'$q$,
  '^filas=1$');

-- ---------------------------------------------------------------------------
-- Estado final visto como postgres: nada de lo rechazado dejó rastro.
-- ---------------------------------------------------------------------------
do $$
declare
  rol_a text;
  rol_s text;
  rol_ad text;
  rol_b text;
begin
  select role into rol_a  from public.agents where id = 'a7a7a7a7-0000-0000-0000-00000000000a';
  select role into rol_s  from public.agents where id = 'a7a7a7a7-0000-0000-0000-000000000051';
  select role into rol_ad from public.agents where id = 'a7a7a7a7-0000-0000-0000-0000000000ad';
  select role into rol_b  from public.agents where id = 'a7a7a7a7-0000-0000-0000-00000000000b';
  -- A terminó en 'agent' por el último caso de postgres; S sigue supervisor,
  -- AD sigue admin, B quedó en 'agent' tras el ciclo del admin.
  if rol_a is distinct from 'agent' then
    insert into _errores(msg) values (format('Estado final: A tiene rol %s, se esperaba agent.', rol_a));
  end if;
  if rol_s is distinct from 'supervisor' then
    insert into _errores(msg) values (format('Estado final: S tiene rol %s, se esperaba supervisor (¿se subió a admin?).', rol_s));
  end if;
  if rol_ad is distinct from 'admin' then
    insert into _errores(msg) values (format('Estado final: AD tiene rol %s, se esperaba admin (¿un supervisor lo bajó?).', rol_ad));
  end if;
  if rol_b is distinct from 'agent' then
    insert into _errores(msg) values (format('Estado final: B tiene rol %s, se esperaba agent.', rol_b));
  end if;
  if not exists (select 1 from public.agents where id = 'a7a7a7a7-0000-0000-0000-00000000000a') then
    insert into _errores(msg) values ('Estado final: la fila de A desapareció (¿se le cambió el id?).');
  end if;
end $$;

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
    raise exception E'agents_rol_sin_autoascenso.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'agents_rol_sin_autoascenso.sql: todas las aserciones pasaron.'
