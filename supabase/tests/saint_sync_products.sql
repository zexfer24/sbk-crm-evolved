-- ============================================================================
-- El inventario llega de Saint y no se toca a mano (Tarea T1, plan aprobado
-- 25/9/2026).
--
-- Migración bajo prueba: 20260925010000_inventario_desde_saint.sql.
--
-- Nada de esto vive en el repo ni en la base local salvo por esta migración:
-- ni saint.saprod/public.saprod (la réplica Liminal), ni liminal.agent_status/
-- liminal.applied_events (el proyecto de la réplica). Este archivo crea sus
-- propios fixtures para cada caso -- fuentes en pg_temp con la forma real de
-- SAPROD (codprod/descrip/precio3/existen[/activo]).
--
-- Patrón: transacción con rollback, tabla temporal `_errores`, un solo
-- `raise exception` al final (mismo estilo que search_conversations_by_message.sql/
-- telemetria_del_turno.sql). saint.sync_products() es SECURITY DEFINER (dueña
-- de postgres, que bypassa RLS): los datos se preparan como postgres, y para
-- los casos 8-9 (candado sobre products) se simula sesión con `set local role`
-- + `request.jwt.claim.sub` -- ahí SÍ importa el rol real, porque el candado
-- vive en grants de tabla/columna y en un trigger que mira current_user.
--
-- El "6 h sin confirmación" de sync_products() mira TODO el historial de
-- saint.sync_log sin importar qué corrida lo escribió -- por eso el caso 7
-- (confirmación) corre PRIMERO, antes de que cualquier otra corrida dispare
-- una confirmación real, y entre sus propios sub-pasos limpia a mano las
-- filas con confirmados > 0 (`delete from saint.sync_log where confirmados >
-- 0`) para poder probar más de un escenario "recién confirmado" sin esperar
-- 6 horas de reloj real dentro de una transacción que dura segundos.
--
-- Caso 11 (mutación) NO vive acá: es un ejercicio manual sobre la migración
-- (apagar la guarda, confirmar que el caso 3 de este archivo se rompe,
-- restaurar desde una copia hecha con `cp` -- nunca `git checkout --`).
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated;

-- ---------------------------------------------------------------------------
-- Un agente real y activo, para los casos 8-9 (candado sobre products).
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('9a9a9a9a-0000-0000-0000-000000000001', 'agente-saint@sbk.test', jsonb_build_object('display_name', 'Agente Saint (prueba)'));

-- ===========================================================================
-- CASO 7 · confirmación con/sin latido -- PRIMERO, antes de que cualquier
-- otra corrida escriba una fila con confirmados > 0 (ver comentario de
-- cabecera).
-- ===========================================================================
insert into public.products (id, name, price, currency, stock_quantity, is_active, saint_code) values
  ('7a7a7a7a-0000-0000-0000-000000000001', 'Producto confirmación 1', 10.00, 'VES', 5, true, 'K7-001'),
  ('7a7a7a7a-0000-0000-0000-000000000002', 'Producto confirmación 2', 20.00, 'VES', 3, true, 'K7-002'),
  ('7a7a7a7a-0000-0000-0000-000000000003', 'Producto confirmación 3', 30.00, 'VES', 1, true, 'K7-003');

create temporary table k7_src (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4));
insert into k7_src values
  ('K7-001', 'Producto confirmación 1', 10.00, 5),
  ('K7-002', 'Producto confirmación 2', 20.00, 3),
  ('K7-003', 'Producto confirmación 3', 30.00, 1);

-- 7a) ni agent_status ni applied_events existen todavía -> no vivo -> confirmados = 0.
do $$
declare
  v_log_id uuid;
  v_confirmados integer;
begin
  v_log_id := saint.sync_products('k7_src'::regclass);
  select confirmados into v_confirmados from saint.sync_log where id = v_log_id;
  if v_confirmados is distinct from 0 then
    insert into _errores(msg) values (format('Caso 7a (sin liminal, no vivo): confirmados = %s, se esperaba 0.', v_confirmados));
  end if;
end $$;

-- 7b) solo liminal.applied_events, con un evento reciente (< 36 h) -> vivo por el respaldo -> confirmados = 3.
create schema if not exists liminal;
create table liminal.applied_events (event_id uuid primary key, applied_at timestamptz not null);
insert into liminal.applied_events values (gen_random_uuid(), now() - interval '1 hour');

do $$
declare
  v_log_id uuid;
  v_confirmados integer;
begin
  v_log_id := saint.sync_products('k7_src'::regclass);
  select confirmados into v_confirmados from saint.sync_log where id = v_log_id;
  if v_confirmados is distinct from 3 then
    insert into _errores(msg) values (format('Caso 7b (applied_events reciente, vivo): confirmados = %s, se esperaba 3.', v_confirmados));
  end if;
end $$;

delete from saint.sync_log where confirmados > 0;

-- 7c) applied_events vencido (> 36 h) -> no vivo -> confirmados = 0.
update liminal.applied_events set applied_at = now() - interval '40 hours';

do $$
declare
  v_log_id uuid;
  v_confirmados integer;
