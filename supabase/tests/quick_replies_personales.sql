-- ===========================================================================
-- Mensajes rápidos personales (T5a, plan "Ronda del cliente", 30/9/2026,
-- migración 20261001010000).
--
-- Regla que fija: un mensaje rápido con dueño (`quick_replies.owner_id`) solo
-- lo ve, edita y borra ESE asesor; ni un supervisor ni un admin lo ven. Los
-- compartidos (`owner_id is null`) siguen como hasta hoy: cualquier agente los
-- lee y los edita.
--
-- Corre como `authenticated` con los claims de un agente real -- como
-- `postgres` se salta la RLS y no mediría nada (mismo criterio que
-- agents_rol_sin_autoascenso.sql y config_solo_supervisor.sql). Usa los agentes
-- del seed local: 1111 (supervisor), 2222 (A) y 3333 (B).
--
-- Casos:
--   1. A crea uno personal y uno compartido; A ve los dos.
--   2. B no ve el personal de A, ve el compartido, y ni UPDATE ni DELETE sobre
--      el personal de A le afectan una fila.
--   3. El supervisor tampoco ve el personal de A.
--   4. B no puede insertar con owner_id = A.
--   5. A no puede pasarle su mensaje a B cambiando owner_id (with check del
--      update).
--   6. Cualquiera edita un compartido.
--   7. Borrar al agente A borra sus personales (on delete cascade) y deja los
--      compartidos.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

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

grant execute on function pg_temp.probar(text), pg_temp.esperar(text, text, text) to authenticated, service_role;

-- Ids fijos de las filas de prueba.
--   a0a0...01 personal de A, a0a0...02 compartido.
-- ---------------------------------------------------------------------------
-- Caso 1: A crea uno personal y uno compartido; A ve los dos.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

select pg_temp.esperar('1: A inserta su personal',
  $q$insert into public.quick_replies (id, label, content, owner_id)
     values ('a0a0a0a0-0000-0000-0000-000000000001', 'Personal de A', 'texto A', '22222222-2222-2222-2222-222222222222')$q$,
  '^filas=1$');
select pg_temp.esperar('1: A inserta un compartido',
  $q$insert into public.quick_replies (id, label, content)
     values ('a0a0a0a0-0000-0000-0000-000000000002', 'Compartido de prueba', 'texto compartido')$q$,
  '^filas=1$');
-- Los conteos de lectura van en bloques `do`: `execute` de un select no
-- devuelve row_count, así que probar() solo sirve para insert/update/delete.
do $$
declare n integer;
begin
  select count(*) into n from public.quick_replies
    where id in ('a0a0a0a0-0000-0000-0000-000000000001', 'a0a0a0a0-0000-0000-0000-000000000002');
  if n <> 2 then
    insert into _errores(msg) values (format('1: A debería ver sus 2 filas y ve %s.', n));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 2: B no ve el personal de A, ve el compartido, no lo toca.
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';

do $$
declare n integer;
begin
  select count(*) into n from public.quick_replies where id = 'a0a0a0a0-0000-0000-0000-000000000001';
  if n <> 0 then
    insert into _errores(msg) values (format('2: B ve %s fila(s) del personal de A; debía ver 0.', n));
  end if;
  select count(*) into n from public.quick_replies where id = 'a0a0a0a0-0000-0000-0000-000000000002';
  if n <> 1 then
    insert into _errores(msg) values (format('2: B ve %s fila(s) del compartido; debía ver 1.', n));
  end if;
end $$;

select pg_temp.esperar('2: B intenta actualizar el personal de A',
  $q$update public.quick_replies set content = 'robado' where id = 'a0a0a0a0-0000-0000-0000-000000000001'$q$,
  '^filas=0$');
select pg_temp.esperar('2: B intenta borrar el personal de A',
  $q$delete from public.quick_replies where id = 'a0a0a0a0-0000-0000-0000-000000000001'$q$,
  '^filas=0$');

-- ---------------------------------------------------------------------------
-- Caso 4: B no puede insertar con owner_id = A (with check del insert).
-- ---------------------------------------------------------------------------
select pg_temp.esperar('4: B inserta con owner_id = A',
  $q$insert into public.quick_replies (label, content, owner_id)
     values ('Falso de A', 'x', '22222222-2222-2222-2222-222222222222')$q$,
  '^error 42501');

