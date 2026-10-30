-- ===========================================================================
-- Precio divisa desde SAINT (30/10/2026, migración
-- 20261030010000_precio_divisa_saint.sql).
--
-- Fija: (1) que `precio_divisa_usd(products)` devuelva `round(precio1, 2)` de
-- la réplica de SAINT (`saprod`), incluidos 0 y negativos (la interfaz decide
-- que <= 0 es "sin precio", la función no lo oculta); (2) que devuelva null
-- sin tabla, sin columna, sin fila, sin `saint_code` o cuando quien llama con
-- rol `authenticated` no tiene fila en `agents` (la caja SÍ ve el precio
-- divisa: es `can_read_inventory()`, no `is_agent()`); (3) que `saint.saprod`
-- gane a `public.saprod`, la misma prioridad que `saint.sync_products()`;
-- (4) que `anon` no pueda ejecutarla; (5) que re-ejecutar la migración sea
-- idempotente y le cierre `saprod` a `anon`/`authenticated`.
--
-- NECESITA UNA BASE SIN `saprod` (local y CI no la tienen: la crea y administra
-- el agente externo LiminalReplicant). Si existe, el test aborta en vez de
-- tocarla. Como hace `\i` de la migración, la ruta tiene que resolverse DENTRO
-- del contenedor (ver CLAUDE.md, trampa del `\i`):
--   tar -cf - supabase | docker exec -i <contenedor> sh -c "mkdir -p /tmp/repo && cd /tmp/repo && tar -xf -"
--   MSYS_NO_PATHCONV=1 docker exec -w /tmp/repo <contenedor> psql -U postgres -d postgres -1 -v ON_ERROR_STOP=1 -f supabase/tests/precio_divisa_usd.sql
--
-- Corre como `authenticated` con claims de usuarios reales -- como `postgres`
-- se salta la RLS y no mediría nada. Formato: transacción con rollback, tabla
-- temporal `_errores`, un solo `raise exception` al final.
-- ===========================================================================

begin;

do $$
begin
  if to_regclass('saint.saprod') is not null or to_regclass('public.saprod') is not null then
    raise exception 'precio_divisa_usd.sql necesita una base SIN saint.saprod ni public.saprod (la réplica de SAINT existe aquí: no se toca). Córrelo contra la base local o la del CI.';
  end if;
end $$;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

-- AG (asesor), CJ (caja) y NA (autenticado SIN fila en agents).
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('d9d9d9d9-0000-0000-0000-0000000000a1', 'agente-divisa@sbk.test', jsonb_build_object('display_name', 'Agente divisa'), '{}'::jsonb),
  ('d9d9d9d9-0000-0000-0000-0000000000c1', 'caja-divisa@sbk.test',   jsonb_build_object('display_name', 'Caja divisa'),   '{"role":"caja"}'::jsonb),
  ('d9d9d9d9-0000-0000-0000-0000000000a5', 'sin-fila-divisa@sbk.test', jsonb_build_object('display_name', 'Sin fila'),     '{}'::jsonb);
delete from public.agents where id = 'd9d9d9d9-0000-0000-0000-0000000000a5';

-- `products` es de solo lectura para la app: se inserta como postgres.
insert into public.products (id, name, price, currency, saint_code) values
  ('d9d9d9d9-1000-0000-0000-000000000001', 'Producto divisa con saprod',      100, 'VES', 'A2TEST-1'),
  ('d9d9d9d9-1000-0000-0000-000000000002', 'Producto divisa sin fila saprod', 100, 'VES', 'A2TEST-SIN-FILA'),
  ('d9d9d9d9-1000-0000-0000-000000000003', 'Producto divisa sin saint_code',  100, 'VES', null);

-- Valor de la función para un código. Pasa por jsonb_populate_record porque un
-- autenticado sin fila en agents no ve la fila de `products` (RLS): lo que se
-- prueba es la función, no la lectura de la tabla.
create or replace function pg_temp.divisa(p_saint_code text) returns text
language plpgsql as $$
declare
  v numeric;
begin
  v := public.precio_divisa_usd(jsonb_populate_record(null::public.products, jsonb_build_object('saint_code', p_saint_code)));
  return coalesce(v::text, 'null');
exception when others then
  return 'error ' || sqlstate || ': ' || sqlerrm;
end $$;

create or replace function pg_temp.esperar(etiqueta text, obtenido text, esperado text) returns void
language plpgsql as $$
begin
  if obtenido is distinct from esperado then
    insert into _errores(msg) values (format('%s: se obtuvo "%s", se esperaba "%s".', etiqueta, obtenido, esperado));
  end if;
end $$;

-- 1. Sin tabla saprod -> null.
select pg_temp.esperar('1 sin tabla saprod', pg_temp.divisa('A2TEST-1'), 'null');

-- 2. Tabla sin columna precio1 -> null.
create table public.saprod (codprod text primary key, descrip text);
insert into public.saprod (codprod, descrip) values ('A2TEST-1', 'Producto de prueba');
select pg_temp.esperar('2 saprod sin precio1', pg_temp.divisa('A2TEST-1'), 'null');