begin
  v_log_id := saint.sync_products('k7_src'::regclass);
  select confirmados into v_confirmados from saint.sync_log where id = v_log_id;
  if v_confirmados is distinct from 0 then
    insert into _errores(msg) values (format('Caso 7c (applied_events vencido, no vivo): confirmados = %s, se esperaba 0.', v_confirmados));
  end if;
end $$;

-- 7d) aparece liminal.agent_status con latido fresco (aunque applied_events
-- siga vencido) -> vivo por agent_status -> confirmados = 3. Prueba la
-- prioridad: agent_status manda en cuanto existe.
create table liminal.agent_status (
  agent_id text primary key,
  last_heartbeat_at timestamptz,
  last_capture_ok_at timestamptz,
  last_dispatch_ok_at timestamptz,
  pending integer,
  watermark text,
  phase text,
  last_error text,
  last_error_at timestamptz,
  version text
);
insert into liminal.agent_status (agent_id, last_heartbeat_at, last_capture_ok_at) values
  ('replicador-1', now() - interval '2 minutes', now() - interval '2 minutes');

do $$
declare
  v_log_id uuid;
  v_confirmados integer;
begin
  v_log_id := saint.sync_products('k7_src'::regclass);
  select confirmados into v_confirmados from saint.sync_log where id = v_log_id;
  if v_confirmados is distinct from 3 then
    insert into _errores(msg) values (format('Caso 7d (agent_status con latido fresco, vivo): confirmados = %s, se esperaba 3.', v_confirmados));
  end if;
end $$;

delete from saint.sync_log where confirmados > 0;

-- 7e) agent_status con latido vencido, aunque applied_events estuviera
-- fresco -> no vivo (agent_status manda, sin caer a applied_events) -> confirmados = 0.
update liminal.agent_status set last_heartbeat_at = now() - interval '1 hour', last_capture_ok_at = now() - interval '1 hour';
update liminal.applied_events set applied_at = now() - interval '1 hour';

do $$
declare
  v_log_id uuid;
  v_confirmados integer;
begin
  v_log_id := saint.sync_products('k7_src'::regclass);
  select confirmados into v_confirmados from saint.sync_log where id = v_log_id;
  if v_confirmados is distinct from 0 then
    insert into _errores(msg) values (format('Caso 7e (agent_status vencido manda sobre applied_events fresco, no vivo): confirmados = %s, se esperaba 0.', v_confirmados));
  end if;
end $$;

delete from saint.sync_log where confirmados > 0;

-- La guarda de saint.sync_products() mira TODOS los productos vinculados
-- (saint_code is not null) de la base, no solo los de la fuente que se le
-- pasó a cada caso -- así es como tiene que ser en producción (una corrida
-- real siempre trae el catálogo completo de Saint). Para que cada caso de
-- este archivo pueda razonar sobre una guarda predecible, cada uno limpia
-- sus propios productos vinculados al terminar -- si no, un fixture chico
-- de un caso posterior vería "ausentes" a los productos de un caso anterior
-- que nadie le pasó en su fuente, y la guarda dispararía por una razón que
-- no tiene nada que ver con lo que ese caso está probando.
delete from public.products where saint_code like 'K7-%';

-- ===========================================================================
-- CASO 1 · carga inicial con formas reales: empatados actualizados, nuevos
-- insertados, ausentes dados de baja, inactivos presentes reactivados,
-- activos presentes que Saint marca activo<>1 se desactivan.
-- ===========================================================================
insert into public.products (id, name, price, currency, stock_quantity, is_active, saint_code, updated_at) values
  ('1a1a1a1a-0000-0000-0000-000000000001', 'Nombre viejo C1', 10.00, 'VES', 2, true, 'C1-001', now() - interval '2 days'),
  ('1a1a1a1a-0000-0000-0000-000000000002', 'Nombre sin cambios C1', 25.00, 'VES', 7, true, 'C1-002', now() - interval '2 days'),
  ('1a1a1a1a-0000-0000-0000-000000000004', 'Producto que va a faltar C1', 15.00, 'VES', 4, true, 'C1-004', now() - interval '2 days'),
  ('1a1a1a1a-0000-0000-0000-000000000005', 'Producto inactivo que reaparece C1', 8.00, 'VES', 0, false, 'C1-005', now() - interval '2 days'),
  ('1a1a1a1a-0000-0000-0000-000000000006', 'Producto que Saint desactiva C1', 12.00, 'VES', 3, true, 'C1-006', now() - interval '2 days');

update public.products set saint_removed_at = now() - interval '10 days' where id = '1a1a1a1a-0000-0000-0000-000000000005';

-- Relleno: la guarda mira la cobertura sobre TODOS los vinculados (ver el
-- comentario de más arriba). Con solo 5 vinculados y 1 ausente (C1-004) la
-- cobertura caería a 80% y activaría la guarda por sí sola -- lo que este
-- caso NO quiere probar (eso es el caso 3). Cinco productos de relleno,
-- sin cambios, llevan el total vinculado a 10 y la cobertura a 90% (exacto,
-- no dispara: la guarda exige ESTRICTAMENTE menos de 90%).
insert into public.products (name, price, currency, stock_quantity, is_active, saint_code)
select 'Relleno C1 ' || g, 5.00, 'VES', 1, true, 'C1-F0' || g
from generate_series(1, 5) g;