-- Caso 6 (parte B): B edita un compartido.
select pg_temp.esperar('6: B edita un compartido',
  $q$update public.quick_replies set content = 'editado por B' where id = 'a0a0a0a0-0000-0000-0000-000000000002'$q$,
  '^filas=1$');

-- ---------------------------------------------------------------------------
-- Caso 3: el supervisor tampoco ve el personal de A.
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

do $$
declare n integer;
begin
  select count(*) into n from public.quick_replies where id = 'a0a0a0a0-0000-0000-0000-000000000001';
  if n <> 0 then
    insert into _errores(msg) values (format('3: el supervisor ve %s fila(s) del personal de A; debía ver 0.', n));
  end if;
  select count(*) into n from public.quick_replies where id = 'a0a0a0a0-0000-0000-0000-000000000002';
  if n <> 1 then
    insert into _errores(msg) values (format('3: el supervisor ve %s fila(s) del compartido; debía ver 1.', n));
  end if;
end $$;

select pg_temp.esperar('3: el supervisor intenta borrar el personal de A',
  $q$delete from public.quick_replies where id = 'a0a0a0a0-0000-0000-0000-000000000001'$q$,
  '^filas=0$');
-- Caso 6 (parte supervisor): edita un compartido.
select pg_temp.esperar('6: el supervisor edita un compartido',
  $q$update public.quick_replies set content = 'editado por el supervisor' where id = 'a0a0a0a0-0000-0000-0000-000000000002'$q$,
  '^filas=1$');

-- ---------------------------------------------------------------------------
-- Caso 5: A no puede pasarle su mensaje a B cambiando owner_id.
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

select pg_temp.esperar('5: A cambia owner_id del suyo a B',
  $q$update public.quick_replies set owner_id = '33333333-3333-3333-3333-333333333333'
     where id = 'a0a0a0a0-0000-0000-0000-000000000001'$q$,
  '^error 42501');
-- Tampoco puede volverlo compartido (owner_id = null) de contrabando: eso sí
-- lo permite el predicado (null es compartido) y es un cambio legítimo del
-- dueño sobre lo suyo; lo dejamos fuera del test a propósito.
-- Caso 6 (parte A): A edita un compartido, y su propio personal.
select pg_temp.esperar('6: A edita un compartido',
  $q$update public.quick_replies set content = 'editado por A' where id = 'a0a0a0a0-0000-0000-0000-000000000002'$q$,
  '^filas=1$');
select pg_temp.esperar('6: A edita su personal',
  $q$update public.quick_replies set content = 'A editado' where id = 'a0a0a0a0-0000-0000-0000-000000000001'$q$,
  '^filas=1$');

reset "request.jwt.claim.sub";
reset role;

-- ---------------------------------------------------------------------------
-- Estado: el personal de A sigue siendo de A y con su texto (nada de lo
-- rechazado dejó rastro).
-- ---------------------------------------------------------------------------
do $$
declare
  dueno uuid;
  texto text;
begin
  select owner_id, content into dueno, texto
    from public.quick_replies where id = 'a0a0a0a0-0000-0000-0000-000000000001';
  if dueno is distinct from '22222222-2222-2222-2222-222222222222'::uuid then
    insert into _errores(msg) values (format('Estado: el dueño del personal de A quedó en %s.', dueno));
  end if;
  if texto is distinct from 'A editado' then
    insert into _errores(msg) values (format('Estado: el texto del personal de A quedó en "%s".', texto));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 7: borrar al agente A (como postgres) borra sus personales y deja los
-- compartidos.
-- ---------------------------------------------------------------------------
do $$
declare n integer;
begin
  delete from public.agents where id = '22222222-2222-2222-2222-222222222222';
  select count(*) into n from public.quick_replies where id = 'a0a0a0a0-0000-0000-0000-000000000001';
  if n <> 0 then
    insert into _errores(msg) values (format('7: al borrar al agente A quedaron %s personal(es) suyo(s).', n));
  end if;
  select count(*) into n from public.quick_replies where id = 'a0a0a0a0-0000-0000-0000-000000000002';
  if n <> 1 then
    insert into _errores(msg) values (format('7: al borrar al agente A el compartido debía sobrevivir y hay %s.', n));
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
    raise exception E'quick_replies_personales.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'quick_replies_personales.sql: todas las aserciones pasaron.'
