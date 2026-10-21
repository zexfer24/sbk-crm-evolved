-- ===========================================================================
-- Registro de uso de mensajes rápidos y ranking «Más usados» (T2, plan
-- "Presupuestos y mensajes rápidos", 21/10/2026, migración
-- 20261021020000_mensajes_rapidos_usos.sql).
--
-- Corre como `authenticated` con los claims de agentes reales: como `postgres`
-- se salta la RLS y no mediría nada (ver CLAUDE.md, "Una función security
-- invoker que recorre una tabla con RLS paga la política POR FILA, y medirla
-- como superusuario no mide nada").
--
-- Casos:
--   a. A inserta un uso propio.
--   b. A inserta un uso a nombre de B -> 42501 (RLS).
--   c. Un select directo sobre quick_reply_uses como authenticated ->
--      insufficient_privilege (no 0 filas): la tabla se lee SOLO por la RPC.
--   d. El ranking de A, con p_hasta fijo: ordena por usos, excluye los usos
--      de "hoy" (>= p_hasta) y los de más de 30 días, desempata por label.
--   e. Un mensaje PERSONAL de B con muchos usos no aparece en el ranking de A,
--      pero sí en el de B.
--   f. La caja (no es is_agent) obtiene 0 filas; anon no puede ejecutarla.
--   g. p_limite = 2 devuelve 2 filas.
--   h. Rendimiento: con 20.000 usos, el ranking como authenticated tarda
--      menos de 300 ms.
--   i. Cotas: p_hasta null lanza 22023.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, service_role;

-- A y B asesores, CJ caja.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('b0d9e800-0000-0000-0000-0000000000a1', 'asesor-a-usos@sbk.test', jsonb_build_object('display_name', 'Asesor A usos'), '{}'::jsonb),
  ('b0d9e800-0000-0000-0000-0000000000a2', 'asesor-b-usos@sbk.test', jsonb_build_object('display_name', 'Asesor B usos'), '{}'::jsonb),
  ('b0d9e800-0000-0000-0000-0000000000c1', 'caja-usos@sbk.test',    jsonb_build_object('display_name', 'Caja usos'), '{"role":"caja"}'::jsonb);

-- Mensajes rápidos de prueba (como postgres: son fixtures, no el caso).
--   S1 Saludo-usos (compartido), S2 Beta-empate, S3 Alfa-empate, S4 Viejo-usos
--   (compartido), PA personal de A, PB personal de B.
insert into public.quick_replies (id, label, content, owner_id) values
  ('b0d9e800-1000-0000-0000-000000000001', 'Saludo-usos',  'x', null),
  ('b0d9e800-1000-0000-0000-000000000002', 'Beta-empate',  'x', null),
  ('b0d9e800-1000-0000-0000-000000000003', 'Alfa-empate',  'x', null),
  ('b0d9e800-1000-0000-0000-000000000004', 'Viejo-usos',   'x', null),
  ('b0d9e800-1000-0000-0000-0000000000a1', 'Personal-A',   'x', 'b0d9e800-0000-0000-0000-0000000000a1'),
  ('b0d9e800-1000-0000-0000-0000000000b1', 'Personal-B',   'x', 'b0d9e800-0000-0000-0000-0000000000a2');

-- p_hasta fijo: "la medianoche de hoy" de la prueba.
create temporary table _cfg (hasta timestamptz);
insert into _cfg values ('2026-10-10 04:00:00+00');
grant select on _cfg to authenticated, service_role;

-- Usos sembrados (como postgres, con fecha explícita).
--  S1: 4 dentro, 1 justo en el límite inferior (p_hasta - 30 d, cuenta) = 5;
--      20 desde p_hasta exacto en adelante (NO cuentan: son de "hoy").
--  S2/S3: 3 dentro cada una (empate).
--  S4: 20 a más de 30 días de p_hasta (NO cuentan: demasiado viejos).
--  PA: 1 dentro. PB: 40 dentro (más que nadie).
insert into public.quick_reply_uses (quick_reply_id, agent_id, used_at)
select 'b0d9e800-1000-0000-0000-000000000001', 'b0d9e800-0000-0000-0000-0000000000a1', (select hasta from _cfg) - make_interval(days => 1, mins => g)
  from generate_series(1, 4) g;
insert into public.quick_reply_uses (quick_reply_id, agent_id, used_at)
values ('b0d9e800-1000-0000-0000-000000000001', 'b0d9e800-0000-0000-0000-0000000000a1', (select hasta from _cfg) - make_interval(days => 30));
insert into public.quick_reply_uses (quick_reply_id, agent_id, used_at)
select 'b0d9e800-1000-0000-0000-000000000001', 'b0d9e800-0000-0000-0000-0000000000a1', (select hasta from _cfg) + make_interval(mins => g)
  from generate_series(0, 19) g;
insert into public.quick_reply_uses (quick_reply_id, agent_id, used_at)
select q, 'b0d9e800-0000-0000-0000-0000000000a1', (select hasta from _cfg) - make_interval(days => 2, mins => g)
  from unnest(array['b0d9e800-1000-0000-0000-000000000002', 'b0d9e800-1000-0000-0000-000000000003']::uuid[]) q, generate_series(1, 3) g;
insert into public.quick_reply_uses (quick_reply_id, agent_id, used_at)
select 'b0d9e800-1000-0000-0000-000000000004', 'b0d9e800-0000-0000-0000-0000000000a1', (select hasta from _cfg) - make_interval(days => 30, mins => g)
  from generate_series(1, 20) g;
insert into public.quick_reply_uses (quick_reply_id, agent_id, used_at)
values ('b0d9e800-1000-0000-0000-0000000000a1', 'b0d9e800-0000-0000-0000-0000000000a1', (select hasta from _cfg) - interval '3 days');
insert into public.quick_reply_uses (quick_reply_id, agent_id, used_at)
select 'b0d9e800-1000-0000-0000-0000000000b1', 'b0d9e800-0000-0000-0000-0000000000a2', (select hasta from _cfg) - make_interval(days => 1, mins => g)
  from generate_series(1, 40) g;

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

create or replace function pg_temp.esperar(etiqueta text, r text, patron text) returns void
language plpgsql as $$
begin
  if r !~ patron then
    insert into _errores(msg) values (format('%s: se esperaba /%s/ y salió "%s".', etiqueta, patron, r));
  end if;
end $$;

-- El ranking como texto "label:usos,label:usos" EN EL ORDEN en que lo devuelve
-- la RPC, o "error <sqlstate>: <mensaje>".
create or replace function pg_temp.ranking(p_limite integer default 5) returns text
language plpgsql as $$
declare
  r record;
  salida text := '';
begin
  for r in select * from public.quick_replies_mas_usados((select hasta from _cfg), 30, p_limite) loop
    salida := salida || case when salida = '' then '' else ',' end
      || coalesce((select label from public.quick_replies where id = r.quick_reply_id), r.quick_reply_id::text) || ':' || r.usos;
  end loop;
  return salida;
exception when others then
  return 'error ' || sqlstate || ': ' || sqlerrm;
end $$;

grant execute on function pg_temp.probar(text), pg_temp.esperar(text, text, text), pg_temp.ranking(integer) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Casos a, b, c · el asesor A
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e800-0000-0000-0000-0000000000a1';

select pg_temp.esperar('a: A inserta un uso propio',
  pg_temp.probar($q$insert into public.quick_reply_uses (quick_reply_id) values ('b0d9e800-1000-0000-0000-000000000002')$q$),
  '^filas=1$');
select pg_temp.esperar('b: A inserta un uso a nombre de B',
  pg_temp.probar($q$insert into public.quick_reply_uses (quick_reply_id, agent_id) values ('b0d9e800-1000-0000-0000-000000000002', 'b0d9e800-0000-0000-0000-0000000000a2')$q$),
  '^error 42501');
select pg_temp.esperar('c: select directo sobre quick_reply_uses',
  pg_temp.probar($q$select * from public.quick_reply_uses$q$),
  '^error 42501');

-- El uso de la fila a ("ahora") es posterior al p_hasta fijo de la prueba
-- (2026-10-10 04:00 UTC está en el pasado respecto de now() en cualquier
-- corrida futura), así que no altera el caso d.

-- ---------------------------------------------------------------------------
-- Caso d · el ranking de A
-- ---------------------------------------------------------------------------
select pg_temp.esperar('d: ranking de A (orden, cortes de fecha y desempate por label)',
  pg_temp.ranking(),
  '^Saludo-usos:5,Alfa-empate:3,Beta-empate:3,Personal-A:1$');

-- ---------------------------------------------------------------------------
-- Caso e · el personal de B no aparece en el ranking de A
-- ---------------------------------------------------------------------------
select pg_temp.esperar('e: el personal de B no sale en el ranking de A',
  (select case when pg_temp.ranking(20) like '%b0d9e800-1000-0000-0000-0000000000b1%' or pg_temp.ranking(20) like '%Personal-B%' then 'filtrado=no' else 'filtrado=si' end),
  '^filtrado=si$');

-- ---------------------------------------------------------------------------
-- Caso g · p_limite
-- ---------------------------------------------------------------------------
select pg_temp.esperar('g: p_limite = 2 devuelve 2 filas',
  (select 'n=' || count(*) from public.quick_replies_mas_usados((select hasta from _cfg), 30, 2)),
  '^n=2$');

-- ---------------------------------------------------------------------------
-- Caso i · p_hasta null lanza 22023
-- ---------------------------------------------------------------------------
select pg_temp.esperar('i: p_hasta null',
  pg_temp.probar($q$select * from public.quick_replies_mas_usados(null)$q$),
  '^error 22023');

-- ---------------------------------------------------------------------------
-- Caso e (parte B) · B sí ve el suyo, de primero
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'b0d9e800-0000-0000-0000-0000000000a2';

select pg_temp.esperar('e: el personal de B sale en el ranking de B',
  pg_temp.ranking(),
  '^Personal-B:40,Saludo-usos:5,');
select pg_temp.esperar('e: B no ve el personal de A',
  (select case when pg_temp.ranking(20) like '%Personal-A%' then 'filtrado=no' else 'filtrado=si' end),
  '^filtrado=si$');

-- ---------------------------------------------------------------------------
-- Caso f · la caja no es is_agent: 0 filas (puede ejecutarla, no ve nada)
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'b0d9e800-0000-0000-0000-0000000000c1';

select pg_temp.esperar('f: la caja obtiene 0 filas',
  (select 'n=' || count(*) from public.quick_replies_mas_usados((select hasta from _cfg))),
  '^n=0$');
select pg_temp.esperar('f: la caja no registra usos',
  pg_temp.probar($q$insert into public.quick_reply_uses (quick_reply_id) values ('b0d9e800-1000-0000-0000-000000000001')$q$),
  '^error 42501');

-- anon no puede ejecutar la RPC.
reset "request.jwt.claim.sub";
set local role anon;
select pg_temp.esperar('f: anon no puede ejecutar la RPC',
  pg_temp.ranking(),
  '^error 42501');
reset role;

-- ---------------------------------------------------------------------------
-- Caso h · rendimiento con 20.000 usos, medido como authenticated
-- ---------------------------------------------------------------------------
-- 50 mensajes compartidos más y 20.000 usos repartidos en los últimos 30 días.
insert into public.quick_replies (id, label, content)
select ('b0d9e800-2000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'Carga-' || g, 'x'
  from generate_series(1, 50) g;
insert into public.quick_reply_uses (quick_reply_id, agent_id, used_at)
select ('b0d9e800-2000-0000-0000-' || lpad((1 + (g % 50))::text, 12, '0'))::uuid,
       'b0d9e800-0000-0000-0000-0000000000a1',
       (select hasta from _cfg) - make_interval(secs => (g * 129) % (30 * 86400))
  from generate_series(1, 20000) g;
analyze public.quick_reply_uses;

set local role authenticated;
set local "request.jwt.claim.sub" = 'b0d9e800-0000-0000-0000-0000000000a1';

do $$
declare
  t0 timestamptz;
  ms numeric;
  n integer;
begin
  t0 := clock_timestamp();
  select count(*) into n from public.quick_replies_mas_usados((select hasta from _cfg), 30, 5);
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  raise notice 'h: ranking con 20.000+ usos como authenticated: % ms (% filas)', round(ms, 1), n;
  if n <> 5 then
    insert into _errores(msg) values (format('h: se esperaban 5 filas y salieron %s.', n));
  end if;
  if ms >= 300 then
    insert into _errores(msg) values (format('h: el ranking tardó %s ms; el tope es 300 ms.', round(ms, 1)));
  end if;
end $$;

reset "request.jwt.claim.sub";
reset role;

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
    raise exception E'mensajes_rapidos_usos.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'mensajes_rapidos_usos.sql: todas las aserciones pasaron.'