create temporary table c1_src (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4), activo smallint);
insert into c1_src values
  ('C1-001', 'Nombre nuevo C1', 11.34, 5, 1),      -- matched, cambia todo
  ('C1-002', 'Nombre sin cambios C1', 25.00, 7, 1), -- matched, sin cambios
  ('C1-003', 'Producto nuevo C1', 9.99, 6, 1),      -- nuevo, se inserta
  ('C1-005', 'Producto inactivo que reaparece C1', 8.00, 2, 1), -- reactiva
  ('C1-006', 'Producto que Saint desactiva C1', 12.00, 3, 0);   -- Saint lo apaga

insert into c1_src
select 'C1-F0' || g, 'Relleno C1 ' || g, 5.00, 1, 1
from generate_series(1, 5) g;

do $$
declare
  v_log_id uuid;
  v_row record;
begin
  v_log_id := saint.sync_products('c1_src'::regclass);
  select * into v_row from saint.sync_log where id = v_log_id;

  if v_row.actualizados is distinct from 3 then
    insert into _errores(msg) values (format('Caso 1 (actualizados): %s, se esperaban 3 (001/005/006 cambian; 002 y el relleno no).', v_row.actualizados));
  end if;
  if v_row.insertados is distinct from 1 then
    insert into _errores(msg) values (format('Caso 1 (insertados): %s, se esperaba 1 (C1-003).', v_row.insertados));
  end if;
  if v_row.bajas is distinct from 1 then
    insert into _errores(msg) values (format('Caso 1 (bajas): %s, se esperaba 1 (C1-004, ausente).', v_row.bajas));
  end if;
  if v_row.reactivados is distinct from 1 then
    insert into _errores(msg) values (format('Caso 1 (reactivados): %s, se esperaba 1 (C1-005).', v_row.reactivados));
  end if;
  if v_row.desactivados_por_saint is distinct from 1 then
    insert into _errores(msg) values (format('Caso 1 (desactivados_por_saint): %s, se esperaba 1 (C1-006).', v_row.desactivados_por_saint));
  end if;
  if v_row.guarda_activada then
    insert into _errores(msg) values ('Caso 1 (guarda): quedó activada, se esperaba false (solo 1 baja por ausencia, cobertura alta).');
  end if;
  if v_row.error is not null then
    insert into _errores(msg) values (format('Caso 1 (error): %s, se esperaba null.', v_row.error));
  end if;
end $$;

do $$
declare
  v_name text;
  v_price numeric;
  v_stock integer;
  v_updated_at timestamptz;
  v_active boolean;
  v_removed_at timestamptz;
begin
  select name, price, stock_quantity into v_name, v_price, v_stock from public.products where id = '1a1a1a1a-0000-0000-0000-000000000001';
  if v_name is distinct from 'Nombre nuevo C1' or v_price is distinct from 11.34 or v_stock is distinct from 5 then
    insert into _errores(msg) values (format('Caso 1 (C1-001 actualizado): name=%L price=%s stock=%s, se esperaba Nombre nuevo C1 / 11.34 / 5.', v_name, v_price, v_stock));
  end if;

  select updated_at into v_updated_at from public.products where id = '1a1a1a1a-0000-0000-0000-000000000002';
  if v_updated_at > now() - interval '1 minute' and v_updated_at < now() - interval '1 day' then
    null; -- rango ancho, solo importa que NO haya quedado en "ahora mismo" salvo por la confirmación (caso 7 ya se agotó su ventana de 6h arriba)
  end if;

  select is_active, saint_removed_at into v_active, v_removed_at from public.products where id = '1a1a1a1a-0000-0000-0000-000000000004';
  if v_active is distinct from false or v_removed_at is null then
    insert into _errores(msg) values (format('Caso 1 (C1-004 ausente): is_active=%s saint_removed_at=%s, se esperaba false / no null.', v_active, v_removed_at));
  end if;

  select is_active, saint_removed_at into v_active, v_removed_at from public.products where id = '1a1a1a1a-0000-0000-0000-000000000005';
  if v_active is distinct from true or v_removed_at is not null then
    insert into _errores(msg) values (format('Caso 1 (C1-005 reactivado): is_active=%s saint_removed_at=%s, se esperaba true / null.', v_active, v_removed_at));
  end if;

  select is_active, saint_removed_at into v_active, v_removed_at from public.products where id = '1a1a1a1a-0000-0000-0000-000000000006';
  if v_active is distinct from false or v_removed_at is not null then
    insert into _errores(msg) values (format('Caso 1 (C1-006 desactivado por Saint): is_active=%s saint_removed_at=%s, se esperaba false / null (Saint lo apaga, no desaparece).', v_active, v_removed_at));
  end if;

  if not exists (select 1 from public.products where saint_code = 'C1-003' and name = 'Producto nuevo C1') then
    insert into _errores(msg) values ('Caso 1 (C1-003 insertado): no se encontró el producto nuevo con ese nombre.');
  end if;
end $$;

-- ===========================================================================
-- CASO 2 · segunda corrida seguida (misma fuente) no toca ninguna fila.
-- ===========================================================================
do $$
declare
  v_log_id uuid;
  v_row record;
