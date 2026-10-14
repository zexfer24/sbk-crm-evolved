-- ===========================================================================
-- Respuestas rápidas con fotos (14/10/2026, migración 20261014020000).
--
-- Regla que fija: `quick_replies.media_paths` guarda hasta 10 rutas del bucket
-- `whatsapp-media`, todas bajo `quick-replies/`, sin `..` ni elementos null; el
-- default es '{}'. El CHECK lo hace cumplir la base, no la interfaz.
--
-- Casos:
--   a. Insert sin media_paths -> '{}'.
--   b. Insert con 2 rutas válidas.
--   c. 11 rutas -> check_violation.
--   d. Ruta fuera de `quick-replies/` -> check_violation.
--   e. Ruta con `..` -> check_violation.
--   f. Un elemento null -> check_violation.
--   g. Como `authenticated` (agente del seed, 2222): insertar una personal con 1
--      foto y actualizar media_paths funciona (el CHECK ejecuta la función con
--      los privilegios de quien escribe: si le faltara el EXECUTE, esto fallaría).
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

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

-- a. Sin media_paths -> '{}'
select pg_temp.esperar('a: insert sin media_paths',
  $q$insert into public.quick_replies (id, label, content)
     values ('b0b0b0b0-0000-0000-0000-00000000000a', 'Sin fotos', 'texto')$q$,
  '^filas=1$');
do $$
declare v text[];
begin
  select media_paths into v from public.quick_replies where id = 'b0b0b0b0-0000-0000-0000-00000000000a';
  if v is distinct from '{}'::text[] then
    insert into _errores(msg) values (format('a: el default debía ser {} y es %L.', v));
  end if;
end $$;

-- b. Dos rutas válidas
select pg_temp.esperar('b: dos rutas válidas',
  $q$insert into public.quick_replies (id, label, content, media_paths)
     values ('b0b0b0b0-0000-0000-0000-00000000000b', 'Con fotos', 'texto',
             array['quick-replies/uno.jpg', 'quick-replies/dos.png'])$q$,
  '^filas=1$');

-- Exactamente 10 rutas es el tope permitido.
select pg_temp.esperar('b2: diez rutas (el tope)',
  $q$insert into public.quick_replies (label, content, media_paths)
     select 'Diez', 'texto', array_agg('quick-replies/' || i || '.jpg') from generate_series(1, 10) i$q$,
  '^filas=1$');

-- c. Once rutas
select pg_temp.esperar('c: once rutas',
  $q$insert into public.quick_replies (label, content, media_paths)
     select 'Once', 'texto', array_agg('quick-replies/' || i || '.jpg') from generate_series(1, 11) i$q$,
  '^error 23514');

-- d. Ruta fuera del prefijo
select pg_temp.esperar('d: ruta de outbound',
  $q$insert into public.quick_replies (label, content, media_paths)
     values ('Ajena', 'texto', array['outbound/x.jpg'])$q$,
  '^error 23514');

-- e. Ruta con ..
select pg_temp.esperar('e: ruta con ..',
  $q$insert into public.quick_replies (label, content, media_paths)
     values ('Escapa', 'texto', array['quick-replies/../outbound/x.jpg'])$q$,
  '^error 23514');

-- f. Elemento null
select pg_temp.esperar('f: elemento null',
  $q$insert into public.quick_replies (label, content, media_paths)
     values ('Nulo', 'texto', array['quick-replies/uno.jpg', null])$q$,
  '^error 23514');

-- g. Como agente authenticated
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

select pg_temp.esperar('g: personal con 1 foto',
  $q$insert into public.quick_replies (id, label, content, owner_id, media_paths)
     values ('b0b0b0b0-0000-0000-0000-00000000000c', 'Personal con foto', 'texto',
             '22222222-2222-2222-2222-222222222222', array['quick-replies/uno.jpg'])$q$,
  '^filas=1$');
select pg_temp.esperar('g: update de media_paths',
  $q$update public.quick_replies set media_paths = array['quick-replies/uno.jpg', 'quick-replies/dos.jpg']
     where id = 'b0b0b0b0-0000-0000-0000-00000000000c'$q$,
  '^filas=1$');
select pg_temp.esperar('g: update con ruta inválida lo rechaza el CHECK',
  $q$update public.quick_replies set media_paths = array['outbound/x.jpg']
     where id = 'b0b0b0b0-0000-0000-0000-00000000000c'$q$,
  '^error 23514');

reset "request.jwt.claim.sub";
reset role;

do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'respuestas_rapidas_con_fotos.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'respuestas_rapidas_con_fotos.sql: todas las aserciones pasaron.'
