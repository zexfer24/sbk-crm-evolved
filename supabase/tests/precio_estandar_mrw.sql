-- ===========================================================================
-- Precio estándar = precio + tarifa de envío MRW por peso (12/10/2026,
-- migración 20261012010000).
--
-- Fija: (1) los bordes de `tarifa_mrw_usd` (rango [desde, hasta): 1.000 ya es
-- el tramo de 1-2 kg, 43.000 ya es el de 43-45, 80.000 ya no tiene tarifa);
-- (2) que la tabla `shipping_rates` cubra de 0.001 a 80 kg sin huecos, 34
-- rangos; (3) que la exclusión rechace solapes; (4) la RLS: un asesor lee pero
-- no escribe (un UPDATE bloqueado afecta 0 filas SIN error -- por eso se mide
-- con GET DIAGNOSTICS, no con el error), un supervisor sí; (5) el campo
-- calculado `tarifa_envio_usd` de `products` visto como `authenticated`.
--
-- Corre como `authenticated` con claims de un agente real -- como `postgres`
-- se salta la RLS y no mediría nada (mismo criterio que config_solo_supervisor.sql).
-- Formato: transacción con rollback, tabla temporal `_errores`, un solo
-- `raise exception` al final.
-- ===========================================================================

begin;

create temporary table _errores (msg text) on commit drop;
grant insert on _errores to authenticated;

-- Dos agentes: A (asesor, rol 'agent' por default) y S (supervisor).
insert into auth.users (id, email, raw_user_meta_data) values
  ('d8d8d8d8-0000-0000-0000-000000000001', 'agente-a-mrw@sbk.test', jsonb_build_object('display_name', 'Agente A (mrw)')),
  ('d8d8d8d8-0000-0000-0000-000000000002', 'agente-s-mrw@sbk.test', jsonb_build_object('display_name', 'Agente S (mrw, supervisor)'));

update public.agents set role = 'supervisor' where id = 'd8d8d8d8-0000-0000-0000-000000000002';

-- `products` es de solo lectura para la app (enforce_products_read_only):
-- los productos de prueba se insertan como postgres, antes de cambiar de rol.
insert into public.products (id, name, price, currency, weight_kg) values
  ('d8d8d8d8-1000-0000-0000-000000000001', 'Producto de prueba MRW 1 kg', 100, 'VES', 1.000),
  ('d8d8d8d8-1000-0000-0000-000000000002', 'Producto de prueba MRW sin peso', 100, 'VES', null);

-- ---------------------------------------------------------------------------
-- 1. Bordes de tarifa_mrw_usd (como postgres)
-- ---------------------------------------------------------------------------
do $$
declare
  caso record;
  obtenida numeric;
begin
  for caso in
    select * from (values
      (0.001::numeric, 0.70::numeric),
      (0.499, 0.70),
      (0.500, 0.70),
      (0.999, 0.70),
      (1.000, 1.40),
      (7.999, 4.90),
      (8.000, 5.60),
      (42.999, 14.70),
      (43.000, 13.91),
      (79.999, 21.20),
      (null, null),
      (0, null),
      (-1, null),
      (80.000, null)
    ) as t(peso, esperada)
  loop
    obtenida := public.tarifa_mrw_usd(caso.peso);
    if obtenida is distinct from caso.esperada then
      insert into _errores(msg) values (format('tarifa_mrw_usd(%s) = %s, se esperaba %s.', caso.peso, obtenida, caso.esperada));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Cobertura: 34 rangos, de 0.001 a 80, sin huecos
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
  primero numeric;
  ultimo numeric;
  huecos integer;
begin
  select count(*), min(desde_kg), max(hasta_kg) into n, primero, ultimo
    from public.shipping_rates where carrier = 'mrw';
  if n <> 34 then insert into _errores(msg) values (format('shipping_rates mrw tiene %s rangos, se esperaban 34.', n)); end if;
  if primero is distinct from 0.001 then insert into _errores(msg) values (format('El primer rango empieza en %s, se esperaba 0.001.', primero)); end if;
  if ultimo is distinct from 80 then insert into _errores(msg) values (format('El último rango termina en %s, se esperaba 80.', ultimo)); end if;

  select count(*) into huecos from (
    select hasta_kg, lead(desde_kg) over (order by desde_kg) as siguiente
      from public.shipping_rates where carrier = 'mrw'
  ) r where r.siguiente is not null and r.siguiente <> r.hasta_kg;
  if huecos <> 0 then insert into _errores(msg) values (format('Hay %s hueco(s)/solape(s) entre rangos consecutivos de mrw.', huecos)); end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Un rango solapado se rechaza (exclusión)
-- ---------------------------------------------------------------------------
do $$
declare
  se_guardo boolean := false;