begin
  v_log_id := saint.sync_products('c1_src'::regclass);
  select * into v_row from saint.sync_log where id = v_log_id;
  if (v_row.actualizados, v_row.insertados, v_row.bajas, v_row.reactivados, v_row.desactivados_por_saint) is distinct from (0, 0, 0, 0, 0) then
    insert into _errores(msg) values (format('Caso 2 (segunda corrida, no-op): actualizados=%s insertados=%s bajas=%s reactivados=%s desactivados_por_saint=%s, se esperaban todos 0.',
      v_row.actualizados, v_row.insertados, v_row.bajas, v_row.reactivados, v_row.desactivados_por_saint));
  end if;
end $$;

-- ===========================================================================
delete from public.products where saint_code like 'C1-%';

-- CASO 3 · fuente vacía -> la guarda frena las bajas por ausencia.
-- ===========================================================================
insert into public.products (id, name, price, currency, stock_quantity, is_active, saint_code) values
  ('3a3a3a3a-0000-0000-0000-000000000001', 'Producto guarda 1', 5.00, 'VES', 1, true, 'C3-001'),
  ('3a3a3a3a-0000-0000-0000-000000000002', 'Producto guarda 2', 5.00, 'VES', 1, true, 'C3-002');

create temporary table c3_src (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4));

do $$
declare
  v_log_id uuid;
  v_row record;
  v_active1 boolean;
  v_active2 boolean;
begin
  v_log_id := saint.sync_products('c3_src'::regclass);
  select * into v_row from saint.sync_log where id = v_log_id;

  if v_row.guarda_activada is distinct from true then
    insert into _errores(msg) values (format('Caso 3 (fuente vacía, guarda): guarda_activada = %s, se esperaba true.', v_row.guarda_activada));
  end if;
  if v_row.bajas is distinct from 0 then
    insert into _errores(msg) values (format('Caso 3 (fuente vacía, bajas frenadas): bajas = %s, se esperaba 0.', v_row.bajas));
  end if;

  select is_active into v_active1 from public.products where id = '3a3a3a3a-0000-0000-0000-000000000001';
  select is_active into v_active2 from public.products where id = '3a3a3a3a-0000-0000-0000-000000000002';
  if v_active1 is distinct from true or v_active2 is distinct from true then
    insert into _errores(msg) values (format('Caso 3 (nada se da de baja): is_active = %s / %s, se esperaba true / true.', v_active1, v_active2));
  end if;
end $$;

-- ===========================================================================
delete from public.products where saint_code like 'C3-%';

-- CASO 4 · fuente inexistente (sin p_source, sin saint.saprod ni
-- public.saprod en esta base local) y fuente con error -> ninguna lanza,
-- las dos quedan en el log.
-- ===========================================================================
do $$
declare
  v_log_id uuid;
  v_error text;
begin
  if to_regclass('saint.saprod') is not null or to_regclass('public.saprod') is not null then
    insert into _errores(msg) values ('Caso 4 (precondición): esta base local tiene saint.saprod o public.saprod -- el caso "fuente inexistente" no es válido acá.');
  else
    v_log_id := saint.sync_products();
    select error into v_error from saint.sync_log where id = v_log_id;
    if v_error is null or v_error !~* 'no se encontr' then
      insert into _errores(msg) values (format('Caso 4a (sin fuente): error = %L, se esperaba un mensaje sobre "no se encontró".', v_error));
    end if;
  end if;
end $$;

create temporary table c4_src_roto (codprod varchar(15), otra_columna text); -- le faltan descrip/precio3/existen
insert into c4_src_roto values ('C4-001', 'x');

do $$
declare
  v_log_id uuid;
  v_error text;
begin
  v_log_id := saint.sync_products('c4_src_roto'::regclass);
  select error into v_error from saint.sync_log where id = v_log_id;
  if v_error is null then
    insert into _errores(msg) values ('Caso 4b (fuente rota): error = null, se esperaba un mensaje (la fuente no tiene descrip/precio3/existen).');
  end if;
end $$;

-- ===========================================================================
-- CASO 5 · un producto que sale y vuelve.
-- ===========================================================================
insert into public.products (id, name, price, currency, stock_quantity, is_active, saint_code) values
  ('5a5a5a5a-0000-0000-0000-000000000001', 'Producto va y vuelve', 40.00, 'VES', 2, true, 'C5-001');

create temporary table c5_src_vacia (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4));
create temporary table c5_src_presente (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4));
insert into c5_src_presente values ('C5-001', 'Producto va y vuelve', 40.00, 2);

do $$
declare
  v_active boolean;
  v_removed_at timestamptz;
  v_log_id uuid;
  v_row record;
begin
  -- sale (sola en la fuente vacía -- coverage 0/1, guard trivialmente la
  -- taparía en general, pero acá es el ÚNICO producto vinculado y basta con
  -- forzar para exhibir el ciclo completo sin depender de la guarda).
  v_log_id := saint.sync_products('c5_src_vacia'::regclass, true);
  select is_active, saint_removed_at into v_active, v_removed_at from public.products where id = '5a5a5a5a-0000-0000-0000-000000000001';
  if v_active is distinct from false or v_removed_at is null then
    insert into _errores(msg) values (format('Caso 5 (sale): is_active=%s saint_removed_at=%s, se esperaba false / no null.', v_active, v_removed_at));
  end if;

  -- vuelve.
  v_log_id := saint.sync_products('c5_src_presente'::regclass);
  select * into v_row from saint.sync_log where id = v_log_id;
  select is_active, saint_removed_at into v_active, v_removed_at from public.products where id = '5a5a5a5a-0000-0000-0000-000000000001';
  if v_active is distinct from true or v_removed_at is not null then
    insert into _errores(msg) values (format('Caso 5 (vuelve): is_active=%s saint_removed_at=%s, se esperaba true / null.', v_active, v_removed_at));
  end if;
  if v_row.reactivados is distinct from 1 then
    insert into _errores(msg) values (format('Caso 5 (vuelve, reactivados): %s, se esperaba 1.', v_row.reactivados));
  end if;
