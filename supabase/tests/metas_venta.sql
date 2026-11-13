-- ============================================================================
-- Metas de venta de los paneles (M2, plan "Paneles", 13/11/2026), migración
-- 20261113020000_metas_venta.sql.
--
-- Qué prueba:
--   0. La semilla de la migración existe (online 2600, tienda 1800 desde
--      2026-11-01).
--   1. Un supervisor (jose) hace upsert de la meta de hoy y la lee de vuelta.
--   2. Un asesor (maria) NO ve ninguna fila, su insert lo rechaza la RLS con
--      42501 y su update afecta 0 filas SIN error (PostgREST lo devolvería
--      como 200 vacío; ver `config-write.ts`).
--   3. `anon` no tiene ningún privilegio sobre la tabla; nadie tiene delete.
--   4. "Meta vigente de un día": con dos filas de fechas distintas, la
--      consulta `vigente_desde <= día order by vigente_desde desc limit 1`
--      devuelve la correcta para un día antes, en el borde, entre las dos y
--      después de la segunda.
--   5. Los CHECK: canal desconocido y monto <= 0 se rechazan.
--
-- Patrón: transacción con rollback, tabla temporal `_errores`, un solo
-- `raise exception` al final (mismo estilo que resumen_busquedas.sql).
-- ============================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Caso 0 · la semilla de la migración.
-- ---------------------------------------------------------------------------
do $$
begin
  if (select monto_usd from public.metas_venta where canal = 'online' and vigente_desde = date '2026-11-01') is distinct from 2600 then
    insert into _errores(msg) values ('Caso 0: falta la semilla online 2026-11-01 = 2600.');
  end if;
  if (select monto_usd from public.metas_venta where canal = 'tienda' and vigente_desde = date '2026-11-01') is distinct from 1800 then
    insert into _errores(msg) values ('Caso 0: falta la semilla tienda 2026-11-01 = 1800.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 1 · supervisor: upsert de «hoy» y lectura.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

do $$
declare
  leida numeric;
begin
  insert into public.metas_venta (canal, vigente_desde, monto_usd)
  values ('online', current_date, 3100)
  on conflict (canal, vigente_desde) do update set monto_usd = excluded.monto_usd;

  insert into public.metas_venta (canal, vigente_desde, monto_usd)
  values ('online', current_date, 3200)
  on conflict (canal, vigente_desde) do update set monto_usd = excluded.monto_usd;

  select monto_usd into leida from public.metas_venta
    where canal = 'online' and vigente_desde = current_date;
  if leida is distinct from 3200 then
    insert into _errores(msg) values (format('Caso 1: el supervisor leyó %s, se esperaba 3200 (upsert).', leida));
  end if;
  if (select created_by from public.metas_venta where canal = 'online' and vigente_desde = current_date)
       is distinct from '11111111-1111-1111-1111-111111111111'::uuid then
    insert into _errores(msg) values ('Caso 1: created_by no quedó con auth.uid() del supervisor.');
  end if;
exception when others then
  insert into _errores(msg) values (format('Caso 1: el supervisor no pudo escribir o leer: %s', sqlerrm));
end $$;

reset role;
reset "request.jwt.claim.sub";

-- ---------------------------------------------------------------------------
-- Caso 2 · asesor: no ve filas, el insert da 42501 y el update afecta 0 filas.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';

do $$
declare
  n int;
begin
  select count(*) into n from public.metas_venta;
  if n <> 0 then
    insert into _errores(msg) values (format('Caso 2a: el asesor ve %s filas de metas_venta, se esperaba 0.', n));
  end if;

  begin
    insert into public.metas_venta (canal, vigente_desde, monto_usd) values ('tienda', current_date, 1);
    insert into _errores(msg) values ('Caso 2b: el asesor pudo insertar una meta.');
  exception when insufficient_privilege then
    null; -- 42501: la RLS lo rechazó, como debe.
  end;

  update public.metas_venta set monto_usd = 1 where canal = 'online';
  get diagnostics n = row_count;
  if n <> 0 then
    insert into _errores(msg) values (format('Caso 2c: el update del asesor afectó %s filas, se esperaba 0.', n));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- Lo del asesor no tocó nada (leído como dueño de la sesión).
do $$
begin
  if (select monto_usd from public.metas_venta where canal = 'online' and vigente_desde = current_date) is distinct from 3200 then
    insert into _errores(msg) values ('Caso 2d: el intento del asesor cambió la meta de hoy.');
  end if;
  if exists (select 1 from public.metas_venta where canal = 'tienda' and vigente_desde = current_date) then
    insert into _errores(msg) values ('Caso 2d: el asesor logró insertar una meta de tienda.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 3 · anon no tiene privilegios de tabla; nadie borra.
-- ---------------------------------------------------------------------------
do $$
declare
  p text;
begin
  foreach p in array array['select', 'insert', 'update', 'delete'] loop
    if has_table_privilege('anon', 'public.metas_venta', p) then
      insert into _errores(msg) values (format('Caso 3: anon tiene %s sobre metas_venta.', p));
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.metas_venta', 'delete') then
    insert into _errores(msg) values ('Caso 3: authenticated tiene delete sobre metas_venta (no debía).');
  end if;
  if not (has_table_privilege('authenticated', 'public.metas_venta', 'select')
          and has_table_privilege('authenticated', 'public.metas_venta', 'insert')
          and has_table_privilege('authenticated', 'public.metas_venta', 'update')) then
    insert into _errores(msg) values ('Caso 3: a authenticated le falta select, insert o update.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 4 · meta vigente de un día, con dos filas de fechas distintas.
-- ---------------------------------------------------------------------------
insert into public.metas_venta (canal, vigente_desde, monto_usd) values
  ('tienda', date '2030-01-01', 1000),
  ('tienda', date '2030-06-01', 1500);

do $$
declare
  obtenido numeric;
  caso record;
begin
  for caso in
    select * from (values
      (date '2030-01-01', 1000::numeric),
      (date '2030-05-31', 1000::numeric),
      (date '2030-06-01', 1500::numeric),
      (date '2031-01-01', 1500::numeric)
    ) v(d, m)
  loop
    select monto_usd into obtenido from public.metas_venta
      where canal = 'tienda' and vigente_desde <= caso.d
      order by vigente_desde desc limit 1;
    if obtenido is distinct from caso.m then
      insert into _errores(msg) values (format('Caso 4: para %s la meta vigente dio %s, se esperaba %s.', caso.d, obtenido, caso.m));
    end if;
  end loop;

  -- Antes de la primera fila de prueba rige la semilla de 2026 (1800).
  select monto_usd into obtenido from public.metas_venta
    where canal = 'tienda' and vigente_desde <= date '2029-12-31'
    order by vigente_desde desc limit 1;
  if obtenido is distinct from 1800 then
    insert into _errores(msg) values (format('Caso 4b: antes de 2030 debía regir la semilla 1800, dio %s.', obtenido));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Caso 5 · los CHECK.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.metas_venta (canal, vigente_desde, monto_usd) values ('mayorista', date '2031-01-01', 10);
    insert into _errores(msg) values ('Caso 5a: se aceptó un canal desconocido.');
  exception when check_violation then null;
  end;
  begin
    insert into public.metas_venta (canal, vigente_desde, monto_usd) values ('online', date '2031-01-01', 0);
    insert into _errores(msg) values ('Caso 5b: se aceptó una meta de monto 0.');
  exception when check_violation then null;
  end;
  begin
    insert into public.metas_venta (canal, vigente_desde, monto_usd) values ('online', date '2031-01-01', -5);
    insert into _errores(msg) values ('Caso 5c: se aceptó una meta negativa.');
  exception when check_violation then null;
  end;
end $$;

do $$
declare
  detalle text;
begin
  select string_agg(msg, E'\n') into detalle from _errores;
  if detalle is not null then
    raise exception E'metas_venta.sql: fallaron casos:\n%', detalle;
  end if;
  raise notice 'metas_venta.sql: todos los casos en verde.';
end $$;

rollback;