-- 3. Con precio1 -> round(,2), como postgres y como service_role.
alter table public.saprod add column precio1 numeric(28, 4);
update public.saprod set precio1 = 12.3456 where codprod = 'A2TEST-1';
select pg_temp.esperar('3 postgres', pg_temp.divisa('A2TEST-1'), '12.35');
-- Además, vista sobre la fila real de products (como lo pide PostgREST).
select pg_temp.esperar('3 fila real de products',
  (select coalesce(public.precio_divisa_usd(p)::text, 'null') from public.products p where p.id = 'd9d9d9d9-1000-0000-0000-000000000001'),
  '12.35');

set local role service_role;
select pg_temp.esperar('3 service_role', pg_temp.divisa('A2TEST-1'), '12.35');
reset role;

-- 4. precio1 null -> null; precio1 = 0 -> 0 (la función no lo oculta);
--    negativo -> tal cual.
update public.saprod set precio1 = null where codprod = 'A2TEST-1';
select pg_temp.esperar('4 precio1 null', pg_temp.divisa('A2TEST-1'), 'null');
update public.saprod set precio1 = 0 where codprod = 'A2TEST-1';
select pg_temp.esperar('4 precio1 = 0', pg_temp.divisa('A2TEST-1'), '0.00');
update public.saprod set precio1 = -1.5 where codprod = 'A2TEST-1';
select pg_temp.esperar('4 precio1 negativo', pg_temp.divisa('A2TEST-1'), '-1.50');
update public.saprod set precio1 = 12.3456 where codprod = 'A2TEST-1';

-- 5. Sin fila en saprod -> null; sin saint_code -> null.
select pg_temp.esperar('5 sin fila en saprod', pg_temp.divisa('A2TEST-SIN-FILA'), 'null');
select pg_temp.esperar('5 sin saint_code', pg_temp.divisa(null), 'null');
select pg_temp.esperar('5 fila real sin saint_code',
  (select coalesce(public.precio_divisa_usd(p)::text, 'null') from public.products p where p.id = 'd9d9d9d9-1000-0000-0000-000000000003'),
  'null');

-- 6. Como authenticated: agente y caja ven el valor; quien no tiene fila en
--    agents, null. La función es definer: no hace falta SELECT sobre saprod.
set local role authenticated;
set local "request.jwt.claim.sub" = 'd9d9d9d9-0000-0000-0000-0000000000a1';
select pg_temp.esperar('6 asesor', pg_temp.divisa('A2TEST-1'), '12.35');
set local "request.jwt.claim.sub" = 'd9d9d9d9-0000-0000-0000-0000000000c1';
select pg_temp.esperar('6 caja', pg_temp.divisa('A2TEST-1'), '12.35');
set local "request.jwt.claim.sub" = 'd9d9d9d9-0000-0000-0000-0000000000a5';
select pg_temp.esperar('6 autenticado sin fila en agents', pg_temp.divisa('A2TEST-1'), 'null');
reset role;
reset "request.jwt.claim.sub";

-- 7. anon no puede ejecutarla; authenticated y service_role sí.
select pg_temp.esperar('7 anon', has_function_privilege('anon', 'public.precio_divisa_usd(public.products)', 'EXECUTE')::text, 'false');
select pg_temp.esperar('7 authenticated', has_function_privilege('authenticated', 'public.precio_divisa_usd(public.products)', 'EXECUTE')::text, 'true');
select pg_temp.esperar('7 service_role', has_function_privilege('service_role', 'public.precio_divisa_usd(public.products)', 'EXECUTE')::text, 'true');

-- 8. saint.saprod gana a public.saprod (misma prioridad que sync_products).
create table saint.saprod (codprod text primary key, precio1 numeric(28, 4));
insert into saint.saprod values ('A2TEST-1', 99.999);
select pg_temp.esperar('8 saint.saprod gana', pg_temp.divisa('A2TEST-1'), '100.00');
drop table saint.saprod;
select pg_temp.esperar('8 vuelve a public.saprod', pg_temp.divisa('A2TEST-1'), '12.35');

-- 9. La migración cierra saprod y es idempotente.
grant select, insert on public.saprod to anon, authenticated;
select pg_temp.esperar('9 antes: anon tiene select', has_table_privilege('anon', 'public.saprod', 'SELECT')::text, 'true');
\i supabase/migrations/20261030010000_precio_divisa_saint.sql
select pg_temp.esperar('9 anon sin select', has_table_privilege('anon', 'public.saprod', 'SELECT')::text, 'false');
select pg_temp.esperar('9 anon sin insert', has_table_privilege('anon', 'public.saprod', 'INSERT')::text, 'false');
select pg_temp.esperar('9 authenticated sin select', has_table_privilege('authenticated', 'public.saprod', 'SELECT')::text, 'false');
select pg_temp.esperar('9 authenticated sin insert', has_table_privilege('authenticated', 'public.saprod', 'INSERT')::text, 'false');
-- Segunda ejecución: idempotente (ON_ERROR_STOP aborta si falla).
\i supabase/migrations/20261030010000_precio_divisa_saint.sql
select pg_temp.esperar('9 tras 2ª ejecución', pg_temp.divisa('A2TEST-1'), '12.35');

do $$
declare
  n integer;
  detalle text;
begin
  select count(*), string_agg(msg, E'\n  - ') into n, detalle from _errores;
  if n > 0 then
    raise exception E'precio_divisa_usd.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'precio_divisa_usd.sql: todas las aserciones pasaron.'