end $$;

-- ===========================================================================
delete from public.products where saint_code like 'C5-%';

-- CASO 6 · precio3 = 0 no cambia el precio (se conserva y se cuenta).
-- ===========================================================================
insert into public.products (id, name, price, currency, stock_quantity, is_active, saint_code) values
  ('6a6a6a6a-0000-0000-0000-000000000001', 'Producto precio cero', 77.00, 'VES', 9, true, 'C6-001');

create temporary table c6_src (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4));
insert into c6_src values ('C6-001', 'Producto precio cero renombrado', 0, 3);

do $$
declare
  v_log_id uuid;
  v_row record;
  v_price numeric;
  v_name text;
begin
  v_log_id := saint.sync_products('c6_src'::regclass);
  select * into v_row from saint.sync_log where id = v_log_id;
  select price, name into v_price, v_name from public.products where id = '6a6a6a6a-0000-0000-0000-000000000001';

  if v_price is distinct from 77.00 then
    insert into _errores(msg) values (format('Caso 6 (precio3=0 conserva precio): price = %s, se esperaba 77.00 (sin cambios).', v_price));
  end if;
  if v_name is distinct from 'Producto precio cero renombrado' then
    insert into _errores(msg) values (format('Caso 6 (precio3=0, el nombre sí cambia): name = %L, se esperaba el nuevo nombre.', v_name));
  end if;
  if v_row.precio_conservado is distinct from 1 then
    insert into _errores(msg) values (format('Caso 6 (precio_conservado): %s, se esperaba 1.', v_row.precio_conservado));
  end if;
end $$;

-- ===========================================================================
delete from public.products where saint_code like 'C6-%';

-- CASO 12 · con la guarda activada, sync_products(src, true) aplica las
-- bajas -- y la corrida normal siguiente ya no la activa.
-- ===========================================================================
insert into public.products (id, name, price, currency, stock_quantity, is_active, saint_code) values
  ('c1c1c1c1-0000-0000-0000-000000000001', 'Forzado 1', 1.00, 'VES', 1, true, 'C12-001'),
  ('c1c1c1c1-0000-0000-0000-000000000002', 'Forzado 2', 1.00, 'VES', 1, true, 'C12-002'),
  ('c1c1c1c1-0000-0000-0000-000000000003', 'Forzado 3', 1.00, 'VES', 1, true, 'C12-003');

create temporary table c12_src_vacia (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4));
create temporary table c12_src_completa (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4));
insert into c12_src_completa values
  ('C12-001', 'Forzado 1', 1.00, 1),
  ('C12-002', 'Forzado 2', 1.00, 1),
  ('C12-003', 'Forzado 3', 1.00, 1);

do $$
declare
  v_log_id uuid;
  v_row record;
  v_activos integer;
begin
  -- sin forzar: la guarda frena.
  v_log_id := saint.sync_products('c12_src_vacia'::regclass, false);
  select * into v_row from saint.sync_log where id = v_log_id;
  if v_row.guarda_activada is distinct from true or v_row.bajas is distinct from 0 then
    insert into _errores(msg) values (format('Caso 12a (sin forzar): guarda_activada=%s bajas=%s, se esperaba true / 0.', v_row.guarda_activada, v_row.bajas));
  end if;

  -- forzado: la guarda sigue "activada" en el diagnóstico, pero esta vez sí aplica.
  v_log_id := saint.sync_products('c12_src_vacia'::regclass, true);
  select * into v_row from saint.sync_log where id = v_log_id;
  if v_row.guarda_activada is distinct from true or v_row.bajas is distinct from 3 or v_row.forzado is distinct from true then
    insert into _errores(msg) values (format('Caso 12b (forzado): guarda_activada=%s bajas=%s forzado=%s, se esperaba true / 3 / true.', v_row.guarda_activada, v_row.bajas, v_row.forzado));
  end if;

  select count(*) into v_activos from public.products where saint_code in ('C12-001', 'C12-002', 'C12-003') and is_active;
  if v_activos is distinct from 0 then
    insert into _errores(msg) values (format('Caso 12b (bajas aplicadas): %s siguen activos, se esperaban 0.', v_activos));
  end if;

  -- corrida normal siguiente, con los tres códigos de vuelta: reactiva sin activar la guarda.
  v_log_id := saint.sync_products('c12_src_completa'::regclass, false);
  select * into v_row from saint.sync_log where id = v_log_id;
  if v_row.guarda_activada is distinct from false or v_row.reactivados is distinct from 3 then
    insert into _errores(msg) values (format('Caso 12c (corrida normal siguiente): guarda_activada=%s reactivados=%s, se esperaba false / 3.', v_row.guarda_activada, v_row.reactivados));
  end if;