begin
  begin
    insert into public.shipping_rates (carrier, desde_kg, hasta_kg, tarifa_usd) values ('mrw', 0.2, 0.7, 1);
    se_guardo := true;
  exception when exclusion_violation then
    null;
  end;
  if se_guardo then
    insert into _errores(msg) values ('Se aceptó un rango solapado (mrw, 0.2-0.7): la exclusión no está funcionando.');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. RLS. Como A (asesor): lee, pero no escribe.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'd8d8d8d8-0000-0000-0000-000000000001';

do $$
declare
  n integer;
  se_guardo boolean;
begin
  select count(*) into n from public.shipping_rates;
  if n <> 34 then insert into _errores(msg) values (format('A (asesor) ve %s filas de shipping_rates, se esperaban 34.', n)); end if;

  -- UPDATE bloqueado por RLS: 0 filas, sin error.
  begin
    update public.shipping_rates set tarifa_usd = 99 where carrier = 'mrw' and desde_kg = 1;
    get diagnostics n = row_count;
    if n is distinct from 0 then
      insert into _errores(msg) values (format('A (asesor) / update: afectó %s fila(s), se esperaban 0.', n));
    end if;
  exception when others then
    insert into _errores(msg) values (format('A (asesor) / update: lanzó error (%s) en vez de afectar 0 filas.', sqlerrm));
  end;

  -- DELETE bloqueado: 0 filas.
  begin
    delete from public.shipping_rates where carrier = 'mrw' and desde_kg = 1;
    get diagnostics n = row_count;
    if n is distinct from 0 then
      insert into _errores(msg) values (format('A (asesor) / delete: afectó %s fila(s), se esperaban 0.', n));
    end if;
  exception when others then
    insert into _errores(msg) values (format('A (asesor) / delete: lanzó error (%s) en vez de afectar 0 filas.', sqlerrm));
  end;

  -- INSERT: la política with check lanza 42501.
  se_guardo := false;
  begin
    insert into public.shipping_rates (carrier, desde_kg, hasta_kg, tarifa_usd) values ('otro', 0.001, 5, 1);
    se_guardo := true;
  exception when insufficient_privilege then
    null;
  end;
  if se_guardo then
    insert into _errores(msg) values ('A (asesor) / insert: se aceptó -- la política de INSERT no restringe a supervisor/admin.');
  end if;
end $$;

-- 5. Campo calculado visto por el asesor.
do $$
declare
  t numeric;
begin
  select public.tarifa_envio_usd(p) into t from public.products p where p.id = 'd8d8d8d8-1000-0000-0000-000000000001';
  if t is distinct from 1.40 then
    insert into _errores(msg) values (format('tarifa_envio_usd(producto de 1.000 kg) = %s, se esperaba 1.40.', t));
  end if;

  select public.tarifa_envio_usd(p) into t from public.products p where p.id = 'd8d8d8d8-1000-0000-0000-000000000002';
  if t is not null then
    insert into _errores(msg) values (format('tarifa_envio_usd(producto sin peso) = %s, se esperaba null.', t));
  end if;
end $$;

reset role;
reset "request.jwt.claim.sub";

-- Nada de lo que intentó A cambió (verificado como postgres, sin RLS).
do $$
declare
  n integer;
begin
  select count(*) into n from public.shipping_rates where carrier = 'mrw' and desde_kg = 1 and tarifa_usd = 1.40;
  if n <> 1 then insert into _errores(msg) values ('Tras A: la tarifa de 1-2 kg cambió o desapareció.'); end if;
  select count(*) into n from public.shipping_rates where carrier = 'otro';
  if n <> 0 then insert into _errores(msg) values ('Tras A: existe una tarifa que A intentó crear.'); end if;
end $$;

-- ---------------------------------------------------------------------------
-- Como S (supervisor): sí actualiza.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = 'd8d8d8d8-0000-0000-0000-000000000002';

do $$
declare
  n integer;
  t numeric;
begin
  update public.shipping_rates set tarifa_usd = 1.50 where carrier = 'mrw' and desde_kg = 1;
  get diagnostics n = row_count;
  if n is distinct from 1 then
    insert into _errores(msg) values (format('S (supervisor) / update: afectó %s fila(s), se esperaba 1.', n));
  end if;

  select public.tarifa_mrw_usd(1.5) into t;
  if t is distinct from 1.50 then
    insert into _errores(msg) values (format('Tras el update de S, tarifa_mrw_usd(1.5) = %s, se esperaba 1.50.', t));
  end if;
end $$;

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
    raise exception E'precio_estandar_mrw.sql roto (% error(es)):\n  - %', n, detalle;
  end if;
end $$;

rollback;

\echo 'precio_estandar_mrw.sql: todas las aserciones pasaron.'