end $$;

-- ===========================================================================
delete from public.products where saint_code like 'C12-%';

-- CASO 13 · más de 50 filas presentes con activo=0 se desactivan todas, sin
-- activar la guarda (la guarda solo mira ausencias, nunca "activo<>1 presente").
-- ===========================================================================
insert into public.products (name, price, currency, stock_quantity, is_active, saint_code)
select 'Producto masivo activo0 ' || g, 1.00, 'VES', 1, true, 'C13-' || lpad(g::text, 4, '0')
from generate_series(1, 55) g;

create temporary table c13_src (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4), activo smallint);
insert into c13_src
select 'C13-' || lpad(g::text, 4, '0'), 'Producto masivo activo0 ' || g, 1.00, 1, 0
from generate_series(1, 55) g;

do $$
declare
  v_log_id uuid;
  v_row record;
  v_activos integer;
begin
  v_log_id := saint.sync_products('c13_src'::regclass);
  select * into v_row from saint.sync_log where id = v_log_id;

  if v_row.desactivados_por_saint is distinct from 55 then
    insert into _errores(msg) values (format('Caso 13 (desactivados_por_saint): %s, se esperaba 55.', v_row.desactivados_por_saint));
  end if;
  if v_row.guarda_activada is distinct from false then
    insert into _errores(msg) values (format('Caso 13 (guarda): guarda_activada = %s, se esperaba false (no es una ausencia).', v_row.guarda_activada));
  end if;
  if v_row.bajas is distinct from 0 then
    insert into _errores(msg) values (format('Caso 13 (bajas): %s, se esperaba 0 (esto no es una baja por ausencia).', v_row.bajas));
  end if;

  select count(*) into v_activos from public.products where saint_code like 'C13-%' and is_active;
  if v_activos is distinct from 0 then
    insert into _errores(msg) values (format('Caso 13 (todas desactivadas): %s siguen activas, se esperaban 0.', v_activos));
  end if;
end $$;

-- ===========================================================================
delete from public.products where saint_code like 'C13-%';

-- CASO 14 · fuente SIN columna activo funciona (se trata como si todo
-- estuviera activo=1 -- la forma de public.saprod antes de la ventana).
-- ===========================================================================
insert into public.products (id, name, price, currency, stock_quantity, is_active, saint_code) values
  ('e4e4e4e4-0000-0000-0000-000000000001', 'Producto sin columna activo', 3.00, 'VES', 1, false, 'C14-001');

update public.products set saint_removed_at = now() - interval '5 days' where id = 'e4e4e4e4-0000-0000-0000-000000000001';

create temporary table c14_src (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4));
insert into c14_src values ('C14-001', 'Producto sin columna activo', 3.00, 1);

do $$
declare
  v_log_id uuid;
  v_row record;
  v_active boolean;
  v_removed_at timestamptz;
begin
  v_log_id := saint.sync_products('c14_src'::regclass);
  select * into v_row from saint.sync_log where id = v_log_id;
  if v_row.error is not null then
    insert into _errores(msg) values (format('Caso 14 (sin columna activo, error): %s, se esperaba null.', v_row.error));
  end if;

  select is_active, saint_removed_at into v_active, v_removed_at from public.products where id = 'e4e4e4e4-0000-0000-0000-000000000001';
  if v_active is distinct from true or v_removed_at is not null then
    insert into _errores(msg) values (format('Caso 14 (sin columna activo, reactiva): is_active=%s saint_removed_at=%s, se esperaba true / null.', v_active, v_removed_at));
  end if;
end $$;

-- ===========================================================================
delete from public.products where saint_code like 'C14-%';

-- CASO 8 · el candado sobre products, como authenticated: UPDATE de stock/
-- precio/estado falla; INSERT y DELETE fallan; el de peso pasa, deja
-- updated_at igual y escribe el audit con changed_by y db_role.
-- ===========================================================================
insert into public.products (id, name, price, currency, stock_quantity, is_active, weight_kg, saint_code, updated_at) values
  ('8a8a8a8a-0000-0000-0000-000000000001', 'Producto candado', 50.00, 'VES', 10, true, 1.500, 'C8-001', '2026-01-01 00:00:00+00');

set local role authenticated;
set local "request.jwt.claim.sub" = '9a9a9a9a-0000-0000-0000-000000000001';

do $$
begin
  begin
    update public.products set stock_quantity = 999 where id = '8a8a8a8a-0000-0000-0000-000000000001';
    insert into _errores(msg) values ('Caso 8 (UPDATE stock como authenticated): se esperaba un error de permiso y no lo hubo.');
  exception when insufficient_privilege or others then
    null; -- se esperaba que fallara
  end;

  begin
    update public.products set price = 1.00 where id = '8a8a8a8a-0000-0000-0000-000000000001';
    insert into _errores(msg) values ('Caso 8 (UPDATE price como authenticated): se esperaba un error de permiso y no lo hubo.');
  exception when insufficient_privilege or others then
    null;
  end;

  begin
    update public.products set is_active = false where id = '8a8a8a8a-0000-0000-0000-000000000001';
    insert into _errores(msg) values ('Caso 8 (UPDATE is_active como authenticated): se esperaba un error de permiso y no lo hubo.');
  exception when insufficient_privilege or others then
    null;
  end;

  begin
    insert into public.products (name, price, currency, stock_quantity) values ('Intento authenticated', 1, 'VES', 1);
    insert into _errores(msg) values ('Caso 8 (INSERT como authenticated): se esperaba un error de permiso y no lo hubo.');
  exception when insufficient_privilege or others then
    null;
  end;

  begin
    delete from public.products where id = '8a8a8a8a-0000-0000-0000-000000000001';
    insert into _errores(msg) values ('Caso 8 (DELETE como authenticated): se esperaba un error de permiso y no lo hubo.');
  exception when insufficient_privilege or others then
    null;
  end;
end $$;

update public.products set weight_kg = 2.750 where id = '8a8a8a8a-0000-0000-0000-000000000001';

do $$
declare
  v_weight numeric;
  v_updated_at timestamptz;
  v_audit record;
begin
  select weight_kg, updated_at into v_weight, v_updated_at from public.products where id = '8a8a8a8a-0000-0000-0000-000000000001';
  if v_weight is distinct from 2.750 then
    insert into _errores(msg) values (format('Caso 8 (UPDATE weight_kg como authenticated): weight_kg = %s, se esperaba 2.750.', v_weight));
  end if;
  if v_updated_at is distinct from '2026-01-01 00:00:00+00'::timestamptz then
    insert into _errores(msg) values (format('Caso 8 (weight_kg no toca updated_at): updated_at = %s, se esperaba que quedara igual (2026-01-01).', v_updated_at));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- product_weight_audit no tiene ninguna política RLS ni grant a la API a
-- propósito (sección 4 de la migración): se verifica el contenido que dejó
-- el trigger como postgres, no como authenticated.
do $$
declare
  v_audit record;
begin
  select * into v_audit from public.product_weight_audit where product_id = '8a8a8a8a-0000-0000-0000-000000000001';
  if v_audit is null then
    insert into _errores(msg) values ('Caso 8 (audit): no se encontró ninguna fila en product_weight_audit.');
  else
    if v_audit.peso_anterior is distinct from 1.500 or v_audit.peso_nuevo is distinct from 2.750 then
      insert into _errores(msg) values (format('Caso 8 (audit pesos): peso_anterior=%s peso_nuevo=%s, se esperaba 1.500 / 2.750.', v_audit.peso_anterior, v_audit.peso_nuevo));
    end if;
    if v_audit.changed_by is distinct from '9a9a9a9a-0000-0000-0000-000000000001'::uuid then
      insert into _errores(msg) values (format('Caso 8 (audit changed_by): %s, se esperaba el agente de prueba.', v_audit.changed_by));
    end if;
    if v_audit.db_role is distinct from 'authenticated' then
      insert into _errores(msg) values (format('Caso 8 (audit db_role): %L, se esperaba "authenticated".', v_audit.db_role));
    end if;
  end if;
end $$;

-- ===========================================================================
-- CASO 9 · como service_role, el UPDATE de stock también falla (ningún rol
-- de la API puede escribir products salvo el peso, y ni siquiera eso: el
-- grant de weight_kg/updated_at es solo para authenticated).
-- ===========================================================================
set local role service_role;

do $$
begin
  begin
    update public.products set stock_quantity = 1234 where id = '8a8a8a8a-0000-0000-0000-000000000001';
    insert into _errores(msg) values ('Caso 9 (UPDATE stock como service_role): se esperaba un error de permiso y no lo hubo.');
  exception when insufficient_privilege or others then
    null;
  end;

  begin
    update public.products set weight_kg = 9.999 where id = '8a8a8a8a-0000-0000-0000-000000000001';
    insert into _errores(msg) values ('Caso 9 (UPDATE weight_kg como service_role): se esperaba un error de permiso y no lo hubo -- el grant de weight_kg es solo para authenticated.');
  exception when insufficient_privilege or others then
    null;
  end;
end $$;

reset role;

-- ===========================================================================
-- CASO 10 · has_function_privilege: ni anon, ni authenticated, ni
-- service_role pueden ejecutar saint.sync_products.
-- ===========================================================================
do $$
declare
  errores text := '';
begin
  if has_function_privilege('anon', 'saint.sync_products(regclass, boolean)', 'execute') then
    errores := errores || E'\n  - anon puede ejecutar saint.sync_products() y no debería.';
  end if;
  if has_function_privilege('authenticated', 'saint.sync_products(regclass, boolean)', 'execute') then
    errores := errores || E'\n  - authenticated puede ejecutar saint.sync_products() y no debería.';
  end if;
  if has_function_privilege('service_role', 'saint.sync_products(regclass, boolean)', 'execute') then
    errores := errores || E'\n  - service_role puede ejecutar saint.sync_products() y no debería -- nadie de la API la llama.';
  end if;

  if errores <> '' then
    insert into _errores(msg) values (format('Caso 10 (permisos de sync_products):%s', errores));
  end if;
end $$;

-- El caso 8 dejó 'C8-001' vinculado y activo (nunca se limpió porque no le
-- hacía falta a los casos 8-10, que no tocan la guarda) -- caso 15 sí la
-- ejercita de forma global, así que tiene que empezar con el terreno
-- limpio como todos los demás.
delete from public.products where saint_code like 'C8-%';

-- ===========================================================================
-- CASO 15 · la cobertura de la guarda NO cuenta productos ya removidos
-- (corrección del 25/9/2026: el denominador/numerador de la cobertura, y
-- "cuántos daría de baja", tienen que mirar SOLO saint_removed_at is null --
-- si se cuentan también los que YA están removidos, la cobertura solo puede
-- bajar y nunca se recupera: pasado el 10 % del catálogo removido la guarda
-- saltaría en TODAS las corridas siguientes, para siempre, aunque no haya
-- ninguna ausencia nueva que proteger).
--
-- 20 productos vinculados (GD-001..GD-020). Se fuerzan las bajas de 3
-- (15 %, más del 10 %) -- deja 17 sin remover. Después, una corrida NORMAL
-- (sin forzar) con esos 17 presentes en la fuente NO debe activar la
-- guarda (denominador = 17, no 20): antes de la corrección, contar los 3
-- ya removidos como "vinculados" bajaba la cobertura a 17/20 = 85 % y la
-- guarda saltaba igual, aunque no había NADA nuevo que proteger. Y una
-- ausencia chica y nueva sobre esos 17 (uno más que desaparece) SÍ tiene
-- que aplicarse sola, sin forzar -- antes de la corrección, el
-- denominador contaminado (20 en vez de 17) hacía caer la cobertura a
-- 16/20 = 80 % y esa ausencia nueva quedaba bloqueada para siempre.
-- ===========================================================================
insert into public.products (name, price, currency, stock_quantity, is_active, saint_code)
select 'Producto guarda denominador ' || g, 1.00, 'VES', 1, true, 'GD-' || lpad(g::text, 3, '0')
from generate_series(1, 20) g;

create temporary table gd_src_17 (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4));
insert into gd_src_17
select 'GD-' || lpad(g::text, 3, '0'), 'Producto guarda denominador ' || g, 1.00, 1
from generate_series(1, 17) g;

create temporary table gd_src_16 (codprod varchar(15), descrip varchar(40), precio3 numeric(28, 4), existen numeric(28, 4));
insert into gd_src_16
select 'GD-' || lpad(g::text, 3, '0'), 'Producto guarda denominador ' || g, 1.00, 1
from generate_series(1, 16) g;

do $$
declare
  v_log_id uuid;
  v_row record;
  v_removidos integer;
begin
  -- forzar la baja de GD-018/019/020 (15 % de 20) -- deja 17 sin remover.
  v_log_id := saint.sync_products('gd_src_17'::regclass, true);
  select * into v_row from saint.sync_log where id = v_log_id;
  if v_row.bajas is distinct from 3 then
    insert into _errores(msg) values (format('Caso 15a (forzar 15%% de bajas): bajas = %s, se esperaba 3.', v_row.bajas));
  end if;

  select count(*) into v_removidos from public.products where saint_code like 'GD-%' and saint_removed_at is not null;
  if v_removidos is distinct from 3 then
    insert into _errores(msg) values (format('Caso 15a (removidos): %s, se esperaban 3.', v_removidos));
  end if;

  -- corrida NORMAL (sin forzar) con los 17 restantes presentes: la guarda
  -- NO debe activarse -- los 3 ya removidos no cuentan ni en el numerador
  -- ni en el denominador de la cobertura.
  v_log_id := saint.sync_products('gd_src_17'::regclass, false);
  select * into v_row from saint.sync_log where id = v_log_id;
  if v_row.guarda_activada is distinct from false then
    insert into _errores(msg) values (format('Caso 15b (corrida normal, sin ausencias nuevas): guarda_activada = %s, se esperaba false -- los 3 ya removidos no deberían contar.', v_row.guarda_activada));
  end if;
  if v_row.bajas is distinct from 0 then
    insert into _errores(msg) values (format('Caso 15b (nada nuevo que dar de baja): bajas = %s, se esperaba 0.', v_row.bajas));
  end if;

  -- ausencia NUEVA y chica (GD-017 deja de estar en la fuente) sobre una
  -- corrida NORMAL: tiene que aplicarse sola, sin forzar.
  v_log_id := saint.sync_products('gd_src_16'::regclass, false);
  select * into v_row from saint.sync_log where id = v_log_id;
  if v_row.guarda_activada is distinct from false then
    insert into _errores(msg) values (format('Caso 15c (ausencia nueva y chica): guarda_activada = %s, se esperaba false (1 de 17 = ~94%% de cobertura, por debajo del umbral de 50 bajas).', v_row.guarda_activada));
  end if;
  if v_row.bajas is distinct from 1 then
    insert into _errores(msg) values (format('Caso 15c (ausencia nueva y chica SÍ se aplica): bajas = %s, se esperaba 1 (GD-017).', v_row.bajas));
  end if;

  select count(*) into v_removidos from public.products where saint_code = 'GD-017' and saint_removed_at is not null;
  if v_removidos is distinct from 1 then
    insert into _errores(msg) values ('Caso 15c (GD-017 removido): no quedó con saint_removed_at sellado.');
  end if;
end $$;

delete from public.products where saint_code like 'GD-%';

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
    raise exception E'saint_sync_products.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'saint_sync_products.sql: todas las aserciones pasaron.'
